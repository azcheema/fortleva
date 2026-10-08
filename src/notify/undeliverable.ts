import type { TenantDb } from "@/db";

/**
 * WHICH OF THESE ADDRESSES CAN FORTLEVA NOT MAIL? (Phase 5 slice 103, founder
 * decision C71 (d)) — for the note "Emails to this address aren't being
 * delivered" beside a person on a client's Contacts tab and on Members.
 *
 * Read inside the page's own transaction (`email_suppression` is global:
 * `app_runtime` may read it under any principal but a contact's). Lower-cased
 * in and out, as every suppression check compares. Answers WHETHER, never
 * why: the list holds bounces and spam reports from every workspace's mail,
 * and the reason may be another agency's business (C71 (d)) — so nothing but
 * the address is selected.
 *
 * Call it in SEQUENCE after a page's batch of reads, never as a leg of one
 * (AGENTS.md: a `Promise.all` inside an interactive transaction).
 */
export async function undeliverableAmong(tx: TenantDb, emails: readonly string[]): Promise<Set<string>> {
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0))];
  if (wanted.length === 0) return new Set();
  const rows = await tx.emailSuppression.findMany({ where: { email: { in: wanted } }, select: { email: true } });
  return new Set(rows.map((r) => r.email));
}
