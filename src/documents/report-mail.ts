import type { TenantDb } from "@/db";
import { REPORT_MAIL_DROPPED, REPORT_PUBLISHED_MAIL, reportMailKey } from "@/notify/report-mail";

/**
 * THE ONE OUTBOX WRITER FOR A PUBLISHED REPORT'S MAILS (Phase 6 slice 115;
 * founder decision C91 (c)) — `src/notify/report-mail.ts` says what the mail
 * is. Called inside the publish's own transaction (the member's, as a
 * contract's send is — `src/modules/contracts/mail.ts`), so a row exists
 * exactly when the publish committed.
 *
 * TO EVERY PERSON AT THE CLIENT WITH PORTAL ACCESS — `portalStatus ACTIVE` and
 * invited, at a client not archived (the clients' weekly summary's admission,
 * `src/jobs/client-digests.ts`; C91 (b): main contacts AND the others) —
 * whose address is not suppressed. Whether each may actually SEE the report is
 * decided at send, as them, by the portal's own projection
 * (`src/jobs/outbox.ts`): a profile, a module or a pause in between is the
 * database's to answer then, not this list's now.
 *
 * ONCE PER PERSON PER REPORT (`reportMailKey`, `skipDuplicates`): publishing
 * again after a hide tells nobody twice; a person invited in between gets
 * theirs. A mail the outbox DROPPED unsent (`REPORT_MAIL_DROPPED` — the person
 * not reachable then, or the report hidden before it went) told nobody, so it
 * is made again here instead (the design review's L2). In the
 * person's language, else the workspace's. `params` holds the document's id
 * only — the month is read at send.
 */
export type ReportMailOutcome = {
  /** Rows written now — people never told about this report (or whose mail was dropped unsent). */
  readonly queued: number;
  /** Everyone at the client with portal access, told before or now. */
  readonly reachable: number;
  /** Of those, the ones whose address is not suppressed — who CAN be emailed (the code review's L2). */
  readonly mailable: number;
};

export async function enqueueReportMails(
  tx: TenantDb,
  tenantId: string,
  /** The report's client, restated in every read. */
  clientId: string,
  documentId: string,
): Promise<ReportMailOutcome> {
  // In SEQUENCE on the caller's one connection (AGENTS.md).
  const people = await tx.contact.findMany({
    where: { tenantId, clientId, portalStatus: "ACTIVE", invitedAt: { not: null }, client: { archivedAt: null } },
    select: { id: true, email: true, locale: true },
    orderBy: { id: "asc" },
  });
  if (people.length === 0) return { queued: 0, reachable: 0, mailable: 0 };
  const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { defaultLocale: true } });
  const suppressed = new Set(
    (
      await tx.emailSuppression.findMany({
        where: { email: { in: people.map((p) => p.email.toLowerCase()) } },
        select: { email: true },
      })
    ).map((s) => s.email),
  );
  const data = people
    .filter((p) => !suppressed.has(p.email.toLowerCase()))
    .map((p) => ({
      tenantId,
      idempotencyKey: reportMailKey(documentId, p.id),
      receiverType: "CONTACT" as const,
      receiverId: p.id,
      toEmail: p.email.toLowerCase(),
      kind: REPORT_PUBLISHED_MAIL,
      locale: (p.locale ?? tenant?.defaultLocale) === "sv" ? "sv" : "en",
      params: { documentId },
      notificationIds: [],
    }));
  if (data.length === 0) return { queued: 0, reachable: people.length, mailable: 0 };
  // A mail dropped unsent before — tagged by the outbox — is made again, at
  // the person's address and in their language NOW (an address changed since
  // would otherwise be refused at the claim for ever). Only a terminal,
  // tagged row: one queued, leased or sent is never touched.
  await tx.emailOutbox.deleteMany({
    where: {
      tenantId,
      kind: REPORT_PUBLISHED_MAIL,
      idempotencyKey: { in: data.map((d) => d.idempotencyKey) },
      status: "SKIPPED",
      lastError: { in: [...REPORT_MAIL_DROPPED] },
    },
  });
  const { count } = await tx.emailOutbox.createMany({ data, skipDuplicates: true });
  return { queued: count, reachable: people.length, mailable: data.length };
}
