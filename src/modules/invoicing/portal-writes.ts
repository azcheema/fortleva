import { record } from "@/audit/record";
import { AuthzError, deny } from "@/authz/errors";
import { payLinkUrl } from "@/config";
import { withTenant } from "@/db";
import { assertDownloadBudget } from "@/documents/download-budget";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { attachmentDisposition } from "@/lib/http-download";
import { retryOnContention } from "@/lib/retry";
import { authorizePortal, withPortalRead, type PortalPrincipal } from "@/portal";
import { allow } from "@/ratelimit";
import { getStorage } from "@/storage";

import { readPaymentSnapshot, SnapshotUnreadable } from "./issued";
import type { PaymentPrint } from "./print";

/**
 * THE INVOICING MODULE'S PORTAL BROKERS (Phase 4 slice 109; founder decision
 * C79 (b), (c)) — what a client's invoice needs that a contact's own
 * transaction cannot read: its PDF (`file_object` is class A) and where to pay
 * it (the bank details are the tenant's v2 CIPHERTEXTS, copied at issue; the
 * Pay now link is decided against credit notes the client may not have).
 *
 * Every function here proves the invoice under the CONTACT first —
 * `authorizePortal(…, "portal.invoice.view", { kind: "invoice" })`, whose probe
 * `invoice`'s `portal_gate` and `portal_invoice_primary` answer (the client's
 * own, issued, SENT; a main contact) — and only then opens a SYSTEM
 * transaction, which restates the gate's every term on the row it reads
 * (`invoiceGate`): between the two the agency could do nothing that unsends an
 * invoice, but the restatement is every broker's belt
 * (`src/portal/brokered-writes.test.ts` pins the order).
 */

/** Presigned GETs live this long (SECURITY §5); the documents' own. */
const GET_EXPIRES_SEC = 60;
/** A client pressing a button is told to try again rather than parked. */
const PORTAL_LOCK_WAIT_MS = 3000;

/** `portal_gate`'s terms, restated on the invoice row for a SYSTEM read. */
const invoiceGate = (principal: PortalPrincipal) => ({
  tenantId: principal.tenantId,
  clientId: principal.clientId,
  status: { not: "DRAFT" as const },
  sentAt: { not: null },
});

/**
 * DOWNLOAD A SENT INVOICE'S PDF (`portal.invoice.view`) — the archived bytes,
 * as a short-lived off-origin link with `Content-Disposition: attachment`
 * (SECURITY §5), audited to the CONTACT (`invoice.pdf_downloaded`) BEFORE the
 * link is minted, on the contact's one download budget (shared with files).
 * An invoice whose PDF is not made yet (a marked one, before the jobs route's
 * sweep) answers NOT_FOUND like everything else on this plane.
 */
export async function resolvePortalInvoicePdf(
  principal: PortalPrincipal,
  invoiceId: string,
): Promise<{ readonly url: string; readonly filename: string }> {
  // The belt every broker carries: an empty id never reaches a system `where`.
  if (!invoiceId) fail("INVALID_INPUT", "invoice");
  if (!(await allow("portal.document_download", principal.contactId))) fail("DOWNLOAD_RATE_LIMITED", "front filter");

  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.invoice.view", { kind: "invoice", invoiceId }));

  const download = () =>
    withTenant(
      principal.tenantId,
      { type: "system" },
      async (tx) => {
        await assertDownloadBudget(tx, principal.tenantId, principal.contactId);
        const invoice = await tx.invoice.findFirst({
          where: { id: invoiceId, ...invoiceGate(principal) },
          select: { id: true, displayNumber: true, pdfFile: { select: { id: true, r2Key: true, originalFilename: true, status: true } } },
        });
        const file = invoice?.pdfFile;
        if (!invoice || !file || file.status !== "COMMITTED") return deny("NOT_FOUND", "invoice pdf");
        await record(tx, {
          action: "invoice.pdf_downloaded",
          targetType: "Invoice",
          targetId: invoice.id,
          // The contact, not the system transaction (`record()`'s own note).
          brokeredForContactId: principal.contactId,
          // Ids only, never the file name (SECURITY §7).
          metadata: { fileObjectId: file.id, clientId: principal.clientId },
        });
        return { key: file.r2Key, filename: file.originalFilename ?? `${invoice.displayNumber ?? invoice.id}.pdf` };
      },
      { lockTimeoutMs: PORTAL_LOCK_WAIT_MS },
    );
  let target: Awaited<ReturnType<typeof download>>;
  try {
    target = await retryOnContention(download);
  } catch (e) {
    if (isLockTimeout(e) || isDeadlock(e)) return fail("DOWNLOAD_BUSY", "lock waits spent");
    throw e;
  }
  // Outside the transaction: network I/O never holds a connection open.
  const url = await getStorage().presignGet(target.key, {
    expiresSec: GET_EXPIRES_SEC,
    responseContentDisposition: attachmentDisposition(target.filename),
    responseContentType: "application/pdf",
  });
  return { url, filename: target.filename };
}

export type PortalInvoicePayment = {
  /**
   * The agency's Pay now link (C79 (c)) — only while the invoice is still to be
   * paid AND nothing of it has been credited (a fixed-amount link would
   * overcharge — the design review's M1, decided here as SYSTEM, which sees
   * every credit note), and only for a contact who may pay
   * (`portal.invoice.pay`). Re-checked against today's fence.
   */
  readonly payLink: string | null;
  /** Where to pay by bank, as the invoice prints it — while it is to be paid. */
  readonly bank: PaymentPrint | null;
};

/**
 * WHERE TO PAY ONE SENT INVOICE — a BROKERED READ (nothing happens, nothing is
 * audited): the bank details decrypted from the invoice's own frozen payment
 * snapshot (an unreadable one reads as missing — the PDF still has them), and
 * the Pay now link while it is payable. Nothing for a credit note, a paid or a
 * credited invoice.
 */
export async function readPortalInvoicePayment(principal: PortalPrincipal, invoiceId: string): Promise<PortalInvoicePayment> {
  if (!invoiceId) fail("INVALID_INPUT", "invoice");
  const mayPay = await withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.invoice.view", { kind: "invoice", invoiceId });
    try {
      await authorizePortal(tx, principal, "portal.invoice.pay", { kind: "invoice", invoiceId });
      return true;
    } catch (e) {
      if (e instanceof AuthzError) return false;
      throw e;
    }
  });
  return withTenant(principal.tenantId, { type: "system" }, async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, ...invoiceGate(principal), kind: "INVOICE", status: { in: ["ISSUED", "SENT"] } },
      select: { id: true, payLinkUrl: true, paymentSnapshot: true },
    });
    if (!invoice) return { payLink: null, bank: null };
    const credited = await tx.invoice.count({
      where: { tenantId: principal.tenantId, kind: "CREDIT_NOTE", creditsInvoiceId: invoice.id, status: { not: "DRAFT" } },
    });
    const link = invoice.payLinkUrl !== null ? payLinkUrl(invoice.payLinkUrl) : null;
    let bank: PaymentPrint | null = null;
    try {
      const { payment } = await readPaymentSnapshot(tx, principal.tenantId, invoice.paymentSnapshot, false);
      bank = payment.bankgiro || payment.plusgiro || payment.iban ? payment : null;
    } catch (e) {
      // A malformed snapshot reads as no bank details here; the PDF is the record.
      if (!(e instanceof SnapshotUnreadable)) throw e;
    }
    return { payLink: mayPay && credited === 0 && link ? link.href : null, bank };
  });
}
