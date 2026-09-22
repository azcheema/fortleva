import { record } from "@/audit/record";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { retryOnDeadlock } from "@/lib/retry";

import { writeActivity } from "./activity";
import { loadItemInScope, type ItemRow } from "./rows";
import { TRIAGE_REASON_MAX, TRIAGE_SNOOZE_MAX_DAYS, type TriageVerb } from "./triage-limits";
import {
  principalOf,
  transitionState,
  type StateChange,
  type StateRow,
  type TriageWrite,
  type WorkCtx,
} from "./states";

/**
 * THE TRIAGE LANE (`work_item:triage`) — the member-side answer to a
 * client's request, and the other half of Phase 3 slice 6a.
 *
 * Slice 6a gave a contact a door into the agency's board: a
 * `WorkItem(kind = REQUEST)` that lands CLIENT_VISIBLE in the project's
 * hidden TRIAGE state. Until this file there was no verb to answer it
 * with. `work_item:triage` sat on `enforcement.test.ts`'s declared-ahead
 * list with no site anywhere, which meant a member could drag a request
 * out of the lane — an ordinary move — but could not Decline, Duplicate
 * or Snooze one.
 *
 * FOUR VERBS, AND THE PRODUCT RULE THAT ORDERS THEM (§6.14's
 * `TriageStatus`, the work-management plan §3.1's "Accept / Decline /
 * Duplicate / Snooze"):
 *
 *   ACCEPT    the request becomes ordinary work: it moves to the
 *             project's DEFAULT state and every triage column is
 *             cleared. The client's list stops saying "Requested" and
 *             starts saying "Planned".
 *   DECLINE   the answer is no. The row moves to a CANCELLED-category
 *             state, keeps `triageStatus = DECLINED`, and **carries the
 *             agency's reason, which the client reads**.
 *   DUPLICATE the answer is "we are already on it": the same move, with
 *             `duplicateOfId` naming the row it duplicates — internally
 *             — and the same client-readable reason.
 *   SNOOZE    not now. The row STAYS in triage with
 *             `triageStatus = SNOOZED` and a `snoozedUntil`, and drops
 *             out of the lane's own query until that moment passes. The
 *             client sees no change at all, which is honest: it is
 *             still requested.
 *
 * **THE ONE RULE THIS FILE EXISTS TO HOLD** (founder decision,
 * 2026-09-22): *a client's own request never disappears without a
 * reason.* DATA_MODEL §6.14 pins DECLINED and DUPLICATE to a
 * CANCELLED-category state, and `portal.ts` used to map CANCELLED to
 * nothing — so before this slice the single row on a client's list that
 * they had submitted themselves vanished silently the moment the agency
 * said no. Three things now hold it together, deliberately at three
 * different layers, because this is the class of bug this product fears
 * most:
 *
 *   1. HERE — Decline and Duplicate refuse an empty reason.
 *   2. IN THE STATE MACHINE — `transitionState` refuses ANY other move
 *      from TRIAGE into a CANCELLED state (a board drag, the picker,
 *      the bulk bar), pointing the caller at this verb.
 *   3. IN THE DATABASE — `work_item_triage_reason_iff_outcome`
 *      (20260922120000) makes a reasonless DECLINED row unwritable by
 *      anything, including a future import or a hand-written UPDATE.
 *
 * WHAT IS NOT HERE, so nobody goes looking. No notification: the
 * submitting contact is not told, because contacts have no notification
 * channel in v1 (no `ContactNotificationPreference`, no SES production
 * access — PLAN §0) and inventing one in a triage slice would mean
 * designing the contact's whole email identity in passing. The client
 * learns the answer from the portal, which is what this slice makes
 * truthful. Recorded as owed in PLAN §0 rather than half-built.
 */

/**
 * The verb list and the two caps live in `triage-limits.ts`, a LEAF that
 * imports nothing, because the lane's `"use client"` decline dialog
 * needs them — and importing them from here would pull this file's
 * graph (`@/db`, Prisma, `pg`, Node builtins) into the browser bundle.
 * Its header records the two build failures that proved it, and
 * `request-limits.ts` next door is the same shape. Re-exported so a
 * server caller still has one import site.
 */
export {
  TRIAGE_REASON_MAX,
  TRIAGE_SNOOZE_MAX_DAYS,
  TRIAGE_VERBS,
  type TriageVerb,
} from "./triage-limits";

