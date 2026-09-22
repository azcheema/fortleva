import { record } from "@/audit/record";
import { isAuthorized, type MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { ranksBetween } from "@/lib/rank";
import { writeActivity } from "./activity";
import { loadItemInScope } from "./rows";

/**
 * Workflow states (DATA_MODEL §6.14): tenant-named states inside fixed
 * categories. The default set is seeded LAZILY per project (first work
 * read/write touches it) — core never imports the work module, so
 * project creation cannot seed it (ARC-16 import direction), and lazy
 * seeding also self-heals projects that predate 2W. Seeded states carry
 * NO name (2026-09-01): they render their `seedKey` through i18n in the
 * VIEWER's language, and the first rename makes a state plain tenant
 * text forever (DATA_MODEL §6.14). Tenant.defaultLocale is no longer
 * read here — there is no seed-time language left to choose.
 */

export type WorkCtx = { readonly tenantId: string; readonly actor: MemberActor };

/** The `withTenant` principal a work service opens its transaction under — ONE builder for the module (the time module's `ctx.ts` rule). */
export const principalOf = (ctx: WorkCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

// "In review" is a tenant-named state in the IN_PROGRESS category (the
// category set is pinned closed; the portal reads categories only —
// exactly ADO's mapping of In Review). Done carries the approval gate:
// entering it needs work_item:approve on top of work_item:edit (2W-R).
//
// Seeded states are created with **no name at all** (2026-09-01): a NULL
// name means "still wearing its default", so the UI renders `seedKey`
// through i18n in the VIEWER's language — an English account no longer
// reads a Swedish tenant's board in Swedish. The first rename writes a
// name and the state becomes plain tenant text forever, which is why
// this file no longer needs Tenant.defaultLocale: there is no seed-time
// language left to choose. Existing projects are untouched; their names
// are already non-NULL and therefore already tenant text.
const DEFAULT_STATE_SHAPE = [
  { seedKey: "BACKLOG", category: "BACKLOG", isDefault: false, isHidden: false, requiresApproval: false },
  { seedKey: "TODO", category: "TODO", isDefault: true, isHidden: false, requiresApproval: false },
  { seedKey: "IN_PROGRESS", category: "IN_PROGRESS", isDefault: false, isHidden: false, requiresApproval: false },
  { seedKey: "IN_REVIEW", category: "IN_PROGRESS", isDefault: false, isHidden: false, requiresApproval: false },
  { seedKey: "DONE", category: "DONE", isDefault: false, isHidden: false, requiresApproval: true },
  { seedKey: "CANCELLED", category: "CANCELLED", isDefault: false, isHidden: false, requiresApproval: false },
  { seedKey: "TRIAGE", category: "TRIAGE", isDefault: false, isHidden: true, requiresApproval: false }, // shown only when it has items
] as const;

/** Idempotent + race-safe: `skipDuplicates` dedupes on the (tenant,
 * project, seedKey) unique. It relied on the NAME unique until
 * 2026-09-01, which stopped working the day seeded names became NULL —
 * NULLs do not collide. The deterministic rank unique is the second net. */
export async function ensureProjectStates(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
): Promise<void> {
  const existing = await tx.workflowState.count({ where: { tenantId, projectId } });
  if (existing > 0) return;
  const ranks = ranksBetween(null, null, DEFAULT_STATE_SHAPE.length);
  await tx.workflowState.createMany({
    // `skipDuplicates` deduped on the (tenant, project, NAME) unique
    // until names became NULL — and NULLs do not collide. The
    // (tenant, project, SEED_KEY) unique added with this column is what
    // keeps two concurrent lazy seeds from writing fourteen states.
    data: DEFAULT_STATE_SHAPE.map((s, i) => ({
      tenantId,
      projectId,
      name: null,
      seedKey: s.seedKey,
      category: s.category,
      rank: ranks[i]!,
      isDefault: s.isDefault,
      isHidden: s.isHidden,
      requiresApproval: s.requiresApproval,
    })),
    skipDuplicates: true,
  });
}

/**
 * THE SIX FIELDS `transitionState` ACTUALLY READS OFF A STATE, as a
 * `Pick` rather than the whole row.
 *
 * It was the whole row until slice 6b. Narrowing it costs nothing —
 * `changeState`'s select-less `findFirst` still satisfies a `Pick`
 * structurally — and buys one thing: `triage.ts` can resolve its target
 * state with an explicit `select` and still pass it here. That file is
 * now in `portal-projections.test.ts`'s STRUCTURAL tier, which forbids
 * a select-less read, so without this the tripwire and the state
 * machine's signature would have been in direct conflict.
 */
export type StateRow = Pick<
  NonNullable<Awaited<ReturnType<TenantDb["workflowState"]["findFirst"]>>>,
  "id" | "projectId" | "category" | "requiresApproval" | "name" | "seedKey"
>;
/**
 * A whole work_item row MINUS the description pair. Those two columns
 * are a ProseMirror document and its extracted text — up to 512 KB and
 * 100 KB once the description editor ships — and nothing on the state
 * machine's path, or the board drag's, reads either. They were always
 * NULL before, so a select-less read cost nothing; now it would move the
 * whole document to re-rank a card.
 */
type ItemRow = Omit<
  NonNullable<Awaited<ReturnType<TenantDb["workItem"]["findFirst"]>>>,
  "description" | "descriptionText"
>;

/**
 * What a state change WAS, once it happened — the canonical row every
 * caller needs and nobody could have (UI.md §7.2: a mutation returns
 * the row, so an optimistic slice is REPLACED rather than merged).
 *
 * The name pair is RAW: this module runs in dbtests and in server
 * actions and has no locale, so resolving one here would be a lie in
 * the viewer's language.
 */
export type StateChange = {
  itemId: string;
  stateId: string;
  stateCategory: StateRow["category"];
  startedAt: Date | null;
  completedAt: Date | null;
  stateName: string | null;
  stateSeedKey: StateRow["seedKey"];
  /** False when the item was ALREADY there: no row, no activity row and
   *  no audit event were written, and the caller must not claim a save. */
  changed: boolean;
};


/**
 * WHAT A TRIAGE VERB HANDS THE STATE MACHINE (slice 6b, triage.ts).
 *
 * The four triage columns move together and only this way. Passing it
 * does two things no other caller may do: it WAIVES the refusal below
 * on leaving TRIAGE for a CANCELLED state, and it writes the triage
 * columns in the SAME `UPDATE` as the state — so a declined request
 * never exists, even for the width of a statement, in a version where
 * the client can no longer see it and nobody has said why.
 *
 * It is an argument rather than a second function because §3.1 pins
 * ONE state machine for every entry point ("drag, inline, palette,
 * bulk, triage, import"); a triage that wrote its own `UPDATE` would be
 * the second, and the activity row and the audit event are exactly what
 * the second one would forget.
 */
export type TriageWrite = {
  /** `null` is ACCEPT: the row leaves triage with nothing left to say. */
  readonly triageStatus: ItemRow["triageStatus"];
  readonly triageReason: string | null;
  readonly snoozedUntil: Date | null;
  readonly duplicateOfId: string | null;
};

/**
 * The state machine (§6.14), as ONE transaction step so every entry
 * point — inline select, board drop, "Move to…", palette, bulk, triage,
 * import — runs the same code: syncs stateCategory (belt: the trigger
 * does too), stamps startedAt on the first IN_PROGRESS, completedAt on
 * DONE, clears both on regression, writes the portal-safe activity row
 * and dual-writes the audit event. The caller has already authorised
 * and scoped the item; `state` must belong to the item's project.
 * Everything it reports and records — `changed`, the stamps, the history
 * row's oldValue and visibility, the audit's `from` — is diffed against
 * `item`, so it describes the row version the UPDATE replaces only when
 * the caller read `item` under that row's lock (changeState does).
 * Parent rollup automation (autoStartParent/autoCompleteParent) is a
 * later slice.
 *
 * SINCE SLICE 6b IT ALSO OWNS THE TRIAGE COLUMNS, and that is a
 * correctness fix and not only a feature. Leaving a TRIAGE state was
 * already an ordinary move — a member drags a request from the lane
 * into "To do" and it is accepted — but nothing cleared
 * `triage_status`, so the row sat in To do still marked `PENDING`,
 * where the lane's own query would go on finding it forever. It is
 * cleared HERE rather than in the triage service because the drag, the
 * picker, the palette and the bulk bar all reach this function and none
 * of them reaches that one — and the same argument is why the REFUSAL
 * below lives here too.
 */
export async function transitionState(
  tx: TenantDb,
  ctx: WorkCtx,
  item: ItemRow,
  state: StateRow,
  triage?: TriageWrite,
): Promise<StateChange> {
  if (state.projectId !== item.projectId) deny("NOT_FOUND");
  // Already there: no row, no activity, no audit — and the caller is
  // TOLD so, rather than being handed a "saved" it can only report as a
  // lie. Built from the item, because nothing was written.
  if (state.id === item.stateId) {
    return {
      itemId: item.id,
      stateId: item.stateId,
      stateCategory: item.stateCategory,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      stateName: state.name,
      stateSeedKey: state.seedKey,
      changed: false,
    };
  }
  // Entering TRIAGE means triageStatus too (the §6.14 CHECK
  // `work_item_triage_has_status` enforces it), which is the `work_item:triage`
  // verb's job — a plain state change into it would reach the database and
  // come back as a raw constraint error. Leaving triage is an ordinary move.
  if (state.category === "TRIAGE") fail("INVALID_INPUT", "triage entry is not a state change");
  // ...AND **ENDING A REQUEST** IS THE TRIAGE VERB TOO, unless the
  // caller IS that verb. This is the founder's 2026-09-22 decision held
  // at the one seam every writer passes through.
  //
  // `portal.ts` shows a cancelled REQUEST to the client as DECLINED
  // **with the agency's reason**, so a plain move into Cancelled — a
  // board drag, the state picker, a bulk change — would produce the one
  // row the portal cannot render honestly: a decline with nothing to
  // show for it. Refused here rather than papered over in the
  // projection, because the member who dragged it is the only person
  // who knows why, and a moment later nobody does.
  //
  // **IT KEYS ON `kind`, NOT ON THE CATEGORY THE ROW IS LEAVING**, and
  // the first cut of this slice got that wrong in a way two independent
  // reviews both found. Keyed on `item.stateCategory === "TRIAGE"` it
  // guarded only the one-step route, and the ordinary two-step one —
  // accept the request into "To do", drop it weeks later — sailed past
  // and published a bare "Declined" with nothing under it. Worse, a
  // member holding only `work_item:edit` could reach that end state,
  // which made `work_item:triage` a speed bump rather than a gate for
  // the one outcome it exists to govern. A request is a thing a client
  // ASKED FOR for as long as it exists, so ending one always owes them
  // an answer, whenever it happens.
  //
  // Every OTHER move stays ordinary, which is the point: dragging a
  // request into "To do" IS accepting it, and asking a member to use a
  // menu for that would be friction with no safety behind it.
  if (item.kind === "REQUEST" && state.category === "CANCELLED" && !triage) {
    fail("INVALID_INPUT", "ending a request is work_item:triage");
  }
  // The 2W-R review gate: entering a requiresApproval state (the seeded
  // Done) needs work_item:approve ON TOP of the work_item:edit every
  // caller has already passed. Leaving a gated state (reopening) is
  // free — the gate can never trap an item. isAuthorized, not a second
  // requireAccess: the module gates ran with work_item:edit in this
  // same transaction; only the permission differs.
  if (state.requiresApproval && !(await isAuthorized(tx, ctx.actor, "work_item:approve"))) {
    fail("APPROVAL_REQUIRED", "entering this state requires work_item:approve");
  }

  const to = state.category;
  const startedAt =
    to === "IN_PROGRESS" && !item.startedAt
      ? new Date()
      : to === "BACKLOG" || to === "TODO" // TRIAGE cannot reach here (refused above)
        ? null
        : item.startedAt;
  const completedAt = to === "DONE" ? (item.completedAt ?? new Date()) : null;

  // THE TRIAGE COLUMNS, IN THIS SAME STATEMENT. Three cases, and the
  // middle one is the one that used to be missing:
  //
  //   · a triage verb passed its own values            → write them
  //   · the row is LEAVING a triage OR cancelled state → clear all four
  //   · anything else                                  → touch nothing
  //
  // **BOTH HALVES OF THE MIDDLE CASE ARE LOAD-BEARING.** Leaving TRIAGE
  // is an accept by any door, and without the clear the row sat in "To
  // do" still marked `PENDING` for ever. Leaving CANCELLED is a REOPEN,
  // and without the clear a request that was declined and then thought
  // better of kept its `DECLINED` status and the old reason on a live
  // row — so a later ordinary cancel republished those words as the
  // agency's answer to a decision nobody had made. Both reviews found
  // that second one; it is why this reads "or cancelled" rather than
  // just "triage".
  //
  // The clear is `undefined`-free on purpose: an explicit `null` on each
  // of the four is what makes "a live row carries no triage outcome"
  // true by construction rather than by every caller's memory.
  // `work_item_triage_reason_iff_outcome` (20260922120000) refuses the
  // combination this could otherwise mint — a reason with no outcome.
  const leavingTriageOrCancelled =
    item.stateCategory === "TRIAGE" || item.stateCategory === "CANCELLED";
  // THE CLIENT'S CLAIM, CLEARED WHEN THE AGENCY HAS ANSWERED IT — and
  // only then (slice 6c). A contact assigned a task can say "I've done
  // my part" (`contactCompletedAt`, `portal-writes.ts`); it moves
  // nothing, because `DONE` means work the agency has accepted, for
  // everyone (founder decision, 2026-09-22).
  //
  // **IT SURVIVES AN ORDINARY LIVE MOVE, AND THAT IS THE POINT.**
  // Clearing on every transition looked tidier and was wrong: a member
  // dragging the task from "To do" to "In progress" for their own
  // reasons would have silently deleted the client's statement, which
  // is the same silent-vanish class slice 6b exists to end. Reaching
  // DONE or CANCELLED is different — the agency has now answered the
  // claim one way or the other, and a stale "the client says this is
  // done" on finished or dropped work says nothing.
  //
  // A claim can also be retracted by the client, and is cleared by
  // every writer that changes the assignment it answers (`items.ts`);
  // `work_item_contact_completed_has_assignee` refuses the row that
  // would be left behind.
  //
  // ITS OWN SPREAD, never folded into the triage object below: the two
  // clears answer different questions and the triage one has a branch
  // (`triage ? … : leavingTriageOrCancelled ? … : {}`) that would have
  // swallowed this in two of its three arms.
  const claimColumn: Partial<Pick<ItemRow, "contactCompletedAt">> =
    item.contactCompletedAt !== null && (to === "DONE" || to === "CANCELLED")
      ? { contactCompletedAt: null }
      : {};
  const triageColumns: Partial<
    Pick<ItemRow, "triageStatus" | "triageReason" | "snoozedUntil" | "duplicateOfId">
  > = triage
    ? {
        triageStatus: triage.triageStatus,
        triageReason: triage.triageReason,
        snoozedUntil: triage.snoozedUntil,
        duplicateOfId: triage.duplicateOfId,
      }
    : leavingTriageOrCancelled
      ? { triageStatus: null, triageReason: null, snoozedUntil: null, duplicateOfId: null }
      : {};

  // `select` for the same reason `ItemRow` above carries its omit: a
  // select-less `update` returns the WHOLE row, the 512 KB ProseMirror
  // description included, and this path runs on every board drop, every
  // bulk change, every import and every create-into-a-column. The
  // result was previously discarded, so narrowing it is free — and
  // `stateCategory` comes back AFTER the BEFORE trigger has derived it,
  // which is the value the caller actually wants.
  const row = await tx.workItem.update({
    where: { id: item.id },
    data: { stateId: state.id, stateCategory: to, startedAt, completedAt, ...triageColumns, ...claimColumn },
    select: {
      id: true,
      stateId: true,
      stateCategory: true,
      startedAt: true,
      completedAt: true,
    },
  });
  await writeActivity(tx, ctx, item, {
    field: "stateCategory",
    oldValue: item.stateCategory,
    newValue: to,
    oldRef: item.stateId,
    newRef: state.id,
    // A move WITHIN a category (In progress → In review) changes nothing
    // a client is shown — the portal sees categories, never state names
    // — while the row carries two workflow-state ids. Portal-safe is
    // about the FIELD and the CHANGE, not the field alone.
    forceInternal: item.stateCategory === to,
  });
  await record(tx, {
    action: "work_item.state_changed",
    targetType: "WorkItem",
    targetId: item.id,
    // `approval: true` marks the privileged leg — categories only, never
    // state names or titles (the audit-metadata pin).
    metadata: {
      from: item.stateCategory,
      to,
      projectId: item.projectId,
      ...(state.requiresApproval ? { approval: true } : {}),
    },
  });

  return {
    itemId: row.id,
    stateId: row.stateId,
    stateCategory: row.stateCategory,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    stateName: state.name,
    stateSeedKey: state.seedKey,
    changed: true,
  };
}

/** The inline state change (the backlog's state cell, the panel's `S` picker): one item, one state. */
export async function changeState(
  ctx: WorkCtx,
  itemId: string,
  stateId: string,
): Promise<StateChange> {
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
    // LOCKED, then read, then scope (rows.ts — updateItemFields' fix, for
    // the same race; review 2026-09-13). Read unlocked, a pick that waited
    // at its UPDATE on one that committed described a row version it never
    // replaced, in rows a client and an auditor read: two Done picks both
    // said changed, wrote two client-visible history rows and two audit
    // events, and the second restamped completedAt; an In progress picked
    // over a colleague's Done recorded "To do → In progress"; and a history
    // row took the item's visibility from before a downgrade, which the
    // activity guard then refused as a raw trigger error.
    //
    // No new deadlock (rank-lock.ts). The UPDATE writes state_id,
    // state_category, the two stamps and updated_at — no rank, no number,
    // nothing in a unique index — so it takes this same FOR NO KEY UPDATE
    // and never upgrades it. work_item_parent_guard does not fire on this
    // UPDATE (its column list is parent_id, type, visibility, project_id),
    // so a state change never share-locks a parent. A CLIENT_VISIBLE
    // subtask's raise or create that share-locks THIS row as its parent
    // waits on it, as it waited on the UPDATE before, while this
    // transaction waits on nothing that writer holds: no rank lock, no
    // second work_item row. A no-op or a refusal holds this one lock and
    // takes no other.
    const item = await loadItemInScope(tx, ctx, itemId);
    const state = await tx.workflowState.findFirst({
      where: { tenantId: ctx.tenantId, id: stateId, projectId: item.projectId },
    });
    if (!state) deny("NOT_FOUND");
    return transitionState(tx, ctx, item, state!);
  });
}
