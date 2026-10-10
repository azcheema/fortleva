import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";

import { readLiveParties } from "./parties";
import { contractPdfFileName, isContractLocale, type ContractPrint } from "./print";
import { memberPrincipal, type ContractsCtx } from "./templates";

/**
 * A DRAFT'S PREVIEW PDF (Phase 4 slice 112) — `contract:view`, the client in
 * scope: the draft as it stands, both parties read LIVE, "Draft — not sent"
 * on every page. Drawn on demand and never stored: it is not a record, and
 * slice 112b's send draws the PDF that is. Not audited — a read of the
 * agency's own draft, nothing leaves it (the invoice preview's precedent is
 * the page itself).
 *
 * The renderer is loaded with a dynamic `import()`: `@react-pdf/renderer` is
 * ESM-only (`pdf-store.ts` says why).
 */
export async function contractPreviewPdf(
  ctx: ContractsCtx,
  id: string,
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const print = await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx): Promise<ContractPrint> => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:view");
    const row = await tx.contract.findFirst({
      where: { tenantId: ctx.tenantId, id },
      select: { clientId: true, title: true, version: true, language: true, body: true, status: true },
    });
    if (!row) return deny("NOT_FOUND", "contract");
    await assertInScope(tx, ctx.actor, { clientId: row.clientId });
    // Slice 112: only a draft exists. A sent contract's PDF is the archived
    // one (112b), drawn from its frozen parties — never this live preview.
    if (row.status !== "DRAFT") fail("CONTRACT_NOT_DRAFT");
    const locale = isContractLocale(row.language) ? row.language : "sv";
    const live = await readLiveParties(tx, ctx.tenantId, row.clientId, locale);
    return { locale, title: row.title, version: row.version, draft: true, parties: live.parties, body: row.body };
  });
  const { renderContractPdf } = await import("./pdf/contract-pdf");
  const bytes = await renderContractPdf(print);
  return { bytes, fileName: contractPdfFileName(print.title, print.version) };
}
