import type { TenantDb } from "@/db";

import type { RateNets } from "./issue-check";
import { readFixed, type Minor } from "./money";

/**
 * WHAT AN INVOICE HAS BEEN CREDITED (Phase 4 slice 108b) — the reads the issue,
 * the credit verbs and the page share. Each is ONE statement under the
 * caller's transaction and RLS, read in sequence (AGENTS.md: never a leg of a
 * `Promise.all` inside an interactive transaction). Nets are summed per VAT
 * rate in the database, exactly (numeric), and read back as integers.
 */

const toNets = (rows: readonly { rate: string; net: string | null }[]): RateNets =>
  new Map(rows.filter((r) => r.net !== null).map((r) => [readFixed(r.rate, 2), readFixed(r.net!, 2)]));

/** One invoice's own lines, net per VAT rate. */
export async function readInvoiceNets(tx: TenantDb, invoiceId: string): Promise<RateNets> {
  return toNets(
    await tx.$queryRaw<{ rate: string; net: string | null }[]>`
      SELECT l.vat_rate_pct::text AS rate, sum(l.amount_ex_vat)::text AS net
        FROM invoice_line l
       WHERE l.invoice_id = ${invoiceId}
       GROUP BY l.vat_rate_pct`,
  );
}

/** What an invoice's ISSUED credit notes credit, net per VAT rate (drafts credit nothing yet). */
export async function readCreditedNets(tx: TenantDb, originalId: string): Promise<RateNets> {
  return toNets(
    await tx.$queryRaw<{ rate: string; net: string | null }[]>`
      SELECT l.vat_rate_pct::text AS rate, sum(l.amount_ex_vat)::text AS net
        FROM invoice_line l
        JOIN invoice cn ON cn.tenant_id = l.tenant_id AND cn.id = l.invoice_id
       WHERE cn.kind = 'CREDIT_NOTE' AND cn.credits_invoice_id = ${originalId} AND cn.status <> 'DRAFT'
       GROUP BY l.vat_rate_pct`,
  );
}

export type CreditNoteSummary = {
  readonly id: string;
  readonly status: "DRAFT" | "ISSUED";
  readonly displayNumber: string | null;
  readonly issueDate: Date | null;
  /** Hundredths, as stored (positive); null on a draft. Printed with a minus sign. */
  readonly total: Minor | null;
};

/** An invoice's credit notes, issued first in number order, then drafts newest first. */
export async function readCreditNotes(tx: TenantDb, originalId: string): Promise<CreditNoteSummary[]> {
  const rows = await tx.invoice.findMany({
    where: { kind: "CREDIT_NOTE", creditsInvoiceId: originalId },
    orderBy: [{ number: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }],
    take: 200,
    select: { id: true, status: true, displayNumber: true, issueDate: true, total: true },
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status === "DRAFT" ? "DRAFT" : "ISSUED",
    displayNumber: r.displayNumber,
    issueDate: r.issueDate,
    total: r.total === null ? null : readFixed(r.total, 2),
  }));
}
