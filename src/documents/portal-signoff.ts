import { record } from "@/audit/record";
import { deny } from "@/authz/errors";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { authorizePortal, withCensusWrite, type PortalPrincipal } from "@/portal";
import {
  SIGNOFF_LOCK_WAIT_MS,
  announceDecision,
  type SignoffInput,
  type SignoffResult,
} from "@/portal/signoff";
import { allow } from "@/ratelimit";

/**
 * THE CLIENT SIGNS A DELIVERABLE OFF — a CENSUS WRITE, under the
 * contact's own principal (Phase 3, DATA_MODEL §6.8; AUTHZ.md §8
 * `portal.deliverable.approve`, CONTACT_PRIMARY only). The twin of
 * `src/projects/portal-signoff.ts`, whose header carries the argument:
 * not a broker, the database decides — `portal_gate` (client,
 * CLIENT_VISIBLE, the portal switch), `portal_approval_update` (a
 * decision, by this principal, dated, on a DELIVERABLE that is not
 * deleted), `portal_contact_columns_only` (the four columns) and
 * `portal_approval_decision` (PENDING before). The `where` repeats the
 * terms and adds the project's archive; once per ask; audit inside,
 * announcement after.
 *
 * WHAT A DECISION IS ABOUT is `approvalVersionNumber`, stamped by
 * staff when they asked — the newest committed version at that moment.
 * The contact does not choose it and the column trigger refuses them
 * the column; the surfaces print the number beside the decision, and a
 * later upload voids an open ask rather than letting it be answered
 * against bytes the client never saw (`addVersion`).
 */
export async function decidePortalDeliverable(
  principal: PortalPrincipal,
  documentId: string,
  input: SignoffInput,
): Promise<SignoffResult> {
  if (!documentId) fail("INVALID_INPUT", "document");
  if (!(await allow("portal.sign_off", principal.contactId))) {
    fail("REQUEST_RATE_LIMITED", "front filter");
  }

  let out: SignoffResult & { readonly projectId: string | null; readonly projectKey: string | null };
  try {
    out = await withCensusWrite(
      principal,
      async (tx) => {
        // THE REF IS THE DOCUMENT: the three-term gate plus the probe's
        // own soft-delete term (`PortalScopeRef`).
        await authorizePortal(tx, principal, "portal.deliverable.approve", {
          kind: "document",
          documentId,
        });

        const decidedAt = new Date();
        const { count } = await tx.document.updateMany({
          where: {
            tenantId: principal.tenantId,
            clientId: principal.clientId,
            id: documentId,
            kind: "DELIVERABLE",
            visibility: "CLIENT_VISIBLE",
            portalEnabled: true,
            deletedAt: null,
            approvalStatus: "PENDING",
            OR: [{ projectId: null }, { project: { archivedAt: null } }],
          },
          data: {
            approvalStatus: input.decision,
            approvalDecidedAt: decidedAt,
            approvalByContactId: principal.contactId,
            approvalNote: input.note,
          },
        });

        const row = await tx.document.findFirst({
          where: { tenantId: principal.tenantId, clientId: principal.clientId, id: documentId, deletedAt: null },
          select: {
            id: true,
            projectId: true,
            approvalStatus: true,
            approvalDecidedAt: true,
            approvalNote: true,
            approvalVersionNumber: true,
            project: { select: { key: true } },
          },
        });
        if (!row) return deny("NOT_FOUND", "document");
        if (row.approvalStatus !== "APPROVED" && row.approvalStatus !== "CHANGES_REQUESTED") {
          return deny("NOT_FOUND", "no sign-off requested");
        }
        if (row.approvalDecidedAt === null) return deny("NOT_FOUND", "decision undated");
        const result = {
          status: row.approvalStatus,
          decidedAt: row.approvalDecidedAt,
          note: row.approvalNote,
          projectId: row.projectId,
          projectKey: row.project?.key ?? null,
        };
        if (count === 0) return { ...result, changed: false };

        await record(tx, {
          action: "document.approval_decided",
          targetType: "Document",
          targetId: row.id,
          // Ids, the outcome and the version number — never the note.
          metadata: {
            clientId: principal.clientId,
            projectId: row.projectId,
            decision: input.decision,
            versionNumber: row.approvalVersionNumber,
          },
        });
        return { ...result, changed: true };
      },
      { lockTimeoutMs: SIGNOFF_LOCK_WAIT_MS },
    );
  } catch (e) {
    if (isLockTimeout(e)) fail("REQUEST_BUSY", "lock timeout");
    if (isDeadlock(e)) fail("REQUEST_BUSY", "deadlock");
    throw e;
  }

  if (out.changed) {
    // After the commit and never allowed to undo it (`decidePortalVersion`
    // says why).
    try {
      await announceDecision(
        principal,
        {
          kind: "deliverable",
          id: documentId,
          clientId: principal.clientId,
          projectId: out.projectId,
          projectKey: out.projectKey,
        },
        input.decision,
      );
    } catch (e) {
      console.error("[portal] decideDeliverable: decision recorded, announcement failed", e);
    }
  }
  return { status: out.status, decidedAt: out.decidedAt, note: out.note, changed: out.changed };
}
