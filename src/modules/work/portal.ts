import { authorizePortal, withPortalRead, type PortalPrincipal } from "@/portal";

/**
 * THE WORK MODULE'S PORTAL PROJECTIONS — READS ONLY.
 *
 * This is the file the Phase 3 decision memo calls the place the danger
 * concentrates (§2.2), and the reason is worth restating at the top of
 * it rather than in a doc: a projection is the last thing standing
 * between a tenant's internal rows and a stranger's browser, and it is
 * the one layer the database cannot help with. RLS decides which ROWS a
 * contact may read; only this file decides which COLUMNS of those rows
 * leave the building.
 *
 * FOUR RULES, each with a test that fails when it is broken:
 *
 *  1. **Every read runs under the CONTACT principal**, never a system
 *     one — `withPortalRead`, whose whole purpose is to make that a call
 *     rather than a convention (TENANCY.md §7.2). Brokered WRITES are a
 *     later slice and live in `portal-writes.ts`, so "this code runs as
 *     system" stays a property of a filename.
 *  2. **Every select is an explicit allow-list.** No `include`, no
 *     `omit`, no select-less read — `src/authz/portal-projections.test.ts`
 *     parses this file and fails on any of the three. That is the memo's
 *     over-honouring of the pin (§2.2): a forbidden-COLUMN list cannot
 *     know about an internal column somebody adds next year, and an
 *     allow-list can.
 *  3. **Nothing that is not on UI.md §11's "shown to a contact" side.**
 *     Categories, never state names; no estimate, no ordering weight, no
 *     label, no link, no member name, no internal note. The forbidden-columns
 *     grep is the belt; the allow-list above is the braces.
 *  4. **The shape that leaves here is the shape the page renders.** No
 *     row object, no Prisma model, nothing with a `tenantId` on it — a
 *     projection that returns the row and trusts the page to pick is a
 *     projection whose safety property lives in a `.tsx` file.
 *
 * `portal.dbtest.ts` next door is the "no INTERNAL fact to a Contact"
 * fixture suite the pins require in the same commit as each feature.
 */

/**
 * The portal's vocabulary for where a task is — the ONLY state fact a
 * contact ever sees (UI.md rule 5, §11). It is deliberately not
 * `StateCategory`: that enum is the tenant's internal one, its names are
 * engineering words ("BACKLOG", "TRIAGE"), and mapping here rather than
 * in the page is what keeps the two from drifting.
 *
 * FOUR VALUES, not the table's three, because §11 gives two different
 * lists and both are right: the row of the table says "Planned / In
 * progress / Done", and the copy rule two lines below it says a business
 * reader is told "Requested", never "triage". A portal REQUEST that has
 * not been triaged yet is the client's OWN submission, so it is the one
 * thing in the list they already know about, and calling it "Planned"
 * would promise something nobody has agreed to. The request-intake slice
 * inherits this value already spelled.
 *
 * CANCELLED HAS NO PORTAL CATEGORY AND IS NOT SHOWN, which is a product
 * decision and not an oversight. Mapping it onto `DONE` would tell a
 * client that something they can see was finished when it was dropped —
 * a misrepresentation, in the one surface a client reads as a promise —
 * and a fifth "Cancelled" heading is a word §11's vocabulary does not
 * have.
 *
 * **AND IT BITES HARDEST ON THE CLIENT'S OWN REQUEST**, which a review
 * sharpened and which is the version the founder should decide on:
 * DATA_MODEL §6.14 pins triage `DECLINED` and `DUPLICATE` to a
 * CANCELLED-category state, so the one row on this list the client
 * SUBMITTED THEMSELVES disappears silently the moment the agency says
 * no. "Hidden" is a defensible answer for a task the client never asked
 * for and an indefensible one for a request they did. The request-intake
 * slice owns the fix (most likely a DECLINED portal category with the
 * agency's reason attached); until then this is recorded in PLAN §0
 * rather than buried here.
 */
export const PORTAL_TASK_CATEGORIES = ["REQUESTED", "PLANNED", "IN_PROGRESS", "DONE"] as const;