export type TriageInput =
  | { readonly verb: "ACCEPT" }
  | { readonly verb: "DECLINE"; readonly reason: string }
  | { readonly verb: "DUPLICATE"; readonly reason: string; readonly duplicateOfId: string }
  | { readonly verb: "SNOOZE"; readonly until: Date };

/**
 * What the surface needs to redraw itself, in UI.md §7.2's shape: a
 * mutation returns the row so an optimistic slice is REPLACED rather
 * than merged.
 *
 * `state` is `null` for a SNOOZE and only for a SNOOZE — the row does
 * not move, so there is no transition to report and the caller must not
 * animate one.
 */
export type TriageOutcome = {
  readonly itemId: string;
  readonly verb: TriageVerb;
  readonly triageStatus: ItemRow["triageStatus"];
  readonly snoozedUntil: Date | null;
  readonly state: StateChange | null;
};

/**
 * ANSWER ONE REQUEST.
 *
 * `work_item:triage` is its OWN permission and not a flavour of
 * `work_item:edit` (AUTHZ catalogue, CME): accepting work commits the
 * agency to it and declining it speaks to a client in the agency's
 * name, which is a different thing from moving a card. A member with
 * `work_item:edit` alone can still drag a request into "To do" —
 * that is accepting it, and the state machine allows it — but only
 * this verb can end one.
 *
 * THE LOCK, THE READ, THE SCOPE, IN THAT ORDER (`loadItemInScope`'s
 * own rule, and the fix slices 6 and 7 paid for): read unlocked, a
 * verb that waited at its UPDATE on a concurrent one would describe a
 * row version it never replaced — and on this path that means an audit
 * event and a CLIENT-READ history row about a transition that did not
 * happen. Two members answering the same request at once is not
 * hypothetical: a request arrives in an inbox that everyone on the
 * project reads.
 *
 * **IT IS THIS MODULE'S FIRST TWO-ROW `work_item` WRITER, AND THAT
 * NEEDS SAYING OUT LOUD** (code review). DUPLICATE holds the request
 * under `FOR NO KEY UPDATE` and then writes `duplicate_of_id`, whose
 * referential-integrity check takes `FOR KEY SHARE` on the TARGET row —
 * the same implicit lock `rank-lock.ts` already records for `copyWeek`.
 * A concurrent `moveItem` that takes the target under `FOR UPDATE` and
 * then anchors on this request closes the cycle, and nothing serialises
 * the two: this verb takes no rank queue.
 *
 * SO IT TAKES `retryOnDeadlock`, WHICH IS A CURE AND NOT A PREVENTION,
 * and that is the choice `rank-lock.ts` already made twice for the same
 * shape (`copyWeek`, `repriceRateCard`). Joining the project's rank
 * queue would prevent it, but the queue must precede any row lock, so
 * this function would have to probe for `projectId` before
 * `loadItemInScope` — an extra read and a project-wide lock on every
 * triage, to prevent a cycle that needs a board drag to land on the two
 * exact rows a duplicate is being filed between. The retry costs
 * nothing when there is no contention and turns the rare case into a
 * second attempt rather than a raw `40P01` in a member's face.
 */
