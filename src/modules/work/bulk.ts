import { record } from "@/audit/record";
import { assertInScope, scopeWhere } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { MAX_BULK_ITEMS } from "@/lib/work-view";

import { writeActivity } from "./activity";
import { lockProjectRanks } from "./rank-lock";
import { transitionState, type WorkCtx } from "./states";

/**
 * Bulk edits from the backlog's selection bar (2W-F slice 4).
 *
 * The recipe is the module's, unchanged: `requireAccess` →
 * `assertInScope` → mutate → `record`, all inside ONE transaction. What
 * bulk adds is that the transaction now covers N items, so the rules
 * below are about keeping that honest rather than fast.
 *
 * ALL OR NOTHING. Every verb runs in a single transaction, so a refusal
 * on item 7 of 20 rolls back the first six too. That is deliberate: a
 * bar that reports "changed 6 of 20" after a *permission* failure would
 * be describing a half-applied edit nobody asked for. `skipped` counts
 * only items that needed no change (already in that state, already
 * archived) — never items that were refused.
 *
 * ONE PROJECT. A selection comes from one project's list, and scope is a
 * per-project question, so a mixed batch is INVALID_INPUT rather than a
 * loop of scope checks. This keeps `assertInScope` to exactly one call
 * and makes the gate impossible to get subtly wrong.
 *
 * WHY THESE THREE VERBS AND NOT THE OTHERS (dispositioned, not
 * forgotten — each is a slice of its own):
 *   • visibility — the downgrade refusal is typed now (2026-09-11: the
 *     trigger's `WORK_ITEM_VISIBLE_CHILDREN` token, `guarded` in
 *     db-errors.ts), so a bulk verb would only have to wrap its body the
 *     way changeItemVisibility does. What still makes it a slice of its
 *     own, on the one axis where the worst bug this product can have
 *     lives: a descendant closure (deepest-first to make private,
 *     refuse-up to make visible), a count confirmation (UI.md §5.5), and
 *     a bulk RAISE of subtasks being a multi-row writer that must take
 *     the rank lock like every other (rank-lock.ts). Not a loop.
 *   • assign — `assignItem` emits one notification and one debounced
 *     email PER ITEM with a per-item dedupe key, so twenty rows would be
 *     twenty emails. It needs a summary notification kind first.
 *   • delete — refuses items with live children, so a correct bulk
 *     delete needs depth ordering, and it cascades to attachments with
 *     an audit row each.
 */

export type BulkResult = {
  /** Items this call actually wrote. */
  changed: number;
  /** Items that already had the requested value — no write, no audit. */
  skipped: number;
};

/** A selected row WITHOUT its description pair — see `ItemRow` in states.ts. */
type ItemRow = Omit<
  NonNullable<Awaited<ReturnType<TenantDb["workItem"]["findFirst"]>>>,
  "description" | "descriptionText"
>;

/**
 * Load the selection and gate it once: live items of ONE project the
 * actor may edit.
 *
 * THE LOAD IS SCOPE-FILTERED, NOT SCOPE-CHECKED, and that ordering is
 * the security property. Member scope is resolved in application code —
 * RLS carries tenant isolation and the portal gates, but no
 * `member_client` term — so a bare tenant-scoped `findMany` returns
 * every live item of the tenant whose id was supplied, including
 * projects the actor has no assignment to. Deciding anything from those
 * rows before checking scope leaks their existence: the multi-project
 * refusal (`INVALID_INPUT`) and the empty refusal (`NOT_FOUND`) are
 * different, user-visible strings, so a member holding one foreign
 * UUID could pair it with an id of their own and learn from which
 * answer came back whether that foreign item is still live — silently,
 * because a no-op priority write leaves no audit row. AUTHZ.md §4 is
 * explicit that existence must not leak across the client boundary.
 *
 * Composing `scopeWhere` into the query instead makes an out-of-scope id
 * fall out of the result exactly like a deleted one, so the two are
 * indistinguishable from outside. `assertInScope` stays below it as the
 * second belt.
 *
 * An id that is no longer a live item — deleted in another tab, or never
 * the actor's to see — is simply ABSENT from the result, so it is
 * counted neither as changed nor as skipped: the totals describe the
 * rows that actually existed for this member, which is what the toast
 * then reports. That is deliberate; a stale client must not make the
 * whole action fail. If EVERY id is absent there is nothing to describe,
 * and the call is NOT_FOUND so the surface refreshes rather than
 * claiming a successful no-op.
 */
