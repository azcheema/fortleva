import { record } from "@/audit/record";
import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail, isUniqueViolation } from "@/lib/domain-error";
import { RANK_REBALANCE_LENGTH, rankBetween, ranksBetween } from "@/lib/rank";
import { loadItemInScope } from "./items";
import { lockLiveRow, lockPredecessor, lockProjectRanks, lockSuccessor } from "./rank-lock";
import { transitionState, type WorkCtx } from "./states";

/**
 * Ordering (ARC-17, UI.md §7.1): ONE `rank` per item per project, unique
 * `(tenantId, projectId, rank)`, fractional keys computed HERE from
 * locked neighbours — the client sends ids, never a rank string, and
 * rank never reaches the DOM. A board column is that state's items by
 * rank; the backlog is every open item by rank ("maintain backlog
 * order"), so a board drop is a state change + a rank change in one
 * transaction, through the same state machine every entry point uses.
 *
 * Anchor semantics: `afterId` = the live row the item lands directly
 * AFTER in the project order; `beforeId` = the live row it lands
 * directly BEFORE; neither = the bottom of the project; the item itself
 * as the only anchor = keep the position (a state-only move, e.g. into
 * an empty column). The real neighbour on the other side is read from
 * the database including soft-deleted rows (rank-lock.ts explains why).
 *
 * Concurrency: every rank write of a project runs under the project's
 * advisory transaction lock (rank-lock.ts) — create and move alike; the
 * unique index + the retry stay as the belt for anything that slips.
 */

const principalOf = (ctx: WorkCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

const RANK_RETRIES = 4;

async function retryOnRankCollision<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isUniqueViolation(e) || attempt + 1 >= RANK_RETRIES) throw e;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 25));
    }
  }
}

export type MoveInput = {
  itemId: string;
  /** Target state (a board column); omitted = keep the state. */
  stateId?: string;
  /** Land directly after this item. Wins when both anchors are given. */
  afterId?: string | null;
  /** Land directly before this item. */
  beforeId?: string | null;
};

export type MovedItem = {
  id: string;
  number: number;
  stateId: string;
  stateCategory: string;
  /** True when the project's ranks were rewritten in the same transaction. */
  rebalanced: boolean;
};

/**
 * Board drop / "Move to…": state change (state machine) + rank change,
 * one transaction, own or scoped `work_item:edit`. An anchor that is
 * not a live item of the same project is a stale client →
 * INVALID_INPUT (the UI refreshes). A pure reorder is routine (no
 * activity row, no audit — rank is not a field anyone sees; PLAN §0
 * disposition 2026-08-21); the state leg audits as every state change.
 */
export async function moveItem(ctx: WorkCtx, input: MoveInput): Promise<MovedItem> {
  return retryOnRankCollision(() =>
    withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
      // Scope first (the project comes from the row), then the project
      // lock, then a FRESH read of the item — a snapshot a concurrent
      // writer changed while we waited for the lock is never used.
      const probe = await loadItemInScope(tx, ctx, input.itemId);
      const projectId = probe.projectId;
      await lockProjectRanks(tx, projectId);
      const item = await tx.workItem.findFirst({
        where: { tenantId: ctx.tenantId, id: probe.id, deletedAt: null },
      });
      if (!item) deny("NOT_FOUND");

      const state = input.stateId
        ? await tx.workflowState.findFirst({
            where: { tenantId: ctx.tenantId, id: input.stateId, projectId },
          })
        : null;
      if (input.stateId && !state) deny("NOT_FOUND");

      // Anchors: the item itself is no anchor ("after yourself" = stay,
      // not "bottom"); the item as the ONLY anchor keeps the position.
      const afterId = input.afterId && input.afterId !== item!.id ? input.afterId : null;
      const beforeId = input.beforeId && input.beforeId !== item!.id ? input.beforeId : null;
      const selfAnchored =
        !afterId && !beforeId && (input.afterId === item!.id || input.beforeId === item!.id);

      let lower: string | null = null;
      let upper: string | null = null;
      if (!selfAnchored) {
        if (afterId) {
          const anchor = await lockLiveRow(tx, ctx.tenantId, projectId, afterId);
          if (!anchor) fail("INVALID_INPUT", "after anchor is not a live item of this project");
          lower = anchor!.rank;
          upper = (await lockSuccessor(tx, ctx.tenantId, projectId, lower, item!.id))?.rank ?? null;
        } else if (beforeId) {
          const anchor = await lockLiveRow(tx, ctx.tenantId, projectId, beforeId);
          if (!anchor) fail("INVALID_INPUT", "before anchor is not a live item of this project");
          upper = anchor!.rank;
          lower = (await lockPredecessor(tx, ctx.tenantId, projectId, upper, item!.id))?.rank ?? null;
        } else {
          lower = (await lockPredecessor(tx, ctx.tenantId, projectId, null, item!.id))?.rank ?? null;
        }
      }

      // Already the only row in that gap → the position is unchanged.
      const inPlace =
        selfAnchored ||
        ((lower === null || item!.rank > lower) && (upper === null || item!.rank < upper));
      let rebalanced = false;
      if (!inPlace) {
        const rank = rankBetween(lower, upper);
        await tx.workItem.update({ where: { id: item!.id }, data: { rank } });
        if (rank.length > RANK_REBALANCE_LENGTH) {
          await rebalanceRanks(tx, ctx, projectId);
          rebalanced = true;
        }
      }

      if (state) await transitionState(tx, ctx, item!, state);
      const after = await tx.workItem.findFirstOrThrow({
        where: { id: item!.id },
        select: { id: true, number: true, stateId: true, stateCategory: true },
      });
      return { ...after, rebalanced };
    }),
  );
}

/**
 * Rewrite every rank of the project (live AND soft-deleted — they share
 * the unique index) as fresh evenly-spaced keys, order preserved. Two
 * set-based statements under the project lock: first every key moves
 * to a parking prefix no generated key can collide with ('~' sorts
 * after the base-62 alphabet under COLLATE "C", and prefixing keeps
 * them unique among themselves), then one UPDATE … FROM unnest() lands
 * the final keys — two round trips however large the project. Audited
 * once as `work_item.bulk_edited` (ids/counts only) — rank is not a
 * field anyone sees, so no activity rows.
 */
async function rebalanceRanks(tx: TenantDb, ctx: WorkCtx, projectId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM work_item
    WHERE tenant_id = ${ctx.tenantId} AND project_id = ${projectId}
    ORDER BY rank ASC FOR UPDATE`;
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  const fresh = ranksBetween(null, null, rows.length);
  await tx.$executeRaw`
    UPDATE work_item SET rank = '~' || rank
    WHERE tenant_id = ${ctx.tenantId} AND project_id = ${projectId}`;
  await tx.$executeRaw`
    UPDATE work_item AS w SET rank = v.rank
    FROM unnest(${ids}::text[], ${fresh}::text[]) AS v(id, rank)
    WHERE w.tenant_id = ${ctx.tenantId} AND w.project_id = ${projectId} AND w.id = v.id`;
  await record(tx, {
    action: "work_item.bulk_edited",
    targetType: "Project",
    targetId: projectId,
    metadata: { projectId, reason: "rank_rebalance", count: rows.length },
  });
  return rows.length;
}

/** Maintenance entry point (also what a key > 50 chars triggers inline). */
export async function rebalanceProjectRanks(
  ctx: WorkCtx,
  projectId: string,
): Promise<{ count: number }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
    await assertInScope(tx, ctx.actor, { projectId });
    await lockProjectRanks(tx, projectId);
    const count = await rebalanceRanks(tx, ctx, projectId);
    return { count };
  });
}