export async function triageItem(
  ctx: WorkCtx,
  itemId: string,
  input: TriageInput,
): Promise<TriageOutcome> {
  // PARSED BEFORE THE TRANSACTION OPENS. A blank reason is a fact about
  // what the member typed, not about the tenant, so it costs nothing to
  // say so early — and it keeps the shapes below total, so the write
  // path has no "should not happen" branch.
  const parsed = parseInput(input);

  return retryOnDeadlock(() => withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:triage");
    const item = await loadItemInScope(tx, ctx, itemId);

    // WHICH VERBS APPLY WHERE, and the split is the one both reviews
    // of this slice forced.
    //
    // ACCEPT and SNOOZE are LANE verbs: they only mean anything while
    // the request is still waiting to be answered, so they require a
    // TRIAGE-category state.
    //
    // **DECLINE and DUPLICATE are LIFECYCLE verbs** and apply to a
    // `kind = REQUEST` row wherever it sits. That is not a convenience:
    // `transitionState` now refuses ANY move of a request into a
    // cancelled state without a reason, so if this verb only worked in
    // the lane, a request that had been accepted into "To do" and was
    // later dropped could not be ended at all. Ending a client's
    // request always owes them an answer — including when the agency
    // agreed to it first and changed its mind, which is the ordinary
    // case the first cut of this slice missed.
    //
    // `stateCategory` rather than `triageStatus` is the test throughout,
    // and the difference is load-bearing: the category is
    // trigger-derived from the state the row is in
    // (`work_item_state_sync`), so it cannot disagree with where the
    // item actually sits, while `triageStatus` is a column a writer
    // sets.
    const laneVerb = parsed.verb === "ACCEPT" || parsed.verb === "SNOOZE";
    if (laneVerb && item.stateCategory !== "TRIAGE") fail("INVALID_INPUT", "not in triage");
    if (!laneVerb) {
      // Only a REQUEST can be declined: an ordinary task is cancelled
      // the ordinary way, and there is no client owed an explanation.
      if (item.kind !== "REQUEST") fail("INVALID_INPUT", "not a request");
      // …and not one that has already been ended. Re-declining would
      // overwrite one answer with another under the client's nose, and
      // the "answered once" property is what makes the trail readable.
      if (item.stateCategory === "CANCELLED") fail("INVALID_INPUT", "already ended");
    }
    // Archived and soft-deleted rows: `loadItemInScope` filters
    // `deletedAt`, and an archived request is one the agency has already
    // put away. Declining it would write a client-visible answer to
    // something the client can no longer see (`listPortalTasks` filters
    // `archivedAt`), which is the same silent-vanish this slice exists
    // to end, from the other direction.
    if (item.archivedAt) fail("ARCHIVED", "work item");

    // ── SNOOZE: the row does not move ────────────────────────────────
    // It is the one verb with no transition, so it writes its own
    // UPDATE — and that is not a second state machine: no state, no
    // category, no stamp and no client-visible fact changes, which is
    // exactly why `transitionState` has nothing to say about it. The
    // activity row is INTERNAL by construction (`triageStatus` is not
    // on `writeActivity`'s portal-safe list) and that is the right
    // answer: a client must not be able to read "they put this off".
    if (parsed.verb === "SNOOZE") {
      // ALREADY SNOOZED TO THIS MOMENT: no row, no activity, no audit.
      // The module's own `changed: false` convention (`transitionState`
      // returns it rather than writing a second identical history row),
      // applied to the one verb that does not go through it. The case
      // that makes it real is a double submit, which would otherwise
      // leave two `work_item.triaged` events and a history row whose
      // old and new values are the same string.
      if (
        item.triageStatus === "SNOOZED" &&
        item.snoozedUntil?.getTime() === parsed.until.getTime()
      ) {
        return {
          itemId: item.id,
          verb: "SNOOZE" as const,
          triageStatus: "SNOOZED" as const,
          snoozedUntil: item.snoozedUntil,
          state: null,
        };
      }
      await tx.workItem.update({
        where: { id: item.id },
        data: { triageStatus: "SNOOZED", snoozedUntil: parsed.until },
        // Narrow, the standing trap: a select-less update returns the
        // whole row, this item's `descriptionText` — the words the
        // client typed — included.
        select: { id: true },
      });
      await writeActivity(tx, ctx, item, {
        field: "triageStatus",
        oldValue: item.triageStatus,
        newValue: "SNOOZED",
      });
      await recordTriage(tx, item, "SNOOZE", { until: parsed.until.toISOString() });
      return {
        itemId: item.id,
        verb: "SNOOZE" as const,
        triageStatus: "SNOOZED" as const,
        snoozedUntil: parsed.until,
        state: null,
      };
    }

    // ── ACCEPT / DECLINE / DUPLICATE: the row moves ──────────────────
    const target = await resolveTarget(tx, ctx, item, parsed);
    // ONE call, so the state change, its portal-safe activity row and
    // its `work_item.state_changed` audit event are written by the same
    // code every other entry point uses (§3.1's "one service"), and the
    // triage columns land in that same UPDATE rather than a second one.
    // A declined request is therefore never, even for the width of a
    // statement, a row the client cannot see with nobody having said
    // why.
    const state = await transitionState(tx, ctx, item, target.state, target.triage);
    // A BELT AGAINST A SILENT NO-OP, and it is one line because the
    // alternative is invisible. `transitionState` returns EARLY when the
    // item is already in the target state — no UPDATE, so none of the
    // triage columns above would be written either — and it reports
    // that only in `changed`. It cannot happen today (the row is in a
    // TRIAGE-category state and the targets are the project's default
    // and cancelled ones, neither of which can be that), but "cannot"
    // here rests on the seeded state shape rather than on anything this
    // function checks. Loud beats silent: the alternative is a member
    // told their decline was recorded when nothing moved.
    if (!state.changed) throw new Error("triageItem: the state did not change");
    await writeActivity(tx, ctx, item, {
      field: "triageStatus",
      oldValue: item.triageStatus,
      newValue: target.triage.triageStatus,
    });
    await recordTriage(tx, item, parsed.verb, {
      ...(target.triage.duplicateOfId ? { duplicateOfId: target.triage.duplicateOfId } : {}),
    });
    return {
      itemId: item.id,
      verb: parsed.verb,
      triageStatus: target.triage.triageStatus,
      snoozedUntil: null,
      state,
    };
  }));
}

