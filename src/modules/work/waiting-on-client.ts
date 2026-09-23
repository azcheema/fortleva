import { isAuthorized, scopeWhere } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";

import { principalOf, type WorkCtx } from "./states";

/**
 * `/home`'s "WAITING ON CLIENT" (UI.md rule 8) — the work the agency has
 * handed to a client and is blocked on, and the work a client has just
 * handed back.
 *
 * **RULE 8 HAS ASKED FOR THIS SINCE 2W AND IT COULD NOT BE BUILT.**
 * `assigneeContactId` had no writer at all until slice 6c's first
 * commit, so the number would always have been zero — the reason the
 * three em-dash tiles came off this page — and no member-plane surface
 * listed contact-assigned work until its second. This is the third, and
 * it is the last of rule 8's cards.
 *
 * **TWO GROUPS, AND THE FIRST ONE IS THE POINT** (founder decision,
 * 2026-09-22). A client ticking "I've done my part" is not an ending: it
 * is the task coming BACK, and it is the one moment nobody at the agency
 * will otherwise notice. The alternative considered was to drop a ticked
 * row off the card and let the inbox notification carry it — but a
 * notification is read once and archived, where a card is a standing
 * list, so the tick would have been the easiest thing in the product to
 * miss. So: **`ticked` first** (waiting on YOU), then `waiting` (still
 * with them).
 *
 * **ROWS, NOT A COUNT PER CLIENT.** §5.8's rule is that a surface offers
 * the verb that changes what it shows, and what changes a row here is
 * opening the task — chasing it, taking it back, or accepting the
 * client's word and finishing it. A count grouped by company would name
 * a company and leave the member a click away from knowing WHICH task,
 * which is the shape the triage card can take only because a lane is the
 * one place a request is answered.
 *
 * **GATED, NOT THROWN**, and on the queue's two codes for the queue's
 * reasons: `/home` is every member's landing page, so a member without
 * `work_item:view` gets `null` rather than an error, and `project:view`
 * is required besides because a row names a project and links into it.
 *
 * **SCOPE IS COMPOSED INTO THE QUERY**, never asserted per row — the
 * queue's rule verbatim. A hand-over outlives the member's access to its
 * project, and a task they can no longer open must fall out of this card
 * exactly like a deleted one, never render its title or its client's
 * person's name.
 *
 * **AN ARCHIVED PROJECT IS EXCLUDED, and this is the OPPOSITE of the
 * triage card's answer on purpose.** `triageGlance` counts an archived
 * project's waiting requests, because a request is the CLIENT's and
 * archiving must not delete the answer they are owed. This card is the
 * AGENCY's own queue, and there is nothing to chase: `portal.ts` already
 * hides an archived project's tasks from the client, so they cannot see
 * the task, cannot tick it, and are not in fact being waited on. Keeping
 * the row would put a permanent line on the landing page for work nobody
 * can move.
 */

/** Rows per group. Five, the standing size of a `/home` card's list. */
export const WAITING_GLANCE_LIMIT = 5;

/**
 * The live categories a hand-over can sit in. Identical to the queue's
 * OPEN set and for the same reason — DONE and CANCELLED are finished
 * (and `transitionState` clears the claim on arriving at either), TRIAGE
 * is a request nobody has accepted and belongs to the lane.
 */
const LIVE_CATEGORIES = ["BACKLOG", "TODO", "IN_PROGRESS"] as const;

export type WaitingRow = {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly projectKey: string;
  readonly projectName: string;
  /** Who at the client holds it — resolved here, so no caller joins a contact. */
  readonly contactName: string | null;
  /** The agreed day, when there is one. A `@db.Date`. */
  readonly targetDate: Date | null;
  /** When the client said their part was done — non-null on every `ticked` row and null on every `waiting` one. */
  readonly markedDoneAt: Date | null;
  /**
   * WHETHER THAT PERSON CAN ACTUALLY ACT — their portal status, so the
   * card can say why a row is stalled instead of pretending it is not.
   *
   * **THE ROW IS KEPT, NOT FILTERED, and that is the opposite of what
   * this file does for `portalEnabled` — on purpose.** With the portal
   * switched off the client cannot see the project at all, so nobody is
   * being waited on and the row is noise. Here the person genuinely
   * holds the task and the agency genuinely is blocked on them; what is
   * missing is a REASON. Hiding it would take the work off the only
   * surface that tracks it, and the agency would lose the thing it can
   * act on — chase the invitation, or resume the paused account.
   *
   * `portalAuth`'s `session.create` hook admits the literal `ACTIVE` and
   * nothing else, so any other value here means the tick is impossible
   * today. `REVOKED` cannot appear: removing access releases every
   * assignment in the same transaction
   * (`releaseContactAssignments`), which is what makes this a small set
   * rather than a growing one.
   */
  readonly contactStatus: "ACTIVE" | "INVITED" | "SUSPENDED" | "NO_ACCESS" | "REVOKED" | null;
};

export type WaitingOnClient = {
  /** The client has said their part is done: the agency is what the task is waiting for now. */
  readonly ticked: readonly WaitingRow[];
  /** Still with the client. */
  readonly waiting: readonly WaitingRow[];
  /** Either group hit its cap — the card says so once, above both. */
  readonly truncated: boolean;
  /** The cap that was applied, so the card's sentence cannot contradict the list. */
  readonly limit: number;
};

const SELECT = {
  id: true,
  number: true,
  title: true,
  targetDate: true,
  contactCompletedAt: true,
  assigneeContact: { select: { name: true, portalStatus: true } },
  project: { select: { key: true, name: true } },
} as const;

