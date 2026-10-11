import type { TenantDb } from "@/db";
import { CONTRACT_SENT_MAIL, CONTRACT_SIGNED_MAIL } from "@/notify/contract-mail-keys";

/**
 * THE ONE OUTBOX WRITER FOR A CONTRACT'S CLIENT MAILS (Phase 4 slice 112b2;
 * C85 (b)) — `src/notify/contract-mail-keys.ts` says what each mail is. Called
 * inside the caller's transaction: the SEND's (the member's own — the login
 * ask's precedent, `src/modules/vault/asks.ts`) and the announcer's after a
 * signature (the workspace's SYSTEM principal; `sign-announce.ts`, whose every
 * import — this, `emit` and the PDF store — `src/portal/brokered-writes.test.ts`
 * pins by name).
 *
 * To the contract's CLIENT signer — the contact their signature row names (the
 * guard's copy, never the app's), at that person's address now — in the
 * CONTRACT's language. A suppressed address gets nothing — the worker checks
 * again at send — and the contract stands either way: the mail is the
 * courtesy, the portal the truth. Exactly once per contract and kind (the
 * idempotency key), so a retried send or a re-run announcement mails nobody
 * twice. `params` holds the contract's id only — the link's (ARC-09).
 */

export type ContractMailKind = "sent" | "signed";

const TEMPLATE = { sent: CONTRACT_SENT_MAIL, signed: CONTRACT_SIGNED_MAIL } as const;

/** Whether the mail was enqueued, or why not. */
export type ContractMailOutcome = "queued" | "suppressed" | "no_signer";

export async function enqueueContractMail(
  tx: TenantDb,
  tenantId: string,
  /** The contract's client, restated in every read (a SYSTEM caller's belt). */
  clientId: string,
  contractId: string,
  kind: ContractMailKind,
): Promise<ContractMailOutcome> {
  // In SEQUENCE on the caller's one connection (AGENTS.md).
  const contract = await tx.contract.findFirst({
    where: { tenantId, clientId, id: contractId, origin: "WRITTEN", status: kind === "sent" ? "SENT" : "SIGNED" },
    select: { language: true },
  });
  if (!contract) return "no_signer";
  const signer = await tx.contractSignature.findFirst({
    where: { tenantId, clientId, contractId, party: "CLIENT" },
    select: { signerContactId: true },
  });
  if (!signer?.signerContactId) return "no_signer";
  // The person's address NOW, not the one their signature row froze at
  // sending (the pre-apply review's nit): a "signed" mail may follow the send
  // by weeks, and an address changed meanwhile is where they read mail.
  const contact = await tx.contact.findFirst({
    where: { tenantId, clientId, id: signer.signerContactId },
    select: { email: true },
  });
  if (!contact?.email) return "no_signer";
  const to = contact.email.toLowerCase();
  const suppressed = await tx.emailSuppression.findFirst({ where: { email: to }, select: { email: true } });
  if (suppressed) return "suppressed";
  await tx.emailOutbox.createMany({
    data: [
      {
        tenantId,
        idempotencyKey: `contract:${contractId}:${kind}:CONTACT:${signer.signerContactId}`,
        receiverType: "CONTACT",
        receiverId: signer.signerContactId,
        toEmail: to,
        kind: TEMPLATE[kind],
        locale: contract.language === "sv" ? "sv" : "en",
        params: { contractId },
        notificationIds: [],
      },
    ],
    skipDuplicates: true,
  });
  return "queued";
}