// ── Parsing ─────────────────────────────────────────────────────────

/**
 * Structurally identical to `TriageInput`, and deliberately an ALIAS
 * rather than a second declaration: TypeScript is structural, so a
 * duplicate shape buys no safety and only offers the two a chance to
 * drift (code review). The distinct NAME still earns its place — it
 * marks the boundary past which the strings are trimmed and the bounds
 * are checked.
 */
type ParsedInput = TriageInput;

/**
 * The reason is TRIMMED and then required, which is the same rule the
 * column states (`btrim(triage_reason) <> ''`): a reason of spaces is
 * an absent one wearing a value, and the one thing this slice promises
 * a client is that they are told why.
 */
function parseInput(input: TriageInput): ParsedInput {
  switch (input.verb) {
    case "ACCEPT":
      return { verb: "ACCEPT" };
    case "DECLINE":
    case "DUPLICATE": {
      const reason = input.reason.trim();
      if (reason.length === 0) fail("INVALID_INPUT", "reason");
      if (reason.length > TRIAGE_REASON_MAX) fail("INVALID_INPUT", "reason too long");
      if (input.verb === "DECLINE") return { verb: "DECLINE", reason };
      // An empty id must not reach a `where`: Prisma DROPS an undefined
      // filter and this read is what decides whether the target is the
      // member's to name at all (`requests.ts` carries the same belt for
      // the same reason).
      if (!input.duplicateOfId) fail("INVALID_INPUT", "duplicateOf");
      return { verb: "DUPLICATE", reason, duplicateOfId: input.duplicateOfId };
    }
    case "SNOOZE": {
      const until = input.until;
      if (Number.isNaN(until.getTime())) fail("INVALID_INPUT", "until");
      const now = Date.now();
      if (until.getTime() <= now) fail("INVALID_INPUT", "until is not in the future");
      if (until.getTime() > now + TRIAGE_SNOOZE_MAX_DAYS * 86_400_000) {
        fail("INVALID_INPUT", "until is too far ahead");
      }
      return { verb: "SNOOZE", until };
    }
  }
}

// ── Where each verb sends the row ───────────────────────────────────

type MovingVerb = Exclude<TriageVerb, "SNOOZE">;
type Target = {
  readonly state: StateRow;
  /** `TriageWrite` with `snoozedUntil` pinned: none of the three moving
   *  verbs leaves a wake-up time behind. Narrowed from the state
   *  machine's own type rather than re-declared, so the two cannot
   *  drift (code review). */
  readonly triage: TriageWrite & { readonly snoozedUntil: null };
};

/**
 * ACCEPT lands on the project's DEFAULT state and the other two on its
 * CANCELLED one, both resolved from the project rather than chosen by
 * the caller — the same arrangement `createRequest` uses for the same
 * reason: the verb decides what the row becomes, and there is no
 * parameter with which to decide otherwise.
 *
 * BOTH LOOKUPS FAIL CLOSED. A project whose states were never seeded
 * cannot reach here (the request in hand is IN one of them), so a
 * missing default or cancelled state means a tenant's workflow is
 * broken rather than unusual — a plain `Error` to the boundary, never a
 * `fail()` a member could read as "you did something wrong", and never
 * a silent fallback to whatever state happened to sort first.
 */
