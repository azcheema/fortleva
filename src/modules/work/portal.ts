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
 * FIVE VALUES, not the table's three, because §11 gives two different
 * lists and both are right: the row of the table says "Planned / In
 * progress / Done", and the copy rule two lines below it says a business
 * reader is told "Requested", never "triage". A portal REQUEST that has
 * not been triaged yet is the client's OWN submission, so it is the one
 * thing in the list they already know about, and calling it "Planned"
 * would promise something nobody has agreed to.
 *
 * A CANCELLED TASK IS STILL NOT SHOWN — mapping it onto `DONE` would
 * tell a client that something they can see was finished when it was
 * dropped, a misrepresentation in the one surface a client reads as a
 * promise, and a "Cancelled" heading is a word §11's vocabulary does
 * not have.
 *
 * **BUT A CANCELLED REQUEST IS**, and that is the fifth value. This
 * file's previous header called the alternative indefensible and handed
 * the question to the founder; it was decided on 2026-09-22:
 * DATA_MODEL §6.14 pins triage `DECLINED` and `DUPLICATE` to a
 * CANCELLED-category state, so under the old rule the one row on this
 * list the client SUBMITTED THEMSELVES vanished silently the moment the
 * agency said no. "Hidden" is a defensible answer for a task the client
 * never asked for and an indefensible one for a request they did. So a
 * request that was cancelled comes back as `DECLINED`, carrying
 * `declinedReason` — the agency's own words, which `modules/work/triage.ts`
 * requires and `work_item_triage_reason_iff_outcome` makes unskippable.
 *
 * DECLINED IS LAST IN THIS ARRAY AND THAT IS PART OF THE CONTRACT: the
 * page renders the categories in exactly this order
 * (`portal/task-list.tsx`), so an answered-no request sits at the foot
 * of its project card rather than among live work.
 */
export const PORTAL_TASK_CATEGORIES = [
  "REQUESTED",
  "PLANNED",
  "IN_PROGRESS",
  "DONE",
  "DECLINED",
] as const;

export type PortalTaskCategory = (typeof PORTAL_TASK_CATEGORIES)[number];

/**
 * Internal category → portal category. A total map over the enum, so a
 * new `StateCategory` value is a compile error here rather than a row
 * that quietly vanishes from (or appears in) a client's list.
 *
 * **`CANCELLED`'S ENTRY IS NEVER READ** since slice 6b — `portalCategory`
 * below answers that case before it consults this map. It is not dead
 * code: the `Record` is what makes the map TOTAL over `StateCategory`,
 * and totality is the whole reason this table exists rather than a
 * `switch` with a default. Deleting the key would break the type; the
 * `null` is what it would have meant.
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
 * The map above, plus the one exception the founder decided on
 * 2026-09-22: a cancelled REQUEST is shown as DECLINED rather than
 * hidden, because the row a client submitted themselves must never
 * vanish without an answer.
 *
 * **ITS PRECONDITION IS THE `where`, AND THAT IS NOT A SHORTCUT.** This
 * function maps `CANCELLED` to `DECLINED` unconditionally, so it is
 * correct only for rows `listPortalTasks` selected — and that query
 * admits a cancelled row ONLY when it is a `kind = REQUEST` that
 * CARRIES A REASON. Two reasons it is arranged this way round rather
 * than with the tests inlined here:
 *
 *  · `kind` is on `portal-projections.test.ts`'s NEVER-SELECTED list —
 *    it is the agency's vocabulary for its own process — and that list
 *    is worth more absolute than this function is worth self-contained.
 *    The tripwire caught the first cut of this file doing exactly that.
 *  · Filtering in the query means a cancelled TASK or BUG never leaves
 *    Postgres at all, which is strictly stronger than dropping it in a
 *    loop somebody could later edit.
 *
 * `portal.dbtest.ts` pins all three cases from the outside: a cancelled
 * ordinary task stays invisible, a cancelled request WITH a reason comes
 * back DECLINED, and a cancelled request WITHOUT one stays invisible
 * too. Change any of them and those fixtures fail.
 *
 * **THE REASON TERM IS A FAIL-SAFE, AND IT EXISTS BECAUSE THE FIRST CUT
 * OF THIS SLICE SHIPPED WITHOUT IT.** Two independent reviews found the
 * same hole: the write path guarded only a DIRECT move out of TRIAGE,
 * so an accepted request dropped weeks later — an entirely ordinary
 * workflow — arrived here cancelled with nothing to say, and this
 * function announced "Declined" in the agency's name with a blank under
 * it. `transitionState` now refuses that move for any REQUEST, so the
 * column should never be null here; this term is what makes the
 * PROJECTION refuse to publish a decline it cannot explain, whatever a
 * writer does or a pre-6b row already holds. Two layers, because being
 * wrong here is paid for by the client rather than by us.
 *
 * WHY THE TERM IS `triageReason` AND NOT `triageStatus`: the CHECK
 * `work_item_triage_reason_iff_outcome` makes them equivalent, so this
 * states the requirement the RENDER actually has — "I will only publish
 * an answer I can show" — rather than a proxy for it. And why not
 * `reportedByContactId IS NOT NULL`: that would hide a request a MEMBER
 * filed on the client's behalf after a phone call, which the client
 * should still be told was dropped.
 *
 * DUPLICATE AND DECLINED ANSWER IDENTICALLY, which is deliberate. "We
 * are already tracking this" is what the agency's reason says; the
 * portal does not get a sixth heading for it, and `duplicateOfId` is
 * never projected — the row it points at may be INTERNAL, and a link
 * from a client's screen to a task they cannot read is a leak that
 * announces itself.
 */