async function loadSelection(tx: TenantDb, ctx: WorkCtx, itemIds: readonly string[]): Promise<ItemRow[]> {
  if (itemIds.length === 0) fail("INVALID_INPUT", "no items selected");
  if (itemIds.length > MAX_BULK_ITEMS) fail("INVALID_INPUT", "too many items selected");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
  const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "projectId" });
  const ids = [...new Set(itemIds)];
  const where = { ...scope, tenantId: ctx.tenantId, id: { in: ids }, deletedAt: null };
  const probe = await tx.workItem.findMany({ where, select: { projectId: true } });
  if (probe.length === 0) deny("NOT_FOUND");
  const projectIds = new Set(probe.map((i) => i.projectId));
  if (projectIds.size > 1) fail("INVALID_INPUT", "a selection spans one project");
  const projectId = probe[0]!.projectId;
  await assertInScope(tx, ctx.actor, { projectId });
  // A bulk edit locks every selected row, in scan order: it queues on the
  // project's rank lock first, like every queued writer (rank-lock.ts), so
  // it never holds one of these rows while another queued writer holds
  // the next.
  await lockProjectRanks(tx, projectId);
  // Then the rows themselves, LOCKED BEFORE THEY ARE READ (slice 7, PLAN
  // §0 — the fix updateItemFields and changeState took in slice 6). The
  // diff each verb takes below — already that priority, already in that
  // state, already archived — and every history row's old value must
  // describe the version the UPDATE replaces, not one a single-row
  // writer committed while this transaction waited at its UPDATE: read
  // unlocked, a priority a colleague had just set counted as changed,
  // got a history row from a value it never replaced, and a state a
  // colleague had just entered was audited a second time. Single-row
  // writers take no rank lock, so their commits land whenever they land;
  // a wait here refreshes only this statement, and the read that follows
  // is a new one, so it sees the row as it is now — absent if it is gone.
  // FOR NO KEY UPDATE, the mode the three verbs' UPDATEs take (priority,
  // the state columns, archived_at — nothing in a unique index), so
  // nothing upgrades; scan order, as the UPDATE itself locked before, and
  // still under the queue lock, so no other multi-row writer holds a row
  // of this project meanwhile (rank-lock.ts). Only live rows of the ONE
  // project the scope check passed, so an id outside it locks nothing.
  await tx.$queryRaw`
    SELECT 1 FROM work_item
    WHERE tenant_id = ${ctx.tenantId} AND project_id = ${projectId}
      AND id = ANY(${ids}::text[]) AND deleted_at IS NULL
    FOR NO KEY UPDATE`;
  const items = await tx.workItem.findMany({
    where: { ...where, projectId },
    // The three verbs diff priority, the state columns and archivedAt:
    // never the document, which is up to 512 KB per row and would
    // otherwise cross the wire fifty times under the queue lock.
    omit: { description: true, descriptionText: true },
  });
  if (items.length === 0) deny("NOT_FOUND");
  return items;
}

/**
 * Move every selected item into one state. Each item goes through
 * `transitionState`, exactly as a drag or the inline select does — so
 * the startedAt/completedAt stamps, the activity row and the
 * `work_item.state_changed` audit are per item and identical to the
 * single-item path, and the 2W-R approval gate is enforced once per
 * item rather than approximated once per batch.
 */
export async function bulkChangeState(
  ctx: WorkCtx,
  itemIds: readonly string[],
  stateId: string,
): Promise<BulkResult> {
  return withTenant(
    ctx.tenantId,
    { type: "member", id: ctx.actor.memberId },
    async (tx) => {
      const items = await loadSelection(tx, ctx, itemIds);
      const state = await tx.workflowState.findFirst({
        where: { tenantId: ctx.tenantId, id: stateId, projectId: items[0]!.projectId },
      });
      if (!state) deny("NOT_FOUND");
      let changed = 0;
      for (const item of items) {
        if (item.stateId === state!.id) continue;
        await transitionState(tx, ctx, item, state!);
        changed += 1;
      }
      return { changed, skipped: items.length - changed };
    },
    { timeoutMs: 60_000 },
  );
}

/**
 * Set one priority on every selected item. A priority change is a
 * ROUTINE edit — the same rule `updateItemFields` follows: an activity
 * row per item, no audit event. One `updateMany` for the write, so the
 * statement count does not grow with the selection.
 */
export async function bulkSetPriority(
  ctx: WorkCtx,
  itemIds: readonly string[],
  priority: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT",
): Promise<BulkResult> {
  return withTenant(
    ctx.tenantId,
    { type: "member", id: ctx.actor.memberId },
    async (tx) => {
      const items = await loadSelection(tx, ctx, itemIds);
      const changing = items.filter((i) => i.priority !== priority);
      if (changing.length > 0) {
        await tx.workItem.updateMany({
          where: { id: { in: changing.map((i) => i.id) } },
          data: { priority },
        });
        for (const item of changing) {
          await writeActivity(tx, ctx, item, {
            field: "priority",
            oldValue: item.priority,
            newValue: priority,
          });
        }
      }
      return { changed: changing.length, skipped: items.length - changing.length };
    },
    { timeoutMs: 60_000 },
  );
}

/**
 * Archive or restore every selected item. Archiving is never silent (UI
 * rule 12), so it keeps the single-item path's per-item
 * `work_item.archived` audit row rather than collapsing into one
 * aggregate: `MAX_BULK_ITEMS` bounds the count, and an archive nobody
 * can trace to an item is not an archive anyone can undo.
 */
export async function bulkSetArchived(
  ctx: WorkCtx,
  itemIds: readonly string[],
  archived: boolean,
): Promise<BulkResult> {
  return withTenant(
    ctx.tenantId,
    { type: "member", id: ctx.actor.memberId },
    async (tx) => {
      const items = await loadSelection(tx, ctx, itemIds);
      const changing = items.filter((i) => Boolean(i.archivedAt) !== archived);
      if (changing.length > 0) {
        await tx.workItem.updateMany({
          where: { id: { in: changing.map((i) => i.id) } },
          data: { archivedAt: archived ? new Date() : null },
        });
        for (const item of changing) {
          await record(tx, {
            action: "work_item.archived",
            targetType: "WorkItem",
            targetId: item.id,
            metadata: { archived, projectId: item.projectId, bulk: true },
          });
        }
      }
      return { changed: changing.length, skipped: items.length - changing.length };
    },
    { timeoutMs: 60_000 },
  );
}
