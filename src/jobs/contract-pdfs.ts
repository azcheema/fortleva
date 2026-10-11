import { withPlatform } from "@/db";
import { CONTRACT_PDF_SWEEP_AFTER_MS, makeMissingContractPdfs } from "@/modules/contracts/pdf-store";

/**
 * THE CONTRACT PDFS' BACKSTOP (Phase 4 slice 112b) — the invoice PDFs' twin
 * (`invoice-pdfs.ts`). A sent contract's PDF is made right after the send; a
 * signed one's copy right after the signature (112b2). If either failed, this
 * makes it on the next kick, as each workspace's own SYSTEM principal, for
 * contracts over five minutes past that moment. It only ever ADDS a file:
 * nothing here deletes, re-draws or sends.
 */
export async function runContractPdfs(now: Date = new Date()): Promise<{ tenants: number; made: number; failed: number }> {
  const before = new Date(now.getTime() - CONTRACT_PDF_SWEEP_AFTER_MS);
  const tenantIds = await withPlatform(
    { type: "system", job: "contract-pdfs" },
    "list workspaces with a sent or signed contract missing its PDF",
    async (tx) =>
      (
        await tx.contract.findMany({
          where: {
            origin: "WRITTEN",
            OR: [
              { status: { not: "DRAFT" }, pdfFileId: null, sentAt: { lt: before } },
              { status: "SIGNED", signedPdfFileId: null, updatedAt: { lt: before } },
            ],
          },
          select: { tenantId: true },
          distinct: ["tenantId"],
        })
      ).map((r) => r.tenantId),
  );
  const out = { tenants: tenantIds.length, made: 0, failed: 0 };
  for (const tenantId of tenantIds) {
    try {
      const r = await makeMissingContractPdfs(tenantId, now);
      out.made += r.made;
      out.failed += r.failed;
    } catch (e) {
      out.failed += 1;
      console.error(`jobs: contract pdfs failed for a workspace: ${e instanceof Error ? e.name : typeof e}`);
    }
  }
  return out;
}