const portalCategory = (
  stateCategory: keyof typeof PORTAL_CATEGORY,
): PortalTaskCategory | null =>
  stateCategory === "CANCELLED" ? "DECLINED" : PORTAL_CATEGORY[stateCategory];

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
  /**
   * WHY THE AGENCY SAID NO — set on, and only on, a `DECLINED` task.
   *
   * The one piece of free text on this plane written by a MEMBER and
   * read by a CONTACT. Everything else the projection returns is either
   * the client's own words coming back (`title` on a request they
   * submitted) or something the agency already publishes: a date, a
   * category, a milestone name. A member writing here is writing to
   * their client, and the member-side UI says so.
   *
   * Never null on a `DECLINED` row and always null on every other, and
   * BOTH halves are enforced rather than hoped for. The first is the
   * projection's `triageReason: { not: null }` term: a cancelled
   * request with no answer is not returned at all, so a `DECLINED`
   * category cannot be built over a null. The second is the projection's
   * own `null` below, which gates on the CATEGORY rather than on the
   * column being set, so a reason that somehow attached to a live task
   * still never ships. `portal.dbtest.ts` drives both.
   */
  readonly declinedReason: string | null;
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
 * Narrowing, and the ONE caller that needs it is on the MEMBER plane.
 *
 * `/portal` asks for everything the contact's client has been shared and
 * passes nothing here. The Portal tab's "what the client sees" preview
 * (Phase 3 slice 4) renders ONE project, through this same function
 * under a synthesised contact principal — the arrangement SECURITY.md
 * §5.1 requires, because "a separate preview renderer is how previews
 * lie".
 *
 * IT IS A NARROWING AND NOT A CONVENIENCE. A member's own scope can be a
 * single project (`MemberProject`), while a contact's is the whole
 * client, so an unnarrowed call would materialise the names and titles
 * of that client's OTHER projects inside a render the member may have no
 * scope for. Filtering the answer afterwards would leave those rows in
 * the process; filtering the query means they never leave Postgres.
 *
 * WHAT IT COSTS, stated rather than discovered later: `PORTAL_TASK_LIMIT`
 * then applies to the one project rather than to the whole list, so a
 * client whose list is truncated across projects can see a task in the
 * preview that their own `/portal` cuts off. The preview is per project
 * by definition and the cap is a signal about sharing settings rather
 * than a pager (see the constant), so this is accepted, not overlooked.
 */
export type PortalTaskListOptions = {
  /** Restrict the read to one project of the contact's own client. */
  readonly projectId?: string;
};

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
 * still a row), the item's `archivedAt`, the `CANCELLED` exclusion and
 * its one REQUEST-shaped exception — and the PROJECT's archive, which
 * the first cut of this file missed and a review caught.
 *
 * WHAT `portal_gate` DOES NOT DO, restated because a reader of this
 * `where` will wonder: it has **no `reported_by_contact_id` term**, so
 * every ACTIVE contact of a client reads every request that client
 * submitted, not only their own. That is a founder decision of
 * 2026-09-22 and not an oversight — a `Client` is a company, the
 * agency's counterparty is the company, and a request only its
 * submitter can see is orphaned the day they leave. Making it private
 * would be a change to the POLICY, not to this projection.
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
export async function listPortalTasks(
  principal: PortalPrincipal,
  opts?: PortalTaskListOptions,
): Promise<PortalTaskList> {
  const projectId = opts?.projectId;
  return withPortalRead(principal, async (tx) => {
    await authorizePortal(
      tx,
      principal,
      "portal.work_item.view",
      // A narrowed read names its resource, so steps 3–4 of the pipeline
      // run: the project must be reachable under `portal_gate`, which is
      // client ownership AND `portal_enabled`. An unnarrowed list names
      // none, because every row it returns is gated individually and
      // inventing a ref would be theatre (`PortalScopeRef`).
      projectId ? { kind: "project", projectId } : undefined,
    );

    const rows = await tx.workItem.findMany({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        visibility: "CLIENT_VISIBLE",
        portalEnabled: true,
        deletedAt: null,
        archivedAt: null,
        // CANCELLED IS STILL EXCLUDED — except for a REQUEST that
        // carries the agency's answer, which is shown as DECLINED with
        // that reason.
        //
        // **THIS CLAUSE IS `portalCategory`'S PRECONDITION**, not a
        // convenience: that function maps CANCELLED to DECLINED with no
        // second test, because these two terms guarantee that a
        // cancelled TASK or BUG — and a cancelled request nobody
        // explained — never leaves Postgres. Loosening either without
        // the other would put "Declined" on a client's screen against
        // work they never asked for, or against work they did ask for
        // with no answer under it. `kind` is filtered here and never
        // SELECTED — it is on the portal plane's never-selected list —
        // which is also why the test lives in `portal.dbtest.ts` rather
        // than in a unit test over the mapper.
        OR: [
          { stateCategory: { not: "CANCELLED" } },
          { stateCategory: "CANCELLED", kind: "REQUEST", triageReason: { not: null } },
        ],
        // See the header: `project.portal_gate` has no archive term.
        project: { archivedAt: null },
        ...(projectId ? { projectId } : {}),
      },
      select: {
        id: true,
        title: true,
        stateCategory: true,
        triageReason: true,
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
      // Safe BECAUSE of the `where` above — a cancelled row that is not
      // a REQUEST never reaches this loop. See `portalCategory`.
      const category = portalCategory(row.stateCategory);
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
        // GATED ON THE CATEGORY, never on the column being set. The
        // column cannot be set on anything but a DECLINED/DUPLICATE row
        // (the CHECK), so today these agree — and if a later writer
        // ever put a reason on a live task, this line is what keeps it
        // off the client's screen rather than the constraint being the
        // only thing between them.
        declinedReason: category === "DECLINED" ? row.triageReason : null,
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
