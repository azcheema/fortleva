import { withTenant } from "@/db";
import { emit } from "@/notify/emit";
import type { NotificationReason } from "@/notify/reasons";

import { enqueueContractMail } from "./mail";
import { ensureContractPdfAsSystem } from "./pdf-store";

/**
 * TELLING EVERYONE ONCE A CLIENT HAS SIGNED OR DECLINED A CONTRACT — the one
 * thing the census writer (`portal-sign.ts`) does that is NOT under the
 * contact's principal, kept in a file of its own so the portal tripwire, which
 * scans every file that opens a contact transaction, never meets the
 * member-plane column this has to read (who sent it). An ANNOUNCER: pinned by
 * name, with every value it imports, in `src/portal/brokered-writes.test.ts`.
 *
 * SYSTEM, AFTER THE DECISION COMMITTED, and never allowed to undo it (the
 * caller logs a failure): the decision is durable before anyone is told, and
 * the agency's contract page draws it from the row — so a crash between the
 * two leaves a page that says what happened and an inbox that does not, never
 * the reverse.
 *
 *   1. One transaction: the SENDER told (C85 (a)) — an inbox row and, through
 *      `emit`, a mail as their own notification settings say — or, when the
 *      sender is no longer an active member, the workspace's active OWNERS
 *      (C85 (f)); and, on a signature, the signed-copy mail to the
 *      client's signer queued (C85 (b): "it's signed — your copy is in your
 *      portal"; `./mail.ts`, the one writer here beyond `emit`).
 *   2. On a signature, the SIGNED COPY drawn and archived
 *      (`ensureContractPdfAsSystem` — its own transactions; the jobs route's
 *      sweep makes it within minutes if this fails). After the mail is queued,
 *      so a drawing that fails cannot cost the client their mail: the portal
 *      says "being prepared" until the copy is there.
 *
 * IDS ONLY in `params` (`emit`'s rule); never the typed name or the reason — a
 * client's words reach the agency's screen through the row, not an email.
 */
export async function announceContractDecision(
  tenantId: string,
  /** The signer's client — every SYSTEM read here restates it (the security review's low). */
  clientId: string,
  contractId: string,
  decision: "SIGNED" | "DECLINED",
): Promise<void> {
  await withTenant(tenantId, { type: "system" }, async (tx) => {
    // In SEQUENCE on the one connection (AGENTS.md).
    const contract = await tx.contract.findFirst({
      where: { tenantId, clientId, id: contractId, status: decision },
      select: { clientId: true, sentByMemberId: true },
    });
    if (!contract) return;
    const sender = contract.sentByMemberId
      ? await tx.member.findFirst({ where: { tenantId, id: contract.sentByMemberId, status: "ACTIVE" }, select: { id: true } })
      : null;
    // "You asked" — the sender asked the client for this signature. A sender
    // who has LEFT (no longer an active member) hands it to the workspace's
    // active OWNERS, so a client's answer never goes unheard (founder decision
    // C85 (f), 2026-10-11 — only in that case; otherwise the sender alone).
    const receivers = new Map<string, NotificationReason>(
      sender
        ? [[sender.id, "REQUESTER"]]
        : (
            await tx.member.findMany({
              where: { tenantId, status: "ACTIVE", memberRoles: { some: { role: { isSystem: true, templateKey: "owner" } } } },
              select: { id: true },
              orderBy: { id: "asc" },
            })
          ).map((m): [string, NotificationReason] => [m.id, "OWNER"]),
    );
    if (receivers.size > 0) {
      await emit(tx, tenantId, {
        kind: decision === "SIGNED" ? "contract.signed" : "contract.declined",
        entity: { type: "Contract", id: contractId },
        // NO ACTOR: no employee did this (the sign-off announcer's point).
        clientId: contract.clientId,
        receivers,
        params: { contractId, clientId: contract.clientId },
        // A contract is decided once: one row per contract.
        dedupeKey: `contract:${contractId}`,
      });
    }
    if (decision === "SIGNED") await enqueueContractMail(tx, tenantId, clientId, contractId, "signed");
  });
  if (decision === "SIGNED") {
    try {
      await ensureContractPdfAsSystem(tenantId, contractId, "signed");
    } catch (e) {
      // The sweep draws it (`makeMissingContractPdfs`); the name only — never a message.
      console.error(`contract ${contractId}: the signed copy was not drawn now (${e instanceof Error ? e.name : typeof e}); the jobs sweep will`);
    }
  }
}
