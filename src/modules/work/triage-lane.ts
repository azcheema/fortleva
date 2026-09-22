import { assertInScope, isAuthorized, scopeWhere } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";

import { principalOf, type WorkCtx } from "./states";

/**
 * THE TRIAGE LANE'S READ — MEMBER PLANE, AND THAT IS WHY IT IS NOT IN
 * `triage.ts`.
 *
 * The split is not filing. `triage.ts` sits in
 * `portal-projections.test.ts`'s STRUCTURAL tier, because it authors
 * `triage_reason` — the only string in this product a member writes and
 * a contact reads — and that tier forbids a select-less read and any
 * select naming a column the portal plane may never carry. This read
 * needs two of them: `descriptionText`, the client's own paragraph,
 * which is the entire point of the lane, and `snoozedUntil`.
 *
 * **THE TRIPWIRE WAS RIGHT AND THE FIRST CUT OF THIS FILE WAS WRONG.**
 * The read began inside `triage.ts` and the test failed on exactly those
 * columns (and on a `$queryRaw` that has since gone for its own
 * reasons). The fix is not to widen the never-selected list, and not to
 * drop the file from the tier — both would trade a standing guarantee
 * for one feature's convenience. It is to hear what the failure said: a
 * MEMBER-plane projection and a file feeding the CONTACT plane have
 * different rules, and keeping them in one file means relaxing one of
 * the two. So they are two files, exactly as `portal.ts` (reads, contact
 * principal) and `portal-writes.ts` (writes, system principal) are two
 * files, and for the same reason — **which plane a piece of code serves
 * should be a property of where it lives.**
 *
 * Nothing here crosses to a contact. Every caller is a member page
 * behind `work_item:triage`, and the tenant's own RLS is the floor.
 */

/**
 * How many requests one lane read will return. A cap rather than a
 * pager: a project with more than this many UNANSWERED requests has a
 * process problem rather than a paging problem, and the surface says so
 * (`truncated`) instead of pretending to be complete.
 */
export const TRIAGE_LANE_LIMIT = 100;

/**
 * WHICH ROWS ARE "WAITING FOR AN ANSWER" — the lane's own definition,
 * as one expression, because `/home`'s triage count has to agree with
 * the lane it links to and a copied predicate is a number that drifts.
 *
 * A member who opens the lane from a card saying "3" and finds two rows
 * has been told something false by the surface that exists to tell them
 * the truth about their queue. The two callers differ in how they narrow
 * it — the lane by one `projectId`, the glance by the member's whole
 * scope — so the shared part is exactly this.
 *
 * **AN ARCHIVED PROJECT'S REQUESTS ARE COUNTED, and getting that wrong
 * is what both fresh reviews caught.** The first cut added
 * `project: { archivedAt: null }` at the glance's call site — copying
 * `listMyWork`, and defensible in isolation — which made the two
 * callers disagree in exactly the case that matters most. Follow it
 * through: `archiveProject` leaves child rows untouched, `portal.ts`
 * hides an archived project's tasks from the CLIENT, and this card
 * would then have hidden them from the AGENCY. Two of a client's own
 * requests would have been invisible to everyone but whoever typed the
 * archived project's triage URL — against the one rule this slice
 * family exists to hold, that a client's own request never disappears
 * without a reason. The founder already decided the mirror of this in
 * 6b (an ANSWERED request outlives the archive); an UNANSWERED one owes
 * the same.
 *
 * So the predicate is the whole predicate, at both call sites, and
 * "the card cannot disagree with its lane" is true rather than nearly
 * true. Archiving a project does not discharge the obligation to answer
 * what the client already asked — and the card stops showing it the
 * moment somebody does.
 *
 * `now` is a PARAMETER rather than read inside, so a caller that makes
 * two statements takes its clock once and they cannot disagree about a
 * row whose snooze falls between them (`listTriage` relies on this for
 * its list and its snoozed count).
 *
 * **COMPOSE IT UNDER AN `AND`, NEVER BY SPREADING**, when a scope
 * fragment is involved: that fragment carries a top-level `OR` and so
 * does this, and one would silently replace the other — `my-work.ts`
 * records the same rule and the inbox's page-2 bug that taught it.
 */
export const triageWaitingWhere = (tenantId: string, now: Date) => ({
  tenantId,
  stateCategory: "TRIAGE" as const,
  // REQUESTS, which is what the surface says it shows — see `listTriage`.
  kind: "REQUEST" as const,
  deletedAt: null,
  archivedAt: null,
  // Pending, or snoozed to a moment that has passed. `OR` rather than a
  // negated comparison, because a NULL `snoozedUntil` does not satisfy
  // one and every PENDING row would vanish.
  OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
});

