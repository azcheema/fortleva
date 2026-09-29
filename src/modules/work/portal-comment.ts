import { record } from "@/audit/record";
import { deny } from "@/authz/errors";
import { DomainError, fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { normalizeComment, type NormalizedComment } from "@/lib/rich-text/normalize";
import { retryOnContention } from "@/lib/retry";
import { authorizePortal, withCensusWrite, type PortalPrincipal } from "@/portal";
import { lockContactBudget } from "@/portal/contact-budget-lock";
import { enterPortalGateShared } from "@/projects/portal-gate";
import { allow } from "@/ratelimit";
import type { TenantDb } from "@/db";

import { announcePortalComment } from "./comment-announce";
import { guarded } from "./db-errors";
import { portalShownTaskTerms } from "./portal";
import { PORTAL_COMMENT_MAX, portalCommentDoc } from "./portal-comment-input";
import { lockItemRow } from "./rank-lock";

/**
 * A CLIENT COMMENTS ON A SHARED TASK — a CENSUS WRITE, under the
 * contact's own principal (Phase 3 slice 75; UI.md §5.6's contact half;
 * AUTHZ.md §8 `portal.comment.create`, both profiles).
 *
 * THIS IS NOT A BROKER, and the difference is the design. A comment is
 * the one INSERT the contact-writable census has admitted since 2W:
 * `comment`'s `portal_gate` WITH CHECK spells the whole predicate out —
 * CLIENT_VISIBLE, the contact's own client, `author_contact_id` equal to
 * the principal, and `portal_enabled` — and `comment_single_author`
 * makes that author the ONLY one. So the database decides whether this
 * row may exist, and the `where`s below repeat its terms as defence in
 * depth. A contact handed the wrong client id by a bug in the session
 * layer still cannot write a row RLS does not admit.
 *
 * FORCED CLIENT_VISIBLE, and nothing the reader sends can say
 * otherwise: the visibility is a literal here, the WITH CHECK refuses any
 * other, and the input is plain text (`portal-comment-input.ts`). Once
 * written the comment FOLLOWS ITS TASK (founder decision C37): private
 * with it, back with a re-share. A client may not edit or delete it —
 * `portal_no_update` / `portal_no_delete` — and the composer says so
 * before the words are sent.
 *
 * "IF YOU CAN SEE THE TASK, YOU CAN COMMENT ON IT" (C41): the task must
 * be one the portal SHOWS, by the list's own rule (`portalShownTaskTerms`
 * — so not a cancelled task, not live work archived, not on an archived
 * or switched-off project).
 *
 * THE ORDER, and every step is load-bearing:
 *
 *   1. `authorizePortal` — the contact row, the profile and the module
 *      gates (the cheap refusal, before any lock). WITHOUT a resource
 *      ref, on purpose: its `work_item` probe would be a strictly weaker
 *      copy of step 2's read, one round trip for nothing (code review).
 *   2. An unlocked probe of the task under the contact principal — the
 *      pipeline's steps 3–4, by the list's own rule and the project's
 *      switch read from the project — for its PROJECT: the gate below is
 *      per project.
 *   3. THE PROJECT'S PORTAL GATE, SHARED, BLOCKING (slice 74, C40, and
 *      recorded then as this slice's debt). Every stamp only TRIES the
 *      gate and writes `portal_enabled = false` while a switch is in
 *      flight — right for a member's row, wrong for this one, which the
 *      WITH CHECK would then refuse. So this writer waits a switch out,
 *      as the request broker does: afterwards the switch cannot move
 *      before this commits, the stamp's try is a re-acquire, and a
 *      switch that ended OFF is seen by step 5. FIRST, before any write
 *      or row lock — the gate's SQL refuses a transaction that has an
 *      id — which is what makes the wait cycle-free.
 *   4. This contact's COMMENT BUDGET: the per-contact advisory key, then
 *      a count. After the gate (the request broker's order), before the
 *      row lock, so a refusal waits on nothing a member holds.
 *   5. The TASK, locked FOR SHARE and then re-read by the list's rule —
 *      the member writer's discipline (`comments.ts`): the task cannot be
 *      made private, deleted, archived or moved to a hidden category
 *      between this read and the insert, and the trigger's own share
 *      lock is then re-entrant. Under the contact principal a row the
 *      policy hides is simply not locked, and the re-read finds nothing.
 *   6. The INSERT, then the audit row, both in this transaction and both
 *      as the contact (`portal_audit_insert` admits exactly that row).
 *
 * THE AGENCY IS TOLD AFTER THE COMMIT (`announcePortalComment`), because
 * a contact may not insert a `notification` or a history row; a failed
 * announcement is logged and never reported as a failed comment — the
 * words are saved, and the member panel draws them from the row.
 *
 * LOCK WAITS ARE BOUNDED (`lockTimeoutMs`) and retried; spent, they are
 * `REQUEST_BUSY` — the plane's generic refusal.
 */

/** How long a contact's comment may wait on each lock — the brokers' figure, for the same reason. */
const PORTAL_COMMENT_LOCK_WAIT_MS = 3000;
/** The transaction's budget: its three bounded waits at once (gate, budget key, task row), plus the work. */
const PORTAL_COMMENT_TX_MS = 3 * PORTAL_COMMENT_LOCK_WAIT_MS + 5_000;

/**
 * THE COMMENT BUDGET — a Postgres count behind the per-contact advisory
 * lock, fail-CLOSED, with the fail-open Upstash bucket in front of it
 * (`portal.comment_create`). Sized for a person in a conversation, not a
 * script: twenty comments an hour — SECURITY.md §4's figure for a contact's
 * comment creation.
 *
 * WHAT IT COUNTS is the contact's own comments inside the window, as
 * their principal reads them — deleted ones included (a member removing
 * a comment does not refund it). It does NOT see a comment that has
 * since left the portal (its task made private, C37, or the project
 * switched off), so the count can only be LOWER than what was written:
 * the agency, never the contact, can loosen it, and only by hiding work.
 * A count under a system principal would be exact and would need a
 * second transaction, which a census write is built not to have.
 */
export const PORTAL_COMMENT_WINDOW_MINUTES = 60;
export const PORTAL_COMMENT_WINDOW_LIMIT = 20;

async function assertCommentBudget(tx: TenantDb, principal: PortalPrincipal): Promise<void> {
  // The database's clock, returned by the statement that takes the lock
  // (`contact-budget-lock.ts` explains why never `Date.now()`).
  const now = await lockContactBudget(tx, "portal_comment", principal.contactId);
  const since = new Date(now.getTime() - PORTAL_COMMENT_WINDOW_MINUTES * 60_000);
  // The client and visibility terms are `portal_gate`'s, restated so the
  // planner takes `(tenant_id, client_id, visibility)`: there is no index
  // on the contact author column, and this bounds the scan to one
  // client's shared comments rather than the tenant's.
  const used = await tx.comment.count({
    where: {
      tenantId: principal.tenantId,
      clientId: principal.clientId,
      visibility: "CLIENT_VISIBLE",
      authorContactId: principal.contactId,
      createdAt: { gte: since },
    },
  });
  if (used >= PORTAL_COMMENT_WINDOW_LIMIT) fail("COMMENT_RATE_LIMITED");
}

/**
 * The reader's text → the stored comment, or INVALID_INPUT — the one
 * refusal about what they typed that the plane discloses. Not a string,
 * nothing but whitespace, or longer than the box allows: each is the
 * reader's own input. The document is built here from text and then
 * passes the gate every stored comment passes (`normalizeComment`); a
 * refusal from THAT is also about the text (a character the database
 * cannot store), so it is reported the same way.
 */
export function parsePortalComment(input: unknown): NormalizedComment {
  if (typeof input !== "string") fail("INVALID_INPUT", "comment is not text");
  const text = (input as string).trim();
  if (text.length === 0) fail("INVALID_INPUT", "comment is empty");
  if (text.length > PORTAL_COMMENT_MAX) fail("INVALID_INPUT", "comment is too long");
  try {
    return normalizeComment(portalCommentDoc(text));
  } catch (e) {
    if (e instanceof DomainError) fail("INVALID_INPUT", `comment refused: ${e.code}`);
    throw e;
  }
}

export type PortalCommentCreated = {
  readonly id: string;
  /** The task it landed on — the page to revalidate. */
  readonly itemId: string;
  readonly createdAt: Date;
};

/**
 * WRITE ONE COMMENT on a shared task, as the contact. See the header for
 * the order and the reasons.
 */
export async function createPortalComment(
  principal: PortalPrincipal,
  itemId: string,
  input: unknown,
): Promise<PortalCommentCreated> {
  // The reader's own input first: a blank or over-long comment never
  // opens a transaction, and it is the one refusal the plane explains.
  const body = parsePortalComment(input);
  // AN ID THAT IS NOT A NON-EMPTY STRING IS REFUSED HERE AND NOT PASSED
  // ON. Prisma drops an `undefined` filter silently, and a server action's
  // arguments are whatever React decoded — a crafted `{ not: "" }` would
  // reach the probe as a FILTER and pick some shown task rather than the
  // one named (RLS would keep it inside the contact's own client, but the
  // id must name the row; code review). The uniform refusal, never a
  // sentence.
  if (typeof itemId !== "string" || itemId.length === 0) deny("NOT_FOUND", "task");

  // The fail-open front filter (a no-op until Upstash is provisioned);
  // the Postgres budget inside the write is the control.
  if (!(await allow("portal.comment_create", principal.contactId))) {
    fail("COMMENT_RATE_LIMITED", "front filter");
  }

  let created: PortalCommentCreated & { readonly projectId: string };
  try {
    created = await retryOnContention(() =>
      withCensusWrite(
        principal,
        (tx) =>
          guarded(async () => {
            // 1. The pipeline's principal half: the contact row, the
            //    profile, the module gates. No ref — step 2 is the
            //    resource check, and a stronger one.
            await authorizePortal(tx, principal, "portal.comment.create");

            // 2. The task, by the list's rule, under the contact principal
            //    — and which project's gate to enter. A plain read: it
            //    assigns no transaction id, so the gate may still be taken.
            const probe = await tx.workItem.findFirst({
              where: {
                ...portalShownTaskTerms(principal),
                id: itemId,
                project: { archivedAt: null, portalEnabled: true },
              },
              select: { id: true, projectId: true },
            });
            if (!probe) return deny("NOT_FOUND", "task not shown");

            // 3. The gate — first, before any write or row lock.
            await enterPortalGateShared(tx, probe.projectId);

            // 4. The budget — after the gate, before the row lock.
            await assertCommentBudget(tx, principal);

            // 5. Lock the task, then read it by the list's rule. The
            //    project's switch is read from the PROJECT (slice 74), and
            //    after the gate it cannot move before this commits.
            await lockItemRow(tx, principal.tenantId, probe.id, "SHARE");
            const task = await tx.workItem.findFirst({
              where: {
                ...portalShownTaskTerms(principal),
                id: probe.id,
                project: { archivedAt: null, portalEnabled: true },
              },
              select: { id: true, projectId: true },
            });
            if (!task) return deny("NOT_FOUND", "task changed");

            // 6. The row — every identifying column from the principal or
            //    the locked row, the visibility a literal.
            const row = await tx.comment.create({
              data: {
                tenantId: principal.tenantId,
                subjectType: "WORK_ITEM",
                subjectId: task.id,
                authorContactId: principal.contactId,
                body: body.doc as object,
                bodyText: body.text,
                visibility: "CLIENT_VISIBLE",
              },
              // INLINE: a select-less create returns the whole row.
              select: { id: true, createdAt: true },
            });

            await record(tx, {
              action: "portal.comment_created",
              targetType: "Comment",
              targetId: row.id,
              // Ids only — never the words (SECURITY.md §7).
              metadata: { workItemId: task.id, projectId: task.projectId, clientId: principal.clientId },
            });

            return { id: row.id, itemId: task.id, createdAt: row.createdAt, projectId: task.projectId };
          }),
        { lockTimeoutMs: PORTAL_COMMENT_LOCK_WAIT_MS, timeoutMs: PORTAL_COMMENT_TX_MS },
      ),
    );
  } catch (e) {
    // A spent lock wait and a surviving deadlock mean the same thing to
    // the reader — nothing was written, try again — and neither is a
    // fact about them, so both are the plane's generic refusal.
    if (isLockTimeout(e)) fail("REQUEST_BUSY", "lock timeout");
    if (isDeadlock(e)) fail("REQUEST_BUSY", "deadlock");
    throw e;
  }

  // AFTER THE COMMIT, AND NEVER ALLOWED TO UNDO IT (the sign-off
  // writers' rule): the comment is saved and the member panel draws it
  // from the row; the inbox row and the history row are the courtesy,
  // and their loss is logged rather than reported as a refusal.
  try {
    await announcePortalComment(principal, { itemId: created.itemId, commentId: created.id });
  } catch (e) {
    console.error("[portal] createComment: comment saved, announcement failed", e);
  }
  return { id: created.id, itemId: created.itemId, createdAt: created.createdAt };
}