export type PortalTaskCategory = (typeof PORTAL_TASK_CATEGORIES)[number];

/**
 * Internal category → portal category. A total map over the enum, so a
 * new `StateCategory` value is a compile error here rather than a row
 * that quietly vanishes from (or appears in) a client's list.
 * `CANCELLED` maps to `null`: excluded, per the note above.
 */
const PORTAL_CATEGORY: Record<
  "BACKLOG" | "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "TRIAGE",
  PortalTaskCategory | null
> = {
  TRIAGE: "REQUESTED",
  BACKLOG: "PLANNED",
  TODO: "PLANNED",
  IN_PROGRESS: "IN_PROGRESS",
  DONE: "DONE",
  CANCELLED: null,
};

/**
 * One shared task, as a contact sees it. Nothing is here "because the
 * row had it": the title, the category and the phase are §11's table
 * outright, and the two dates are what its "timeline" line implies — §11
 * names neither `targetDate` nor `completedAt` explicitly, so they are a
 * READING of it rather than a quotation, and a reviewer was right to
 * want that said. An agreed deadline and a completion date are the two
 * things a client asks for by email when a portal does not show them.
 *
 * `id` is not a neutral opaque handle either, and it is worth knowing:
 * it is a UUIDv7, so its first 48 bits are the row's creation time in
 * milliseconds. `createdAt` is deliberately not selected, but creation
 * time ships with every row regardless. That is not an INTERNAL fact —
 * when a task was created is not something §11 withholds — but "we did
 * not select it" is not the same as "it is not there".
 */
export type PortalTask = {
  readonly id: string;
  readonly title: string;
  readonly category: PortalTaskCategory;
  /** The agreed day, when there is one. A `@db.Date` — format with `formatDay`. */
  readonly targetDate: Date | null;
  /** When it was finished. Only ever set on a `DONE` row. */
  readonly completedAt: Date | null;
  /**
   * The milestone's NAME, or null — resolved by the same contact-
   * principal read, so an INTERNAL milestone on a shared task comes back
   * null and its name never crosses the plane. §11 calls this a "Phase".
   */
  readonly phase: string | null;
};

/** The shared tasks of one project. */
export type PortalProjectTasks = {
  readonly projectId: string;
  readonly projectName: string;
  readonly tasks: readonly PortalTask[];
};

export type PortalTaskList = {
  readonly projects: readonly PortalProjectTasks[];
  /**
   * How many tasks are IN this answer — never "how many the client has".
   * When `truncated` is true it is exactly `PORTAL_TASK_LIMIT`. Named
   * `shown` rather than `total` because a reviewer pointed out that
   * `total` invites the next caller to render it as "you have N tasks",
   * which would be a number the projection never computed.
   */
  readonly shown: number;
  /** True when `PORTAL_TASK_LIMIT` cut the list short. */
  readonly truncated: boolean;
};

/**
 * The most tasks one portal read will return. A cap rather than a pager
 * in this slice: the page renders a flat list per project, and a client
 * with more than this many shared tasks is a signal about the tenant's
 * sharing settings rather than a paging problem. Paging lands with the
 * one-screen project page.
 */
export const PORTAL_TASK_LIMIT = 200;