/** One request awaiting an answer, as the lane draws it. */
export type TriageEntry = {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  /**
   * The paragraph the contact typed, as PLAIN TEXT. `createRequest`
   * lands a portal submission in `descriptionText` and leaves
   * `description` NULL on purpose — the editor's schema check runs on
   * the member plane, not the contact's — so this is text, never
   * markup, and the surface renders it as text.
   */
  readonly body: string | null;
  /** The contact who asked, resolved to a name, or null when a member filed it. */
  readonly reportedBy: string | null;
  readonly createdAt: Date;
  /** Set only on a row that was snoozed and has since come due. */
  readonly snoozedUntil: Date | null;
};

export type TriageLane = {
  readonly entries: readonly TriageEntry[];
  /** True when `TRIAGE_LANE_LIMIT` cut the list short. */
  readonly truncated: boolean;
  /**
   * How many requests are snoozed to a moment still in the future — the
   * ones this list deliberately does NOT show.
   *
   * It is here because a lane that silently hides rows is a lane that
   * loses them: a member who snoozed something in March must be able to
   * see, in April, that the project has three requests parked rather
   * than none. The lane renders it as a line of text, not as rows.
   */
  readonly snoozedCount: number;
  /**
   * Whether this member may END a request — Decline or Duplicate, the
   * two verbs that publish the agency's words to the client
   * (`work_item:triage_decline`, C M; founder decision 2026-09-22).
   *
   * It rides with the READ because the surface must not offer a verb
   * that will be refused: §3.1's rule is that a permission-gated control
   * is HIDDEN, not disabled, and a button that always toasts a refusal
   * is worse than no button. `triageItem` re-checks server-side
   * regardless — hiding is never the guard.
   */
  readonly canDecline: boolean;
};

/**
 * THE LANE: every request in this project still waiting for an answer,
 * oldest first.
 *
 * **OLDEST FIRST, AND NOT BY `rank`.** Every other work surface orders
 * by rank because position IS importance there (plan §3.1). A triage
 * lane is a QUEUE: the thing a client has been waiting longest for is
 * the thing that most needs an answer, and rank would let an unanswered
 * request sink out of sight without anyone deciding to put it there.
 * Nothing in the product writes a rank that means anything for a row in
 * triage anyway — `createRequest` appends at the bottom.
 *
 * **GATED ON `work_item:triage`, WHICH IS THE WRITE VERB**, and that is
 * deliberate rather than sloppy. The lane is the verb's surface: a
 * member who cannot answer a request has nothing to do here, and the
 * requests themselves are not hidden from them — they appear in the
 * board's TRIAGE column under `work_item:view` like any other card. So
 * this gate governs the SURFACE, not the information, and nothing is
 * concealed by it that a viewer could not reach one tab away.
 *
 * SNOOZED ROWS ARE EXCLUDED WHILE THEIR MOMENT IS IN THE FUTURE, and
 * COUNTED instead. A lane that silently hid rows would be a lane that
 * lost them: a member who parked something in March must be able to see,
 * in April, that the project has three requests waiting rather than
 * none. The count is a line of text, not rows.
 */
