import { record } from "@/audit/record";
import { assertInScope, isAuthorized, type MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { ranksBetween } from "@/lib/rank";
import { writeActivity } from "./activity";

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

type StateRow = NonNullable<Awaited<ReturnType<TenantDb["workflowState"]["findFirst"]>>>;
type ItemRow = NonNullable<Awaited<ReturnType<TenantDb["workItem"]["findFirst"]>>>;

/**
 * The state machine (§6.14), as ONE transaction step so every entry
 * point — inline select, board drop, "Move to…", palette, bulk, triage,
 * import — runs the same code: syncs stateCategory (belt: the trigger
 * does too), stamps startedAt on the first IN_PROGRESS, completedAt on
 * DONE, clears both on regression, writes the portal-safe activity row
 * and dual-writes the audit event. The caller has already authorised
 * and scoped the item; `state` must belong to the item's project.
 * Parent rollup automation (autoStartParent/autoCompleteParent) is a
 * later slice.
 */
export async function transitionState(
  tx: TenantDb,
  ctx: WorkCtx,
  item: ItemRow,
  state: StateRow,
): Promise<void> {
  if (state.projectId !== item.projectId) deny("NOT_FOUND");
  if (state.id === item.stateId) return;
  // Entering TRIAGE means triageStatus too (the §6.14 CHECK
  // `work_item_triage_has_status` enforces it), which is the `work_item:triage`
  // verb's job — a plain state change into it would reach the database and
  // come back as a raw constraint error. Leaving triage is an ordinary move.
  if (state.category === "TRIAGE") fail("INVALID_INPUT", "triage entry is not a state change");
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

  await tx.workItem.update({
    where: { id: item.id },
    data: { stateId: state.id, stateCategory: to, startedAt, completedAt },
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
}

/** The inline state change (the backlog's select): one item, one state. */
export async function changeState(
  ctx: WorkCtx,
  itemId: string,
  stateId: string,
): Promise<void> {
  await withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
    const item = await tx.workItem.findFirst({
      where: { tenantId: ctx.tenantId, id: itemId, deletedAt: null },
    });
    if (!item) deny("NOT_FOUND");
    await assertInScope(tx, ctx.actor, { projectId: item!.projectId });
    const state = await tx.workflowState.findFirst({
      where: { tenantId: ctx.tenantId, id: stateId, projectId: item!.projectId },
    });
    if (!state) deny("NOT_FOUND");
    await transitionState(tx, ctx, item!, state!);
  });
}
