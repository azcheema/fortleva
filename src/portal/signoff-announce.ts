import { withTenant, type TenantDb } from "@/db";
import { emit } from "@/notify/emit";

import type { PortalPrincipal } from "./authorize";
import type { SignoffDecision } from "./signoff-vocabulary";

/**
 * TELLING THE AGENCY ABOUT A SIGN-OFF DECISION — the one thing the two
 * decision writers do that is NOT under the contact's principal, kept
 * in a file of its own so that the portal tripwire, which scans every
 * file that opens a contact transaction, does not meet the member-plane
 * columns this fan-out has to read (a project's lead, the client's
 * assignees). Nothing here is projected to a contact: it runs as
 * `system`, after the decision has committed, and writes only to the
 * members' inboxes.
 */

/** What a decision was made ON, as the announcement needs it. */
export type SignoffSubject = {
  readonly kind: "version" | "deliverable";
  readonly id: string;
  readonly clientId: string;
  /** Null for a deliverable shared with the company itself rather than on a project. */
  readonly projectId: string | null;
  readonly projectKey: string | null;
};

/**
 * WHO AT THE AGENCY IS TOLD: the project's assignees and its lead when
 * the subject is on a project (the same set a request or a client's tick
 * reaches — `requestReceivers` in the work module, whose reasoning about
 * the empty case holds here unchanged), or the members assigned to the
 * client when a deliverable was shared with the company itself. Active
 * members only, decided in one statement. Sequential reads on the one
 * connection, never `Promise.all` (AGENTS.md's trap).
 */
async function decisionReceivers(tx: TenantDb, tenantId: string, subject: SignoffSubject): Promise<string[]> {
  const candidates = new Set<string>();
  if (subject.projectId) {
    const assigned = await tx.memberProject.findMany({
      where: { tenantId, projectId: subject.projectId },
      select: { memberId: true },
    });
    for (const row of assigned) candidates.add(row.memberId);
    const project = await tx.project.findFirst({
      where: { tenantId, id: subject.projectId },
      select: { leadMemberId: true },
    });
    if (project?.leadMemberId) candidates.add(project.leadMemberId);
  } else {
    const assigned = await tx.memberClient.findMany({
      where: { tenantId, clientId: subject.clientId },
      select: { memberId: true },
    });
    for (const row of assigned) candidates.add(row.memberId);
  }
  if (candidates.size === 0) return [];
  const active = await tx.member.findMany({
    where: { tenantId, id: { in: [...candidates] }, status: "ACTIVE" },
    select: { id: true },
  });
  return active.map((m) => m.id);
}

/**
 * TELL THE AGENCY, AFTER THE DECISION HAS COMMITTED.
 *
 * It runs as `system` and in its OWN transaction, and both halves are
 * forced rather than chosen: a contact principal may not insert a
 * `notification` row (`portal_insert_deny`), so the fan-out cannot ride
 * inside the census write, and the census write must not run as
 * `system`, or the database would no longer be deciding it. The order
 * is the safe one — the decision is durable before anyone is told, and
 * the member surfaces draw the decision from the row, so a crash between
 * the two leaves the agency a screen that says what happened and an
 * inbox that does not; the reverse would announce a decision that was
 * never recorded.
 *
 * IDS ONLY in `params` (`emit`'s rule): the project's key, which is the
 * agency's own label; which kind of thing; which way it went. Never the
 * note — a client's words travel to the member's screen through the
 * row, not through an email.
 */
export async function announceDecision(
  principal: PortalPrincipal,
  subject: SignoffSubject,
  decision: SignoffDecision,
): Promise<void> {
  await withTenant(principal.tenantId, { type: "system" }, async (tx) => {
    const receivers = await decisionReceivers(tx, principal.tenantId, subject);
    await emit(tx, principal.tenantId, {
      kind: "approval.decided",
      entity: { type: subject.kind === "version" ? "ProjectVersion" : "Document", id: subject.id },
      // NO ACTOR: no employee did this, and `emit` only knows how to name
      // a member (the tick makes the same point).
      clientId: subject.clientId,
      ...(subject.projectId ? { projectId: subject.projectId } : {}),
      memberIds: receivers,
      params: { projectKey: subject.projectKey ?? "", clientId: subject.clientId, subject: subject.kind, decision },
      // One unread row per subject however many times the same ask is
      // decided and re-asked while nobody has read the first.
      dedupeKey: `signoff:${subject.id}`,
    });
  });
}
