import { isAuthorized, scopeWhere } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { dateColumn, isoDateOf } from "@/lib/duration";
import type { StateSeedKey } from "@/lib/enum-map";
import { TASK_LIST_CAP, type TaskAssignee, type TaskPersonFilter } from "@/lib/task-list-plan";

import { principalOf, type WorkCtx } from "./states";

/**
 * EVERY TASK IN ONE LIST — the Tasks page's one read (slice 130; founder
 * decision C107 — docs/research/2026-10-17-slice-130-all-tasks-and-lineup-design.md
 * §3.2–§3.3, §4).
 *
 * WHO: `work_item:view` on all four gates, and `project:view` — every row
 * links into a project, and a lens must never be a way round the page that
 * opens it (`listMyWork`'s and `readCalendar`'s pair, for the same reason).
 * Either refused → null: the page draws its forbidden state.
 *
 * WHAT: every OPEN task (BACKLOG, TODO, IN_PROGRESS — `listMyWork`'s set) in
 * the member's SCOPE — composed into the query with `AND`, never spread (the
 * inbox's page-2 bug) — not deleted, not archived, in a project not archived.
 * Subtasks are in: they carry people and dates too. The order is Home's: due
 * day with undated last, then priority, then project key and number.
 *
 * THE FILTERS narrow that set and are found in the same scope: a project key
 * among the projects in scope, a member among the people assigned to the open
 * tasks in scope. Anything else MATCHES NOTHING — an empty list, never an
 * error, and never the whole list (slice 136, the code review's M1: a SAVED
 * VIEW of a person who has since finished their tasks, or of a project since
 * archived, must not show everyone's tasks under its name). Empty says
 * nothing: the list is the member's scope either way, so a project or person
 * beyond their reach and one that does not exist answer alike. The read says
 * which filters it could not find (`projectKnown`, `personKnown`), so the
 * pickers can name them as gone.
 *
 * THE PEOPLE the person picker offers are the members assigned to at least
 * one open task in scope — read from those tasks, so the picker names no one
 * the unfiltered list could not show.
 *
 * Sequential reads on the one transaction (AGENTS.md's `Promise.all` trap).
 * Bounded at `TASK_LIST_CAP` rows. Member-plane only: no portal projection
 * reads this. No audit: a read.
 */

const OPEN_CATEGORIES = ["BACKLOG", "TODO", "IN_PROGRESS"] as const;

export type TaskListEntry = {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly stateCategory: string;
  /** RAW — resolve with the seed key at the page boundary (`MyWorkEntry`'s rule). */
  readonly stateName: string | null;
  readonly stateSeedKey: StateSeedKey | null;
  readonly priority: string;
  /** The due day, `YYYY-MM-DD`, or null. */
  readonly dueOn: string | null;
  readonly assignee: TaskAssignee;
};

export type TaskListRead = {
  readonly entries: readonly TaskListEntry[];
  /** More open tasks matched than `TASK_LIST_CAP`. */
  readonly truncated: boolean;
  /** The projects the filter offers — every one in scope and not archived, by name. */
  readonly projects: readonly { readonly key: string; readonly name: string }[];
  /** The members assigned to at least one open task in scope, in no order (the page sorts them) — the person picker. */
  readonly people: readonly { readonly id: string; readonly name: string }[];
  /** The project filter as asked — kept even when it names no project in scope (it then matches nothing). */
  readonly projectKey: string | null;
  /** False when `projectKey` names no project in `projects`. */
  readonly projectKnown: boolean;
  /** The person filter as asked — a member id is kept even when not among `people` (it then matches nothing). */
  readonly person: TaskPersonFilter | null;
  /** False when `person` names a member not among `people`. */
  readonly personKnown: boolean;
};

