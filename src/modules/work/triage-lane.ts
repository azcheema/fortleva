import { assertInScope, isAuthorized } from "@/authz/authorize";
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
      where: {
        tenantId: ctx.tenantId,
        projectId,
        stateCategory: "TRIAGE",
        // **REQUESTS, WHICH IS WHAT THE SURFACE SAYS IT SHOWS.** Nothing
        // but `createRequest` can put a row in a TRIAGE state today, so
        // this is a belt — but the lane's copy reads "Requests your
        // client has sent" and each row is bylined "From …", and two of
        // the four verbs (ACCEPT, SNOOZE) would happily run on a
        // non-request while the other two refuse it. A read that matches
        // the surface it feeds cannot drift into showing rows whose
        // verbs half work.
        kind: "REQUEST",
        deletedAt: null,
        archivedAt: null,
        // Pending, or snoozed to a moment that has passed. `OR` rather
        // than `NOT snoozedUntil > now`, because a NULL `snoozedUntil`
        // does not satisfy a negated comparison in SQL and every
        // PENDING row would have vanished from the lane.
        OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
      },
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
