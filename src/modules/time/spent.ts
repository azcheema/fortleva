import { assertInScope } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";

import { principalOf, type TimeCtx } from "./ctx";

export type ItemSpent = {
  /**
   * `team`: every member's finished entries — `time:view_team`, the same
   * data as the project Time tab's by-task table. `own`: the actor's
   * alone — `time:track`, UI.md rule 14's "employee: own hours".
   */
  scope: "team" | "own";
  /** Finished seconds per work item id. A task with none is absent. */
  seconds: Record<string, number>;
};

const allowed = async (tx: TenantDb, ctx: TimeCtx, code: string): Promise<boolean> => {
  try {
    await requireAccess(tx, ctx.tenantId, ctx.actor, code);
    return true;
  } catch (e) {
    if (e instanceof AuthzError) return false;
    throw e;
  }
};

/**
 * Σ spent per task, for the board's cards (PLAN 2T "Σ spent / estimate").
 *
 * A task's spent time sums EVERY member's entries, which is
 * `time:view_team` data — so that is the gate for the team figure, and a
 * member without it sees their OWN finished time on the task (rule 14),
 * or nothing at all without `time:track`. FINISHED entries only, as the
 * Time tab and `myTimeTotals` count them: the member's own running timer
 * is drawn live by the card's badge, a colleague's is never shown (rule
 * 14, no presence). Scope is asserted before any read, like every
 * project read in this module.
 */
export async function projectItemSpent(ctx: TimeCtx, projectId: string): Promise<ItemSpent | null> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await assertInScope(tx, ctx.actor, { projectId });
    const scope: ItemSpent["scope"] | null = (await allowed(tx, ctx, "time:view_team"))
      ? "team"
      : (await allowed(tx, ctx, "time:track"))
        ? "own"
        : null;
    if (scope === null) return null;
    const rows = await tx.timeEntry.groupBy({
      by: ["workItemId"],
      where: {
        tenantId: ctx.tenantId,
        projectId,
        deletedAt: null,
        stoppedAt: { not: null },
        workItemId: { not: null },
        // Only tasks the board can render: a deleted or archived task's
        // total would otherwise ride to the client keyed by an id no card
        // carries (review — data minimisation, not a permission boundary).
        workItem: { deletedAt: null, archivedAt: null },
        ...(scope === "own" ? { memberId: ctx.actor.memberId } : {}),
      },
      _sum: { durationSeconds: true },
    });
    const seconds: Record<string, number> = {};
    for (const r of rows) {
      const sum = r._sum.durationSeconds ?? 0;
      if (r.workItemId !== null && sum > 0) seconds[r.workItemId] = sum;
    }
    return { scope, seconds };
  });
}
