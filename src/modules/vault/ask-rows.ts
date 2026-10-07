import type { TenantDb } from "@/db";
import type { PortalPrincipal } from "@/portal";

/**
 * THE ASK'S ROW, AS THE PORTAL'S BROKER READS AND ENDS IT (Phase 3V slice
 * 98; founder decision C66) — kept out of the broker's own file
 * (`submission-portal-writes.ts`), which may not name the column a send
 * stamps (the login's id never reaches the client). In the portal
 * tripwire's STRUCTURAL tier (`src/authz/portal-projections.test.ts`), so a
 * select-less read added here later still trips it; the row LOCK, which is
 * raw SQL that tier refuses, is `ask-lock.ts`'s.
 *
 * Every read is bounded by the PRINCIPAL — the tenant, the contact's own
 * client and the contact themself — so an ask id from a URL names nothing
 * but one of this contact's own asks: another contact's, another
 * client's, another tenant's answer exactly as no ask at all.
 */

export type HeldAsk = {
  readonly clientId: string;
  readonly projectId: string | null;
  /** No send, decline or cancellation yet. */
  readonly open: boolean;
};

/** The ask, unlocked — the broker's pre-read, before its locks (`lockAskOf` holds it). */
export async function readAskOf(tx: TenantDb, principal: PortalPrincipal, askId: string): Promise<HeldAsk | null> {
  const row = await tx.credentialAsk.findFirst({
    where: { tenantId: principal.tenantId, id: askId, clientId: principal.clientId, contactId: principal.contactId },
    select: { clientId: true, projectId: true, sentAt: true, declinedAt: true, cancelledAt: true },
  });
  if (!row) return null;
  return {
    clientId: row.clientId,
    projectId: row.projectId,
    open: row.sentAt === null && row.declinedAt === null && row.cancelledAt === null,
  };
}

/**
 * THE SEND ENDS THE ASK, naming the login it became — after the broker
 * holds the ask (`lockAskOf`) and has written the login in this same
 * transaction. The database holds that the login is the asked contact's,
 * on the ask's anchor, just made, and named by no other ask
 * (`credential_ask_guard`, `credential_ask_sent_credential_unique`). Here,
 * not in the broker's file, because a login's id is a column no portal
 * surface may name (it never reaches the client).
 *
 * WHAT "JUST MADE" MEANS TO THE GUARD (the security review's nit, recorded
 * because the applied migration cannot change): `xmin` is the transaction
 * that wrote the login's CURRENT row version — an UPDATE in this
 * transaction counts as much as the INSERT. No product path updates an
 * older hand-over before a send; a writer that ever does must not then
 * name it here (a later migration could add `created_at >= now() - slack`
 * as a belt). The partial UNIQUE still caps it at one ask per login.
 */
export async function markAskSent(tx: TenantDb, askId: string, credentialId: string): Promise<void> {
  await tx.credentialAsk.update({
    where: { id: askId },
    data: { sentAt: new Date(), sentCredentialId: credentialId },
    select: { id: true },
  });
}

/** The project's key, for the decline's link — none for an ask on the company itself. */
export async function projectKeyOf(tx: TenantDb, tenantId: string, projectId: string | null): Promise<string | null> {
  if (projectId === null) return null;
  const p = await tx.project.findFirst({ where: { tenantId, id: projectId }, select: { key: true } });
  return p?.key ?? null;
}