export async function listTriage(ctx: WorkCtx, projectId: string): Promise<TriageLane> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:triage");
    await assertInScope(tx, ctx.actor, { projectId });
    // Gate 4 only, and that is the right helper here: `requireAccess`
    // above has already run all four for this module, so the only
    // question left is whether this member holds the second code.
    const canDecline = await isAuthorized(tx, ctx.actor, "work_item:triage_decline");

    // The project's own client, for the contact lookup below. Read
    // under the member principal after the scope assertion, so it is a
    // project this member may see.
    const project = await tx.project.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: projectId },
      select: { clientId: true },
    });
    const { clientId } = project;

    // ONE `now` for the whole read, taken once so the list and the
    // count below cannot disagree about a row whose moment falls between
    // two statements. It is the SERVER's clock and not the database's:
    // `snoozedUntil` was written by this same application from a
    // member's choice, so both ends of the comparison already come from
    // app clocks and a `SELECT now()` would add a round trip, a raw
    // query and no accuracy.
    const now = new Date();

    const rows = await tx.workItem.findMany({
      // **THE SHARED PREDICATE**, narrowed to this project. `/home`'s
      // triage count uses the same expression narrowed to the member's
      // scope instead, which is what keeps the card's number and this
      // list from ever disagreeing. Nothing but `createRequest` can put
      // a row in a TRIAGE state today, so the `kind` term is a belt —
      // but the lane's copy reads "Requests your client has sent" and
      // each row is bylined "From …", and two of the four verbs (ACCEPT,
      // SNOOZE) would happily run on a non-request while the other two
      // refuse it. A read that matches the surface it feeds cannot drift
      // into showing rows whose verbs half work.
      where: { ...triageWaitingWhere(ctx.tenantId, now), projectId },
      select: {
        id: true,
        number: true,
        title: true,
        descriptionText: true,
        reportedByContactId: true,
        createdAt: true,
        snoozedUntil: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: TRIAGE_LANE_LIMIT + 1,
    });

    const truncated = rows.length > TRIAGE_LANE_LIMIT;
    const page = truncated ? rows.slice(0, TRIAGE_LANE_LIMIT) : rows;

    // ONE read for every reporter, not one per row. `reportedByContactId`
    // carries no foreign key (it is attribution — `requests.ts`), so
    // there is no relation to include and the names are resolved by id.
    //
    // **SCOPED TO THE PROJECT'S OWN CLIENT, not merely to the tenant.**
    // With no FK, nothing in the database ties a row's reporter to its
    // client: only `portal-writes.ts` writes the column and it pins the
    // project to the contact's client first, so a mismatch cannot occur
    // today — but that is an inference about one call site, not a
    // property of this read. The `clientId` term makes "a member only
    // ever learns the names of this client's contacts here" true by
    // construction, and costs nothing (security review).
    const contactIds = [...new Set(page.map((r) => r.reportedByContactId).filter((id) => id !== null))];
    const contacts =
      contactIds.length === 0
        ? []
        : await tx.contact.findMany({
            where: { tenantId: ctx.tenantId, clientId, id: { in: contactIds } },
            select: { id: true, name: true },
          });
    const nameOf = new Map(contacts.map((c) => [c.id, c.name]));

    const snoozedCount = await tx.workItem.count({
      where: {
        tenantId: ctx.tenantId,
        projectId,
        stateCategory: "TRIAGE",
        // The same `kind` term as the list, or the count would describe
        // a different set from the one it sits under.
        kind: "REQUEST",
        deletedAt: null,
        archivedAt: null,
        snoozedUntil: { gt: now },
      },
    });

    return {
      entries: page.map((r) => ({
        id: r.id,
        number: r.number,
        title: r.title,
        body: r.descriptionText,
        // A contact that has since been deleted resolves to null rather
        // than to a blank name: "somebody asked for this" is true and
        // an empty byline is not.
        reportedBy: r.reportedByContactId === null ? null : (nameOf.get(r.reportedByContactId) ?? null),
        createdAt: r.createdAt,
        snoozedUntil: r.snoozedUntil,
      })),
      truncated,
      snoozedCount,
      canDecline,
    };
  });
}

/** The most projects `/home`'s triage card draws as rows. */
export const TRIAGE_GLANCE_PROJECTS = 5;

/** One project with requests waiting, as the card draws it. */
export type TriageGlanceProject = {
  readonly projectKey: string;
  readonly projectName: string;
  readonly count: number;
};

export type TriageGlance = {
  /**
   * EVERY waiting request the member's scope reaches — never just the
   * ones in `projects` below, and an archived project's included (see
   * `triageWaitingWhere`: archiving does not discharge the obligation
   * to answer).
   *
   * IT IS UNCAPPED WHERE THE LANE IS NOT: `listTriage` stops at
   * `TRIAGE_LANE_LIMIT` rows and says `truncated`, so a project with
   * 137 waiting shows 137 here over a lane drawing 100. That is the
   * right way round — the card's job is to say how much is owed, and
   * the lane's is to be usable — but it is the one sense in which
   * "the card says what the lane will show" is bounded. The heading says this number and the rows
   * may be a subset of it, which is the opposite of the queue's rule
   * (its group counts are of the rows shown, because its cap cuts from
   * the END of an ordered list and a count of the rest would be a
   * number nobody could act on). Here the cap cuts PROJECTS off a
   * grouped total that is already exact, so saying the true total costs
   * nothing and hiding it would understate a backlog.
   */
  readonly total: number;
  /** The busiest projects first, at most `TRIAGE_GLANCE_PROJECTS`. */
  readonly projects: readonly TriageGlanceProject[];
  /** Projects with waiting requests that `projects` does not name. */
  readonly moreProjects: number;
};