export async function listAllTasks(
  ctx: WorkCtx,
  opts: {
    readonly projectKey: string | null;
    readonly person: TaskPersonFilter | null;
    /** The due filter's bounds (`dueBounds`), or null for any day. */
    readonly due: { readonly before: string } | { readonly from: string; readonly to: string } | null;
  },
): Promise<TaskListRead | null> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    try {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
    } catch (e) {
      if (e instanceof AuthzError) return null;
      throw e;
    }
    if (!(await isAuthorized(tx, ctx.actor, "project:view"))) return null;

    const projectScope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "id" });
    const projects = await tx.project.findMany({
      where: { AND: [projectScope, { tenantId: ctx.tenantId, archivedAt: null }] },
      select: { id: true, key: true, name: true },
      orderBy: [{ name: "asc" }, { key: "asc" }],
    });
    // The filter, found among the projects in scope — else it matches nothing.
    const filtered = opts.projectKey === null ? null : (projects.find((p) => p.key === opts.projectKey) ?? null);
    const projectWhere = filtered ? { projectId: filtered.id } : opts.projectKey !== null ? { projectId: { in: [] as string[] } } : {};

    const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "projectId" });
    const open = {
      tenantId: ctx.tenantId,
      deletedAt: null,
      archivedAt: null,
      stateCategory: { in: [...OPEN_CATEGORIES] },
      project: { archivedAt: null },
    };

    // The person picker: the members assigned to the open tasks in scope,
    // whatever the other filters say, so the picker does not change under
    // the member as they narrow the list. GROUP BY in SQL, not Prisma's
    // in-memory `distinct`, which would fetch every row to dedupe it.
    const assigned = await tx.workItem.groupBy({
      by: ["assigneeMemberId"],
      where: { AND: [scope, { ...open, assigneeMemberId: { not: null } }] },
    });
    const ids = assigned.map((a) => a.assigneeMemberId).filter((x): x is string => x !== null);
    const members = ids.length
      ? await tx.member.findMany({
          where: { tenantId: ctx.tenantId, id: { in: ids } },
          select: { id: true, user: { select: { name: true } } },
        })
      : [];
    // In no particular order: the page sorts them with the reader's collator.
    const people = members.map((m) => ({ id: m.id, name: m.user.name }));

    // Kept as asked: a member not among `people` holds no open task in scope,
    // so the filter below matches nothing — which is the answer.
    const person = opts.person;
    const personKnown = person?.kind !== "member" || people.some((p) => p.id === person.id);

    const due = opts.due
      ? "before" in opts.due
        ? { targetDate: { lt: dateColumn(opts.due.before) } }
        : { targetDate: { gte: dateColumn(opts.due.from), lte: dateColumn(opts.due.to) } }
      : {};
    const who =
      person === null
        ? {}
        : person.kind === "me"
          ? { assigneeMemberId: ctx.actor.memberId }
          : person.kind === "none"
            ? { assigneeMemberId: null, assigneeContactId: null }
            : { assigneeMemberId: person.id };

    const rows = await tx.workItem.findMany({
      where: {
        AND: [scope, { ...open, ...projectWhere, ...due, ...who }],
      },
      orderBy: [
        { targetDate: { sort: "asc", nulls: "last" } },
        { priority: "desc" },
        { project: { key: "asc" } },
        { number: "asc" },
      ],
      take: TASK_LIST_CAP + 1,
      select: {
        id: true,
        number: true,
        title: true,
        stateCategory: true,
        priority: true,
        targetDate: true,
        assigneeMemberId: true,
        assigneeContactId: true,
        state: { select: { name: true, seedKey: true } },
        project: { select: { id: true, key: true, name: true } },
        assigneeMember: { select: { user: { select: { name: true } } } },
        // The contact's NAME only — what a board card says about who holds
        // the task (`ItemListEntry`'s note on the pair).
        assigneeContact: { select: { name: true } },
      },
    });

    return {
      entries: rows.slice(0, TASK_LIST_CAP).map((r) => ({
        id: r.id,
        number: r.number,
        title: r.title,
        projectId: r.project.id,
        projectKey: r.project.key,
        projectName: r.project.name,
        stateCategory: r.stateCategory,
        stateName: r.state.name,
        stateSeedKey: r.state.seedKey,
        priority: r.priority,
        dueOn: r.targetDate ? isoDateOf(r.targetDate) : null,
        assignee:
          r.assigneeMemberId && r.assigneeMember
            ? { kind: "member", id: r.assigneeMemberId, name: r.assigneeMember.user.name }
            : r.assigneeContactId && r.assigneeContact
              ? { kind: "contact", id: r.assigneeContactId, name: r.assigneeContact.name }
              : { kind: "none" },
      })),
      truncated: rows.length > TASK_LIST_CAP,
      projects: projects.map((p) => ({ key: p.key, name: p.name })),
      people,
      projectKey: opts.projectKey,
      projectKnown: opts.projectKey === null || filtered !== null,
      person,
      personKnown,
    };
  });
}
