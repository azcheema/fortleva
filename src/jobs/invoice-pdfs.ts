import { withPlatform } from "@/db";
import { makeMissingInvoicePdfs, PDF_SWEEP_AFTER_MS } from "@/modules/invoicing/pdf-store";

/**
 * THE INVOICE PDFS' BACKSTOP (Phase 4 slice 108; the design review's low). An
 * issued invoice's PDF is made right after its issue, in the same server
 * action; if that failed (a render, an upload, a crash between), this makes it
 * on the next kick — as each workspace's own SYSTEM principal, for invoices
 * issued over five minutes ago — so an invoice is without its archived drawing
 * for minutes, never until someone happens to click Download. It only ever
 * ADDS a file: nothing here deletes, re-draws or sends.
 */
export async function runInvoicePdfs(now: Date = new Date()): Promise<{ tenants: number; made: number; failed: number }> {
  const tenantIds = await withPlatform(
    { type: "system", job: "invoice-pdfs" },
    "list workspaces with an issued invoice that has no PDF yet",
    async (tx) =>
      (
        await tx.invoice.findMany({
          where: { status: { not: "DRAFT" }, pdfFileId: null, issuedAt: { lt: new Date(now.getTime() - PDF_SWEEP_AFTER_MS) } },
          select: { tenantId: true },
          distinct: ["tenantId"],
        })
      ).map((r) => r.tenantId),
  );
  const out = { tenants: tenantIds.length, made: 0, failed: 0 };
  for (const tenantId of tenantIds) {
    try {
      const r = await makeMissingInvoicePdfs(tenantId, now);
      out.made += r.made;
      out.failed += r.failed;
    } catch (e) {
      out.failed += 1;
      console.error(`jobs: invoice pdfs failed for a workspace: ${e instanceof Error ? e.name : typeof e}`);
    }
  }
  return out;
}