/**
 * `/home`'s TRIAGE COUNT (UI.md rule 8) — how many client requests are
 * waiting for an answer, across every project this member's scope
 * reaches, grouped by project.
 *
 * **IT WAITED FOR A WRITER SINCE 2W AND NOW HAS ONE.** `home/page.tsx`
 * carried a comment saying this card and "waiting on client" were
 * absent on purpose, because nothing could put a task in either — a
 * card whose number is always zero is 110px of a phone screen spent
 * saying nothing. Slice 6a's intake gave `triageStatus` its writer and
 * 6b gave the lane somewhere to send people, so this half arrives now;
 * the other half waits for a member-side surface that lists
 * contact-assigned work, which is slice 6c's second commit.
 *
 * **PER PROJECT, BECAUSE THE LANE IS PER PROJECT.** `/projects/[key]/triage`
 * is the only place a request can be answered, so a single tenant-wide
 * number would be a count with nowhere to go — and §5.8's rule is that
 * a surface offers the verb that changes what it shows. Each row is one
 * link to one lane, the queue row's shape.
 *
 * **GATED ON `work_item:triage`, THE LANE'S OWN CODE**, and on
 * `project:view` besides. The first is because this card is a way INTO
 * the lane and a card offering a tab that is hidden is a card offering
 * a 404; the second is the queue's rule verbatim — a row names a
 * project and links into it, so without the code that opens the page
 * there is no card (`getProjectByKey` is `project:view`). Every seeded
 * role that holds one holds the other; a custom role with only
 * `work_item:triage` gets no card and loses nothing it could have used.
 *
 * **GATED, NOT THROWN**, exactly as `listMyWork` is: `/home` is every
 * member's landing page and a member without the code is not an error
 * there. The read answers `null` and the page draws nothing.
 *
 * **SCOPE IS COMPOSED INTO THE QUERY**, never asserted per row — the
 * same rule and the same reason as the queue's: a request in a project
 * this member can no longer open must not put a number on their home
 * page, still less the project's name. `AND`, not a spread: both
 * fragments carry a top-level `OR`.
 */
export async function triageGlance(ctx: WorkCtx): Promise<TriageGlance | null> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    try {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:triage");
    } catch (e) {
      if (e instanceof AuthzError) return null;
      throw e;
    }
    // A core code: no module gate left to pass, only the permission.
    if (!(await isAuthorized(tx, ctx.actor, "project:view"))) return null;

    const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "projectId" });
    // THE SAME SCOPE, SPELLED FOR THE `project` TABLE, and it is what
    // makes the name lookup below safe BY CONSTRUCTION rather than by an
    // invariant enforced one layer away. A security review traced the
    // scope-less version clean — the ids can only come from the
    // narrowed grouping, and `work_item.client_id` is derived from the
    // project at insert and frozen by `work_item_no_move` — and then
    // observed that the argument is two call sites and a trigger away
    // from this read. `listTriage` already learned this lesson for its
    // contact lookup (bound to the project's own client, a few lines
    // down). A second scope fragment costs one resolved scope, already
    // memoised for this transaction, and removes the need to be right
    // about anything else.
    const projectScope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "id" });
    // ONE clock for the whole read, the lane's rule: the grouping and
    // the project lookup below are two statements, and a row whose
    // snooze expires between them must not be in one and out of the
    // other.
    const now = new Date();
    // GROUPED IN SQL rather than counted in JS: the alternative reads
    // every waiting row of every project this member can see onto the
    // landing page to throw away all but a number.
    const groups = await tx.workItem.groupBy({
      by: ["projectId"],
      where: { AND: [scope, triageWaitingWhere(ctx.tenantId, now)] },
      _count: { _all: true },
    });
    if (groups.length === 0) return { total: 0, projects: [], moreProjects: 0 };

    // The total is of EVERY group, before the cap — see the type.
    const total = groups.reduce((n, g) => n + g._count._all, 0);
    // Busiest first, then by project id so a tie is stable between
    // renders rather than left to the database's row order.
    const ranked = [...groups].sort(
      (a, b) => b._count._all - a._count._all || a.projectId.localeCompare(b.projectId),
    );
    const top = ranked.slice(0, TRIAGE_GLANCE_PROJECTS);
    // Names for the rows the card will draw, and only those: a member
    // with forty projects in triage pays for five lookups.
    const named = await tx.project.findMany({
      where: { AND: [projectScope, { tenantId: ctx.tenantId, id: { in: top.map((g) => g.projectId) } }] },
      select: { id: true, key: true, name: true },
    });
    const byId = new Map(named.map((p) => [p.id, p]));

    // A group whose project did not come back is DROPPED rather than
    // rendered nameless, and a `?? ""` would put a link to nowhere on
    // the member's landing page. It is dropped from the ROWS and kept in
    // `total`, which is the honest pair: the work exists, this card just
    // cannot address it. With the scope fragment above it should not
    // arise — but "should not" is the whole reason the branch is here
    // rather than a non-null assertion, and it degrades toward saying
    // LESS, which is the direction a landing page should fail in.
    const projects = top.flatMap((g) => {
      const p = byId.get(g.projectId);
      return p ? [{ projectKey: p.key, projectName: p.name, count: g._count._all }] : [];
    });

    return { total, projects, moreProjects: ranked.length - projects.length };
  });
}
