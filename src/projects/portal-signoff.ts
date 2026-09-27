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
 * THE CLIENT SIGNS A VERSION OFF — a CENSUS WRITE, under the contact's
 * own principal (Phase 3, decision #7 v1-lite; AUTHZ.md §8
 * `portal.version.approve`, CONTACT_PRIMARY only).
 *
 * THIS IS NOT A BROKER, and the difference is the whole design. A
 * broker authorizes under the contact and then writes as `system`,
 * restating the gate's terms in its own `where` because the database
 * no longer applies them. This function writes AS THE CONTACT, so the
 * database applies everything: `portal_gate` admits only a SHIPPED,
 * portal-enabled version of the contact's own client; the named
 * `portal_approval_update` policy admits only a decision, by this
 * principal, dated; `portal_contact_columns_only` refuses a change to
 * any column but the four; `portal_approval_decision` refuses a row
 * that was not PENDING. The `where` below repeats those terms as
 * defence in depth and adds the one the policies do not carry (the
 * project's archive), but the guarantee is the database's — a
 * contact handed the wrong client id by a bug in the session layer
 * still cannot touch a row RLS does not show them.
 *
 * ONCE PER ASK. `approvalStatus = 'PENDING'` is a term of the UPDATE,
 * so two decisions racing on one row see one winner: the second
 * matches nothing, re-reads the row and hands back the decision that
 * stands, `changed: false`. A double press on a slow link is the
 * ordinary way here, and the island adopts the row's true state.
 *
 * THE AUDIT ROW IS IN THE SAME TRANSACTION, under the contact —
 * `record()` derives actor CONTACT from the principal and
 * `portal_audit_insert` admits exactly that row. The agency is told
 * AFTER the commit (`announceDecision`), because a contact may not
 * insert a `notification` row; the order is the safe one.
 */
export async function decidePortalVersion(
  principal: PortalPrincipal,
  versionId: string,
  input: SignoffInput,
): Promise<SignoffResult> {
  // AN EMPTY ID IS REFUSED HERE: Prisma drops an `undefined` filter
  // silently, and although RLS would still bound the rows, "any PENDING
  // version of the client" is not what the reader pressed.
  if (!versionId) fail("INVALID_INPUT", "version");

  // The fail-open front filter (`allow` is a no-op until Upstash is
  // provisioned); the database's once-per-ask rule is the control.
  if (!(await allow("portal.sign_off", principal.contactId))) {
    fail("REQUEST_RATE_LIMITED", "front filter");
  }

  let out: SignoffResult & { readonly projectId: string; readonly projectKey: string };
  try {
    out = await withCensusWrite(
      principal,
      async (tx) => {
        // THE REF IS THE VERSION: `portal_gate` on `project_version`
        // carries SHIPPED and the portal switch, so a ref that resolves
        // has proved the contact may read this exact row.
        await authorizePortal(tx, principal, "portal.version.approve", {
          kind: "project_version",
          versionId,
        });

        const decidedAt = new Date();
        const { count } = await tx.projectVersion.updateMany({
          where: {
            tenantId: principal.tenantId,
            clientId: principal.clientId,
            id: versionId,
            status: "SHIPPED",
            portalEnabled: true,
            approvalStatus: "PENDING",
            project: { archivedAt: null },
          },
          data: {
            approvalStatus: input.decision,
            approvalDecidedAt: decidedAt,
            approvalByContactId: principal.contactId,
            approvalNote: input.note,
          },
        });

        // The row as it stands now, whichever call decided it — the
        // same read the timeline makes, allow-listed.
        const row = await tx.projectVersion.findFirst({
          where: { tenantId: principal.tenantId, clientId: principal.clientId, id: versionId },
          select: {
            id: true,
            projectId: true,
            version: true,
            approvalStatus: true,
            approvalDecidedAt: true,
            approvalNote: true,
            project: { select: { key: true } },
          },
        });
        if (!row) return deny("NOT_FOUND", "version");
        if (row.approvalStatus !== "APPROVED" && row.approvalStatus !== "CHANGES_REQUESTED") {
          // Nothing was asked, or the ask was withdrawn by a re-ship of
          // the project's switch between render and press: the plane's
          // uniform refusal, never a sentence about the agency.
          return deny("NOT_FOUND", "no sign-off requested");
        }
        // Both non-null on a decided row (the CHECK); the guard keeps the
        // type honest rather than asserted.
        if (row.approvalDecidedAt === null) return deny("NOT_FOUND", "decision undated");
        const result = {
          status: row.approvalStatus,
          decidedAt: row.approvalDecidedAt,
          note: row.approvalNote,
          projectId: row.projectId,
          projectKey: row.project.key,
        };
        if (count === 0) return { ...result, changed: false };

        await record(tx, {
          action: input.decision === "APPROVED" ? "project_version.approved" : "project_version.changes_requested",
          targetType: "ProjectVersion",
          targetId: row.id,
          // Ids and the agency's own label, never the note (SECURITY.md §7).
          metadata: { projectId: row.projectId, clientId: principal.clientId, version: row.version },
        });
        return { ...result, changed: true };
      },
      { lockTimeoutMs: SIGNOFF_LOCK_WAIT_MS },
    );
  } catch (e) {
    // A spent lock wait and a lost deadlock both mean "nothing was
    // written, try again" — the brokers' mapping, for the same reason.
    if (isLockTimeout(e)) fail("REQUEST_BUSY", "lock timeout");
    if (isDeadlock(e)) fail("REQUEST_BUSY", "deadlock");
    throw e;
  }

  if (out.changed) {
    // AFTER THE COMMIT, AND NEVER ALLOWED TO UNDO IT: a failed fan-out
    // would otherwise reach the island as "did not save" over a decision
    // the database already holds (a security review's note). The row is
    // the truth and the member surfaces draw it; the inbox row is the
    // courtesy, and its loss is logged rather than reported as a refusal.
    try {
      await announceDecision(
        principal,
        {
          kind: "version",
          id: versionId,
          clientId: principal.clientId,
          projectId: out.projectId,
          projectKey: out.projectKey,
        },
        input.decision,
      );
    } catch (e) {
      console.error("[portal] decideVersion: decision recorded, announcement failed", e);
    }
  }
  return { status: out.status, decidedAt: out.decidedAt, note: out.note, changed: out.changed };
}
