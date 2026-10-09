import type { TenantDb } from "@/db";
import { fail } from "@/lib/domain-error";
import { lockContactBudget } from "@/portal/contact-budget-lock";

/**
 * The most a contact may download inside the window, counted on the
 * DATABASE'S clock from the audit rows the downloads themselves write
 * (`file.downloaded` and, since slice 109, `invoice.pdf_downloaded` — actor
 * CONTACT). A Postgres count and not the Upstash limiter, for the reason
 * `assertRequestBudget` gives: that limiter fails OPEN while Upstash is
 * unprovisioned, so it is the cheap front filter and this is the control.
 * Generous on purpose — a person opening a folder of deliverables one by one
 * is the ordinary use; this is sized to catch a script.
 */
export const DOWNLOAD_WINDOW_MINUTES = 15;
export const DOWNLOAD_WINDOW_LIMIT = 60;

/**
 * ONE DOWNLOAD BUDGET PER CONTACT, for every file the portal hands out — a
 * shared file (`src/documents/portal-writes.ts`) and, since slice 109, an
 * invoice's PDF (`src/modules/invoicing/portal-writes.ts`): the same lock key,
 * both actions counted (the slice-109 design review's nit — two budgets would
 * double it). Its own file, not a broker's: an exported function in a
 * `portal-writes.ts` IS a broker to `brokered-writes.test.ts`, and this one is
 * the step every broker that hands out a file takes INSIDE its system
 * transaction, after the contact's proof.
 */
export async function assertDownloadBudget(tx: TenantDb, tenantId: string, contactId: string): Promise<void> {
  const now = await lockContactBudget(tx, "portal_download", contactId);
  const since = new Date(now.getTime() - DOWNLOAD_WINDOW_MINUTES * 60_000);
  // The rows this contact's own downloads wrote, inside the window —
  // including ones for files since made private or deleted, because
  // the budget is about how often somebody may fetch, not what they own.
  const used = await tx.auditEvent.count({
    where: {
      tenantId,
      action: { in: ["file.downloaded", "invoice.pdf_downloaded"] },
      actorType: "CONTACT",
      actorId: contactId,
      createdAt: { gte: since },
    },
  });
  if (used >= DOWNLOAD_WINDOW_LIMIT) fail("DOWNLOAD_RATE_LIMITED");
}
