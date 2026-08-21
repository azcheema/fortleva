import { record } from "@/audit/record";
import { assertInScope, type MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
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
  en: ["Backlog", "To do", "In progress", "Done", "Cancelled", "Triage"],
  sv: ["Backlogg", "Att göra", "Pågår", "Klar", "Avbruten", "Triage"],
};

const DEFAULT_STATE_SHAPE = [
  { category: "BACKLOG", isDefault: false, isHidden: false },
  { category: "TODO", isDefault: true, isHidden: false },
  { category: "IN_PROGRESS", isDefault: false, isHidden: false },
  { category: "DONE", isDefault: false, isHidden: false },
  { category: "CANCELLED", isDefault: false, isHidden: false },
  { category: "TRIAGE", isDefault: false, isHidden: true }, // shown only when it has items
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

  const to = state.category;
  const startedAt =
    to === "IN_PROGRESS" && !item.startedAt
      ? new Date()
      : to === "BACKLOG" || to === "TODO" || to === "TRIAGE"
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
    metadata: { from: item.stateCategory, to, projectId: item.projectId },
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