async function resolveTarget(
  tx: TenantDb,
  ctx: WorkCtx,
  item: ItemRow,
  parsed: Extract<ParsedInput, { verb: MovingVerb }>,
): Promise<Target> {
  const accepting = parsed.verb === "ACCEPT";

  // AN EXPLICIT SELECT, because this file is now in
  // `portal-projections.test.ts`'s STRUCTURAL tier — it authors the one
  // member-written string a contact reads, so a select-less `findFirst`
  // here must be a test failure rather than a habit. These six fields
  // are exactly what `transitionState` reads off a state.
  const state = await tx.workflowState.findFirst({
    where: {
      tenantId: ctx.tenantId,
      projectId: item.projectId,
      ...(accepting ? { isDefault: true } : { category: "CANCELLED" }),
    },
    orderBy: { rank: "asc" },
    select: {
      id: true,
      projectId: true,
      category: true,
      requiresApproval: true,
      name: true,
      seedKey: true,
    },
  });
  if (!state) {
    throw new Error(`triageItem: project has no ${accepting ? "default" : "cancelled"} state`);
  }

  // Switched on `parsed.verb` and not on a `MovingVerb` local, so the
  // compiler narrows the union: `reason` exists on exactly the two
  // members that carry one, and a fifth verb added to `TriageInput`
  // without a branch here is a compile error rather than a row that
  // falls through to DECLINE.
  switch (parsed.verb) {
    case "ACCEPT":
      return {
        state,
        triage: { triageStatus: null, triageReason: null, snoozedUntil: null, duplicateOfId: null },
      };
    case "DECLINE":
      return {
        state,
        triage: {
          triageStatus: "DECLINED",
          triageReason: parsed.reason,
          snoozedUntil: null,
          duplicateOfId: null,
        },
      };
    case "DUPLICATE":
      return {
        state,
        triage: {
          triageStatus: "DUPLICATE",
          triageReason: parsed.reason,
          snoozedUntil: null,
          duplicateOfId: await resolveDuplicate(tx, ctx, item, parsed.duplicateOfId),
        },
      };
  }
}

/**
 * THE DUPLICATE TARGET MUST BE IN THE SAME PROJECT, and the narrowness
 * is the safety argument rather than a limitation nobody got round to
 * widening.
 *
 * `duplicate_of_id`'s FK binds only `(tenant_id, id)` — so the database
 * would happily accept a row in ANOTHER CLIENT'S project. Nothing is
 * projected from it today (`portal.ts` never selects it, and this slice
 * does not add it), so the leak would be latent rather than live; but
 * "latent" is how a cross-client reference gets into the data and then
 * into the first surface that renders a duplicate-of link. Same project
 * means the member's scope has already been asserted on it by
 * `loadItemInScope` above — one `assertInScope`, not two — and it is
 * what a duplicate actually is in practice.
 *
 * NOT ITSELF, and not a deleted row. A self-reference would make the
 * portal's "already tracked" point at the thing that was declined.
 */
async function resolveDuplicate(
  tx: TenantDb,
  ctx: WorkCtx,
  item: ItemRow,
  duplicateOfId: string,
): Promise<string> {
  if (duplicateOfId === item.id) fail("INVALID_INPUT", "duplicateOf is the item itself");
  const other = await tx.workItem.findFirst({
    where: {
      tenantId: ctx.tenantId,
      id: duplicateOfId,
      projectId: item.projectId,
      deletedAt: null,
      // Archived too: `triageItem` refuses to ANSWER an archived
      // request, so pointing one at an archived target would be the
      // same inconsistency from the other end (code review).
      archivedAt: null,
    },
    select: { id: true },
  });
  // NOT_FOUND rather than INVALID_INPUT: a row the member cannot reach
  // and a row that does not exist must answer identically, or the
  // picker becomes an existence oracle over the tenant (AUTHZ §4).
  if (!other) deny("NOT_FOUND", "work item");
  return other!.id;
}

// ── The trail ───────────────────────────────────────────────────────

/**
 * `work_item.triaged` — catalogued since 2W, unwritten until now.
 *
 * IDS AND ENUMS ONLY. **The reason never goes in here**, and it is the
 * one field a reader of this function will be tempted by: an audit row
 * is read by operators and retained far longer than the row it
 * describes (SECURITY.md §7 — metadata is minimized by the caller), and
 * a decline reason is prose written about a named client's request. The
 * same rule keeps titles out of `work_item.created`.
 *
 * The state change has its OWN event (`work_item.state_changed`, from
 * `transitionState`), so this one does not repeat the categories —
 * two rows, one transaction, each saying the thing only it knows.
 */
async function recordTriage(
  tx: TenantDb,
  item: ItemRow,
  verb: TriageVerb,
  extra: Record<string, string>,
): Promise<void> {
  await record(tx, {
    action: "work_item.triaged",
    targetType: "WorkItem",
    targetId: item.id,
    metadata: { verb, projectId: item.projectId, clientId: item.clientId, ...extra },
  });
}
