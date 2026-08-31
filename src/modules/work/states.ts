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
 * seeding also self-heals projects that predate 2W. Names are seeded
 * locale-aware from Tenant.defaultLocale, tenant text thereafter.
 */

export type WorkCtx = { readonly tenantId: string; readonly actor: MemberActor };

const DEFAULT_STATE_NAMES: Record<"en" | "sv", readonly string[]> = {
  en: ["Backlog", "To do", "In progress", "In review", "Done", "Cancelled", "Triage"],
  sv: ["Backlogg", "Att göra", "Pågår", "Granskning", "Klar", "Avbruten", "Triage"],
};

// "In review" is a tenant-named state in the IN_PROGRESS category (the
// category set is pinned closed; the portal reads categories only —
// exactly ADO's mapping of In Review). Done carries the approval gate:
// entering it needs work_item:approve on top of work_item:edit (2W-R).
const DEFAULT_STATE_SHAPE = [
  { category: "BACKLOG", isDefault: false, isHidden: false, requiresApproval: false },
  { category: "TODO", isDefault: true, isHidden: false, requiresApproval: false },
  { category: "IN_PROGRESS", isDefault: false, isHidden: false, requiresApproval: false },
  { category: "IN_PROGRESS", isDefault: false, isHidden: false, requiresApproval: false }, // In review
  { category: "DONE", isDefault: false, isHidden: false, requiresApproval: true },
  { category: "CANCELLED", isDefault: false, isHidden: false, requiresApproval: false },
  { category: "TRIAGE", isDefault: false, isHidden: true, requiresApproval: false }, // shown only when it has items
] as const;

/** Idempotent + race-safe (skipDuplicates on the name unique). */
export async function ensureProjectStates(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
): Promise<void> {
  const existing = await tx.workflowState.count({ where: { tenantId, projectId } });
  if (existing > 0) return;
  const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { defaultLocale: true } });
  const names = DEFAULT_STATE_NAMES[tenant?.defaultLocale === "sv" ? "sv" : "en"];
  const ranks = ranksBetween(null, null, DEFAULT_STATE_SHAPE.length);
  await tx.workflowState.createMany({
    data: DEFAULT_STATE_SHAPE.map((s, i) => ({
      tenantId,
      projectId,
      name: names[i]!,
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