type Row = {
  id: string;
  number: number;
  title: string;
  targetDate: Date | null;
  contactCompletedAt: Date | null;
  assigneeContact: { name: string; portalStatus: "ACTIVE" | "INVITED" | "SUSPENDED" | "NO_ACCESS" | "REVOKED" } | null;
  project: { key: string; name: string };
};

const toRow = (r: Row): WaitingRow => ({
  id: r.id,
  number: r.number,
  title: r.title,
  projectKey: r.project.key,
  projectName: r.project.name,
  contactName: r.assigneeContact?.name ?? null,
  targetDate: r.targetDate,
  markedDoneAt: r.contactCompletedAt,
  contactStatus: r.assigneeContact?.portalStatus ?? null,
});

export async function waitingOnClient(
  ctx: WorkCtx,
  opts?: { limit?: number },
): Promise<WaitingOnClient | null> {
  const limit = opts?.limit ?? WAITING_GLANCE_LIMIT;
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    try {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
    } catch (e) {
      if (e instanceof AuthzError) return null;
      throw e;
    }
    // A core code: no module gate left to pass, only the permission.
    if (!(await isAuthorized(tx, ctx.actor, "project:view"))) return null;

    const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "projectId" });
    // COMPOSED WITH `AND`: the scope fragment carries a top-level `OR`,
    // and a spread would let a later key overwrite it.
    const base = {
      AND: [
        scope,
        {
          tenantId: ctx.tenantId,
          // The whole predicate of this card: somebody at the client
          // holds it. `work_item_contact_assignee_visible` makes every
          // such row CLIENT_VISIBLE, so no visibility term is needed and
          // adding one would be a second place to keep in step.
          assigneeContactId: { not: null },
          deletedAt: null,
          archivedAt: null,
          stateCategory: { in: [...LIVE_CATEGORIES] },
          project: { archivedAt: null },
          // **THE PORTAL SWITCH IS THE SAME FACT AS THE ARCHIVE**, and
          // leaving it out was this card's worst bug — found by a fresh
          // code review, invisible to the whole suite. Handing a task
          // over on a portal-OFF project is a supported, first-class act
          // (slice 6c's second commit decided that deliberately, and the
          // picker carries `assignee.sharesPortalOff` to say so), and
          // `setPortalTaskDone` requires `portalEnabled: true` in its own
          // identifying read. So on such a project the contact never sees
          // the task and CANNOT tick it — and without this term the row
          // sat on `/home` under "still with them" for ever, a standing
          // line about work nobody is waiting on that neither side could
          // clear. That is word for word the argument the docblock above
          // makes for excluding an archived project.
          //
          // The column is the ITEM's, trigger-fanned from the project
          // (`project_portal_enabled_fanout`), so flipping the master
          // switch back on brings the row back by itself.
          portalEnabled: true,
        },
      ],
    };

    // **TWO STATEMENTS, IN SEQUENCE, NOT A `Promise.all`.** Prisma over
    // the `pg` driver adapter does not serialise concurrent statements
    // inside an interactive transaction, and this slice's sibling commit
    // paid for that lesson: a read added as a parallel leg made an
    // unrelated one resolve `undefined` (AGENTS.md's standing trap). Two
    // bounded reads on a landing page are worth one round trip.
    //
    // TICKED FIRST, newest claim first — the client said it most
    // recently, so it is the one the agency has been sitting on least
    // long and the one they are most likely to be able to close.
    const ticked = await tx.workItem.findMany({
      where: { AND: [base, { contactCompletedAt: { not: null } }] },
      // `number` is per PROJECT (`@@unique([tenantId, projectId, number])`),
      // so ACME-3 and BETA-3 collide: without the key, two claims sharing
      // a millisecond order by whatever the database returns, and with a
      // five-row cap that decides WHICH rows appear. The sibling query
      // below already had this third key.
      orderBy: [{ contactCompletedAt: "desc" }, { project: { key: "asc" } }, { number: "asc" }],
      take: limit + 1,
      select: SELECT,
    });
    // STILL WITH THEM: soonest agreed day first, undated last — the
    // queue's own order, because the question a member asks of this
    // group is the same one ("what is late?").
    const waiting = await tx.workItem.findMany({
      where: { AND: [base, { contactCompletedAt: null }] },
      orderBy: [
        { targetDate: { sort: "asc", nulls: "last" } },
        { project: { key: "asc" } },
        { number: "asc" },
      ],
      take: limit + 1,
      select: SELECT,
    });

    // **ONE ROW CANNOT BE IN BOTH GROUPS**, and the two statements above
    // can otherwise disagree. They run in one transaction at Prisma's
    // default READ COMMITTED, where each statement takes its OWN
    // snapshot — so a contact unticking between them is seen as ticked by
    // the first and as waiting by the second, and the card draws the same
    // task twice under two headings that mean opposite things. Dropping
    // the duplicate from `waiting` prefers the CLAIM, which is the newer
    // fact and the one that needs an answer. (A tick landing in the same
    // window makes a row miss both groups instead; that is a rarer
    // absence rather than a contradiction, and the next load corrects
    // it.) Found by a fresh code review.
    const claimed = new Set(ticked.map((r) => r.id));
    const stillWith = waiting.filter((r) => !claimed.has(r.id));
    return {
      ticked: ticked.slice(0, limit).map(toRow),
      waiting: stillWith.slice(0, limit).map(toRow),
      truncated: ticked.length > limit || stillWith.length > limit,
      // THE CAP THAT WAS ACTUALLY APPLIED, not the module constant: the
      // caller may pass its own, and a card that imported the constant
      // to write "showing the first 5" over a list of 2 would be the
      // surface lying about itself.
      limit,
    };
  });
}
