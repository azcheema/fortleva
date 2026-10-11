import { record } from "@/audit/record";
import { deny } from "@/authz/errors";
import { isUuid } from "@/db/context";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { getRequestContext } from "@/lib/request-context";
import { authorizePortal, withCensusWrite, type PortalPrincipal } from "@/portal";
import { SIGNOFF_LOCK_WAIT_MS } from "@/portal/signoff";
import { allow } from "@/ratelimit";

import { guarded } from "./db-errors";
import type { ContractDecisionInput } from "./sign-input";
import { announceContractDecision } from "./sign-announce";

/**
 * THE CLIENT SIGNS A CONTRACT, OR DECLINES IT — a CENSUS WRITE, under the
 * contact's own principal (Phase 4 slice 112b2; founder decisions C84 (b)–(d),
 * C85; AUTHZ.md §8 `portal.contract.sign`, CONTACT_PRIMARY only). The design:
 * docs/research/2026-10-10-slice-112-contracts-design.md §3.4, §10, §13.
 *
 * NOT A BROKER — the sign-off writer's shape (`src/projects/portal-signoff.ts`).
 * It writes AS THE CONTACT, so the database decides all of it: `portal_gate`
 * and `portal_signature_primary` show only their own client's signature rows
 * of a contract they can see; the named census policy `portal_signature_decide`
 * admits only their OWN client row, decided and dated, while they are an
 * ACTIVE main contact; `portal_contact_columns_only` refuses any column but the
 * decision's six; `contract_signature_guard` admits only PENDING → SIGNED |
 * DECLINED, once, and dates it by the database's clock; the evidence definer
 * moves the address and the browser to their class-A row; and the
 * `contract_signature_decided` definer moves the contract SENT → SIGNED |
 * DECLINED `WHERE status = 'SENT'`, raising CONTRACT_NOT_OPEN when the agency
 * withdrew it first. The `where` below restates the terms as defence in depth.
 *
 * ONCE PER CONTRACT. `status = 'PENDING'` is a term of the UPDATE, so a double
 * press sees one winner: the second matches nothing, re-reads the row and
 * hands back the decision that stands, `changed: false`.
 *
 * THE IP ADDRESS AND THE BROWSER come from the REQUEST (`getRequestContext` —
 * the audit row's own derivation), never from the form: they are the evidence
 * that makes a simple electronic signature defensible (DATA_MODEL §6.6), and a
 * client must not be able to write someone else's.
 *
 * THE AUDIT ROW IS IN THE SAME TRANSACTION, under the contact (`record()`
 * derives actor CONTACT; `portal_audit_insert` admits it). The agency is told
 * AFTER the commit (`announceContractDecision`), because a contact may not
 * insert a notification or an outbox row; a failed announcement is logged,
 * never reported as a refusal of a decision the database already holds.
 */

export type ContractDecisionResult = {
  readonly status: "SIGNED" | "DECLINED";
  readonly decidedAt: Date;
  /** Whether THIS call made the decision (false: it was already made — a double press). */
  readonly changed: boolean;
};

export async function decidePortalContract(
  principal: PortalPrincipal,
  contractId: string,
  input: ContractDecisionInput,
): Promise<ContractDecisionResult> {
  // A UUID STRING OR NOTHING (both reviews' low): the id arrives through a
  // server action, whose arguments a hand-built request can make an OBJECT —
  // `{ not: "" }` would be a Prisma filter, not an id, and match every pending
  // row of the contact. An empty one too: Prisma drops an `undefined` filter.
  if (typeof contractId !== "string" || !isUuid(contractId)) fail("INVALID_INPUT", "contract");
  // The fail-open front filter — the sign-off decisions' budget, the same act;
  // the database's once-per-contract rule is the control.
  if (!(await allow("portal.sign_off", principal.contactId))) fail("REQUEST_RATE_LIMITED", "front filter");
  const request = await getRequestContext();
  const evidence = { ip: request?.ip ?? null, userAgent: request?.userAgent ?? null };

  let out: ContractDecisionResult;
  try {
    out = await withCensusWrite(
      principal,
      // `guarded`: the definer's CONTRACT_NOT_OPEN (a withdrawal that committed
      // between this `where` and its move) becomes a DomainError the plane
      // renders as its one refusal, never the error boundary.
      (tx) => guarded(async () => {
        // THE REF IS THE CONTRACT: its `portal_gate` carries the client, not a
        // draft and sent, so a ref that resolves has proved the contact may read
        // this exact contract.
        await authorizePortal(tx, principal, "portal.contract.sign", { kind: "contract", contractId });

        const own = {
          tenantId: principal.tenantId,
          clientId: principal.clientId,
          contractId,
          party: "CLIENT" as const,
          signerContactId: principal.contactId,
        };
        const decidedAt = new Date(); // the guard writes the database's own clock over it
        const { count } = await tx.contractSignature.updateMany({
          where: { ...own, status: "PENDING", contract: { origin: "WRITTEN", status: "SENT" } },
          data:
            input.decision === "SIGNED"
              ? { status: "SIGNED", typedName: input.typedName, decidedAt, ...evidence }
              : { status: "DECLINED", declineReason: input.reason, decidedAt, ...evidence },
        });

        // The row as it stands now, whichever call decided it.
        const row = await tx.contractSignature.findFirst({ where: own, select: { status: true, decidedAt: true } });
        if (!row || row.status === "PENDING" || row.decidedAt === null) {
          // Not this person's to decide, or no longer open (withdrawn between
          // the page and the press): the plane's uniform refusal.
          return deny("NOT_FOUND", "no signature waits for this contact");
        }
        const result = { status: row.status, decidedAt: row.decidedAt };
        if (count === 0) return { ...result, changed: false };

        const contract = await tx.contract.findFirst({
          where: { tenantId: principal.tenantId, clientId: principal.clientId, id: contractId },
          select: { version: true },
        });
        await record(tx, {
          action: input.decision === "SIGNED" ? "contract.signed" : "contract.declined",
          targetType: "Contract",
          targetId: contractId,
          // Ids and the version — never the typed name or the reason (SECURITY.md §7).
          metadata: { clientId: principal.clientId, version: contract?.version ?? null },
        });
        return { ...result, changed: true };
      }),
      { lockTimeoutMs: SIGNOFF_LOCK_WAIT_MS },
    );
  } catch (e) {
    // A spent lock wait and a lost deadlock both mean "nothing was written,
    // try again" — the sign-off writer's mapping, for the same reason.
    if (isLockTimeout(e)) fail("REQUEST_BUSY", "lock timeout");
    if (isDeadlock(e)) fail("REQUEST_BUSY", "deadlock");
    throw e;
  }

  if (out.changed) {
    try {
      await announceContractDecision(principal.tenantId, principal.clientId, contractId, out.status);
    } catch (e) {
      console.error("[portal] decideContract: decision recorded, announcement failed", e instanceof Error ? e.name : typeof e);
    }
  }
  return out;
}
