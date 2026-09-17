import { isAuthorized, scopeWhere } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import type { StateSeedKey } from "@/lib/enum-map";

import { principalOf, type WorkCtx } from "./states";

/**
 * `/home`'s queue (UI.md rule 8, PLAN 2W "/home — My Work"): the open
 * tasks assigned to the member, across every project they can still
 * see, soonest due first.
 *
 * GATED, NOT THROWN. `/home` is every member's landing page, and a
 * member without `work_item:view` — or in a tenant with the work module
 * off — is not an error there: they simply have no queue, and the page
 * draws none (the time strip's `canTrackTime` rule). So the gate answers
 * `null` instead of denying, and nothing else in the transaction runs.
 *
 * TWO CODES, BECAUSE THE ROW IS A WAY IN. A row shows the project's name
 * and links into the project, and the project's pages are
 * `project:view` (`getProjectByKey`): a lens must never be a way round
 * the page that opens it. The inbox withholds a subject on the same
 * pair (`notify/inbox.ts`). Every seeded role holds both; a custom role
 * with only one gets no queue (review, slice 23).
 *
 * SCOPE IS COMPOSED INTO THE QUERY, not asserted per row: an assignment
 * outlives the member's access to its project (a MemberProject row
 * removed, a client unassigned), and a task they can no longer open must
 * fall out of the queue exactly like a deleted one — never render its
 * title. The inbox's subject resolution is the same rule
 * (`notify/inbox.ts`), for the same reason.
 *
 * OPEN means a category someone is still meant to work: BACKLOG, TODO,
 * IN_PROGRESS. DONE and CANCELLED are finished; TRIAGE is a request no
 * one has accepted yet, and is the triage lane's, not a person's queue.
 * An archived task, or any task of an archived project (which the time
 * service already refuses to take entries for), is not work either. An
 * archived CLIENT is not a filter: archiving a client keeps its projects
 * and records live (`clients/service.ts`).
 *
 * No `assertInScope`, no audit: a read of the member's own assignments,
 * narrowed by the scope fragment, touching nothing.
 */

const MY_WORK_OPEN_CATEGORIES = ["BACKLOG", "TODO", "IN_PROGRESS"] as const;

/** The queue's ceiling. Past it the page says so rather than paging a landing page. */
export const MY_WORK_LIMIT = 100;

export type MyWorkEntry = {
  id: string;
  number: number;
  title: string;
  projectKey: string;
  projectName: string;
  stateCategory: string;
  /** RAW — resolve with `resolveRowState` at the page boundary (`ItemListEntry.stateName`). */
  stateName: string | null;
  stateSeedKey: StateSeedKey | null;
  priority: string;
  /** `@db.Date` — UTC midnight of the due day. */
  targetDate: Date | null;
};

export type MyWork = {
  items: MyWorkEntry[];
  /** More open tasks are assigned than `items` holds. */
  truncated: boolean;
};

export async function listMyWork(ctx: WorkCtx, opts?: { limit?: number }): Promise<MyWork | null> {
  const limit = opts?.limit ?? MY_WORK_LIMIT;
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    try {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
    } catch (e) {
      if (e instanceof AuthzError) return null;
      throw e;
    }
    // A core code: no module gate to pass, only the permission.
    if (!(await isAuthorized(tx, ctx.actor, "project:view"))) return null;
    const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "projectId" });
    const rows = await tx.workItem.findMany({
      // COMPOSED WITH `AND`: the scope fragment carries a top-level `OR`,
      // and a spread would let a later key overwrite it (the inbox's
      // page-2 bug, `notify/inbox.ts`).
      where: {
        AND: [
          scope,
          {
            tenantId: ctx.tenantId,
            assigneeMemberId: ctx.actor.memberId,
            deletedAt: null,
            archivedAt: null,
            stateCategory: { in: [...MY_WORK_OPEN_CATEGORIES] },
            project: { archivedAt: null },
          },
        ],
      },
      // Soonest due first, undated last; then the louder priority (the
      // enum is declared NONE → URGENT, so `desc` puts URGENT first);
      // then a stable, readable tie-break.
      orderBy: [
        { targetDate: { sort: "asc", nulls: "last" } },
        { priority: "desc" },
        { project: { key: "asc" } },
        { number: "asc" },
      ],
      take: limit + 1,
      select: {
        id: true,
        number: true,
        title: true,
        stateCategory: true,
        priority: true,
        targetDate: true,
        state: { select: { name: true, seedKey: true } },
        project: { select: { key: true, name: true } },
      },
    });
    const truncated = rows.length > limit;
    return {
      truncated,
      items: rows.slice(0, limit).map((r) => ({
        id: r.id,
        number: r.number,
        title: r.title,
        projectKey: r.project.key,
        projectName: r.project.name,
        stateCategory: r.stateCategory,
        stateName: r.state.name,
        stateSeedKey: r.state.seedKey,
        priority: r.priority,
        targetDate: r.targetDate,
      })),
    };
  });
}