/**
 * THE CLIENT-VISIBLE TASK LIST — the portal's first projection.
 *
 * Every shared task of every portal-enabled project of the contact's own
 * client, grouped by project. The grouping is done here rather than in
 * the page because the ORDER is part of the projection's contract (see
 * below) and a page that re-sorted would silently change what the
 * fixtures assert.
 *
 * ORDERING, AND WHY IT IS NOT `rank`. `rank` is the obvious key — it is
 * what the backlog and the board order by — and it is exactly the wrong
 * one here: the plan pins position AS importance (§3.1, UI.md rule 5),
 * and importance is on §11's never-shown list under the name this file
 * may not spell. Ordering a client's list by rank would publish the
 * team's internal ranking of their work without ever naming a forbidden
 * column — and without the grep noticing, because `rank` is not one.
 * So the order is the two facts the contact can already see — the agreed
 * day, soonest first, undated last — with the row id (UUIDv7,
 * creation-ordered) as the tie-break that makes the list stable between
 * renders.
 *
 * FLAT, AND EVERY TYPE. An Epic, a Task and a Subtask that are all
 * shared come back as three rows side by side, because the hierarchy is
 * the agency's way of organising its work and "epic" is a word §11's
 * copy rule forbids. Indenting them would mean projecting `type`, which
 * would put that vocabulary on a client's screen in the only place it
 * could possibly show. A client reads a list of things; the tree stays
 * inside.
 *
 * WHAT THE `where` DOES AND DOES NOT DO. The tenant, the client, the
 * visibility and the project's portal switch are all decided by
 * `portal_gate` under the contact principal — they are repeated in the
 * filter as defence in depth, never as the gate. What is NOT in the
 * policy and therefore must be here: `deletedAt` (a soft-deleted row is
 * still a row), the item's `archivedAt`, the `CANCELLED` exclusion —
 * and the PROJECT's archive, which the first cut of this file missed
 * and a review caught.
 *
 * **ARCHIVING A PROJECT DOES NOT TURN ITS PORTAL OFF, IN THE DATABASE.**
 * `project`'s `portal_gate` is `client_id = app.client_id AND
 * portal_enabled` — no archive term (migration 20260816180000) — and
 * `archiveProject` sets `status`/`archivedAt` while leaving
 * `portalEnabled` TRUE. So an agency that archives a finished project
 * and moves on would have gone on publishing its task list to that
 * client indefinitely, with nothing on the member side showing that it
 * was still live. Filtered HERE rather than in a policy because it is a
 * projection decision and reversible: the tenant's data is unchanged and
 * flipping the project back un-hides it. Flagged for the founder in
 * PLAN §0 — if archiving should NOT hide shared work, this line is the
 * one to delete.
 */
export async function listPortalTasks(principal: PortalPrincipal): Promise<PortalTaskList> {
  return withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.work_item.view");

    const rows = await tx.workItem.findMany({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        visibility: "CLIENT_VISIBLE",
        portalEnabled: true,
        deletedAt: null,
        archivedAt: null,
        stateCategory: { not: "CANCELLED" },
        // See the header: `project.portal_gate` has no archive term.
        project: { archivedAt: null },
      },
      select: {
        id: true,
        title: true,
        stateCategory: true,
        targetDate: true,
        completedAt: true,
        project: { select: { id: true, name: true } },
        milestone: { select: { name: true } },
      },
      orderBy: [{ targetDate: { sort: "asc", nulls: "last" } }, { id: "asc" }],
      take: PORTAL_TASK_LIMIT + 1,
    });

    const truncated = rows.length > PORTAL_TASK_LIMIT;
    const page = truncated ? rows.slice(0, PORTAL_TASK_LIMIT) : rows;

    // Grouped in insertion order, which is the row order above, so the
    // projects come out in the order their soonest task does. A project
    // whose row came back without its `project` relation cannot happen
    // under this policy set (the item's gate is strictly narrower than
    // the project's), but it is DROPPED rather than rendered nameless:
    // a task with no project on a client's screen is a task they cannot
    // place, and a `?? ""` would put one there.
    const byProject = new Map<string, { projectName: string; tasks: PortalTask[] }>();
    for (const row of page) {
      const category = PORTAL_CATEGORY[row.stateCategory];
      const project = row.project;
      if (!category || !project) continue;
      let group = byProject.get(project.id);
      if (!group) {
        group = { projectName: project.name, tasks: [] };
        byProject.set(project.id, group);
      }
      group.tasks.push({
        id: row.id,
        title: row.title,
        category,
        targetDate: row.targetDate,
        completedAt: row.completedAt,
        phase: row.milestone?.name ?? null,
      });
    }

    const projects = [...byProject].map(([projectId, group]) => ({
      projectId,
      projectName: group.projectName,
      tasks: group.tasks,
    }));

    return {
      projects,
      shown: projects.reduce((n, p) => n + p.tasks.length, 0),
      truncated,
    };
  });
}
