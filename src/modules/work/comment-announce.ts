import { withTenant } from "@/db";
import { emit } from "@/notify/emit";
import type { PortalPrincipal } from "@/portal";

import { writeContactActivity } from "./activity";
import { requestReceivers } from "./notify";

/**
 * TELLING THE AGENCY ABOUT A CLIENT'S COMMENT — the one thing the portal
 * comment writer does that is NOT under the contact's principal (Phase 3
 * slice 75), kept in a file of its own for the reason
 * `src/portal/signoff-announce.ts` is: the portal tripwire scans every
 * file that opens a contact transaction, and this fan-out has to read
 * member-plane columns (the task's member assignee, the project's lead).
 * Nothing here is projected to a contact. It runs as `system`, after the
 * comment has committed, and writes only to the agency's side: the
 * members' inboxes and the task's history.
 *
 * TWO WRITES, BOTH THE AGENCY'S, BOTH IMPOSSIBLE UNDER THE CONTACT: a
 * contact may insert neither a `notification` (`portal_insert_deny`) nor
 * a `work_item_activity` row (`portal_no_insert`). So the census write
 * commits the comment and its audit row, and this adds —
 *
 *  · the HISTORY ROW, "commented", naming the CONTACT
 *    (`writeContactActivity`: `actor_member_id` stays NULL rather than
 *    borrowing a member who did nothing) — the row a member's own comment
 *    writes in its own transaction (`comments.ts`), so the task's
 *    Activity section reads the same whoever wrote. INTERNAL by
 *    construction: the field is not portal-safe;
 *  · the NOTIFICATION, `work_item.client_commented` (INSTANT, founder
 *    decision C43).
 *
 * The order is the safe one: the comment is durable before anyone is
 * told, and the member panel draws it from the row, so a crash between
 * the two leaves a thread that says what happened and an inbox that does
 * not; the reverse would announce words that were never saved.
 */

/** What the announcement needs to know about what happened — ids only. */
export type PortalCommentSubject = {
  readonly itemId: string;
  readonly commentId: string;
};

/**
 * WHO IS TOLD — founder decision C43, "owner, else project": the task's
 * member assignee when there is one and they are ACTIVE; otherwise the
 * project's people (`requestReceivers`: its assignees and its lead,
 * active only). A task handed to a CONTACT has no member owner, so it
 * falls to the project's people too. Can be empty, and that is recorded
 * where `requestReceivers` is written: a tenant whose members reach
 * projects through tenant-wide roles alone has no project rows, and the
 * comment is then visible in the panel but announced to nobody.
 */
export async function announcePortalComment(
  principal: PortalPrincipal,
  subject: PortalCommentSubject,
): Promise<void> {
  await withTenant(principal.tenantId, { type: "system" }, async (tx) => {
    const item = await tx.workItem.findFirst({
      where: { tenantId: principal.tenantId, id: subject.itemId, deletedAt: null },
      select: {
        id: true,
        number: true,
        clientId: true,
        projectId: true,
        visibility: true,
        assigneeMemberId: true,
        project: { select: { key: true } },
      },
    });
    // Deleted by a member in the instant after the comment committed:
    // there is nothing left to point anybody at.
    if (!item) return;

    // SEQUENTIAL, never `Promise.all` — one transaction, one connection.
    let receivers: string[] = [];
    if (item.assigneeMemberId) {
      const owner = await tx.member.findFirst({
        where: { tenantId: principal.tenantId, id: item.assigneeMemberId, status: "ACTIVE" },
        select: { id: true },
      });
      if (owner) receivers = [owner.id];
    }
    if (receivers.length === 0) receivers = await requestReceivers(tx, principal.tenantId, item.projectId);

    await writeContactActivity(tx, principal.tenantId, principal.contactId, item, {
      field: "comment",
      newValue: "created",
      commentId: subject.commentId,
    });

    await emit(tx, principal.tenantId, {
      kind: "work_item.client_commented",
      entity: { type: "WorkItem", id: item.id },
      // NO ACTOR: no employee did this, and `emit` only knows how to name
      // a member (the request intake makes the same point).
      clientId: item.clientId,
      projectId: item.projectId,
      memberIds: receivers,
      // IDS ONLY (emit's rule): these travel to an inbox outside the
      // product. `projectKey` is the agency's own label, never the
      // client's words — the words reach the member through the row.
      params: { projectKey: item.project.key, itemNumber: String(item.number) },
      // One unread row per task however many comments arrive while nobody
      // has read the first — so one email, not twenty.
      dedupeKey: `client-comment:${item.id}`,
    });
  });
}
