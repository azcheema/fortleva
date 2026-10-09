import { createHash } from "node:crypto";

import { record } from "@/audit/record";
import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { attachmentDisposition } from "@/lib/http-download";
import { newId } from "@/lib/ids";
import { getStorage } from "@/storage";

import type { InvoicingCtx } from "./drafts";
import { readIssuedInvoice, SnapshotUnreadable } from "./issued";

/**
 * AN ISSUED INVOICE'S PDF, MADE ONCE AND KEPT (Phase 4 slice 108). The issued
 * row is the record; its PDF is that record drawn — once, after the issue
 * commits (a render and an upload never hold the series), stored in the
 * tenant's bucket as a committed INVOICE_PDF file and recorded on the invoice
 * (`pdf_file_id`, set once — the guard refuses a second; the file's own row
 * is frozen by `file_object_invoice_pdf_guard` and RESTRICTed by the invoice).
 * Never re-rendered: a later download, and slice 109's send, use these bytes.
 *
 * FAIL CLOSED (the design review's medium). The drawing reads the frozen
 * record STRICTLY: a snapshot it cannot read, a bank detail it cannot
 * decrypt, a render that throws — each refuses with INVOICE_PDF_UNAVAILABLE
 * and stores nothing. A degraded drawing (no bank details) recorded once
 * would be the archive forever.
 *
 * WHO MAKES IT: the member who issued it, in the same server action, right
 * after the issue; anyone who may view the invoice, on Download, if that
 * failed; and the jobs route's sweep (`makeMissingInvoicePdfs`, as the
 * workspace's SYSTEM principal) for any issued over five minutes ago without
 * one — so the gap is minutes, not "until someone clicks" (the design
 * review's low). Two at once: both draw and upload, ONE records (the
 * set-once update), the other deletes its own upload and returns the winner.
 *
 * `invoice.pdf_generated` names the file, its hash and size, and the
 * drawing's TEMPLATE VERSION — which layout the archived bytes are.
 */

/** Which drawing this is. Raise it whenever `pdf/invoice-pdf.tsx` changes what a PDF looks like. */
export const INVOICE_PDF_TEMPLATE_VERSION = 1;

type Principal = { readonly type: "member"; readonly id: string } | { readonly type: "system" };

class LostRace extends Error {}

/** What a log line may say about an error: its name and code, never its message. */
export const errorTag = (e: unknown): string => {
  if (!(e instanceof Error)) return typeof e;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? `${e.name} (${code})` : e.name;
};

export type InvoicePdf = {
  readonly fileObjectId: string;
  readonly r2Key: string;
  readonly fileName: string;
  /** Drawn and recorded by THIS call (the page that showed "not made yet" is stale). */
  readonly created: boolean;
};

/** The recorded PDF's file, read inside a transaction. */
async function recordedPdf(tx: TenantDb, invoiceId: string): Promise<InvoicePdf | null> {
  const row = await tx.invoice.findFirst({
    where: { id: invoiceId },
    select: { pdfFile: { select: { id: true, r2Key: true, originalFilename: true } } },
  });
  const file = row?.pdfFile;
  if (!file) return null;
  return { fileObjectId: file.id, r2Key: file.r2Key, fileName: file.originalFilename ?? `${file.id}.pdf`, created: false };
}

/** Draw, store and record the PDF of one issued invoice — the caller has checked who may. */
async function makePdf(tenantId: string, principal: Principal, invoiceId: string, now: Date): Promise<InvoicePdf> {
  const read = await withTenant(tenantId, principal, async (tx) => {
    const existing = await recordedPdf(tx, invoiceId);
    if (existing) return { kind: "existing", pdf: existing } as const;
    try {
      const issued = await readIssuedInvoice(tx, tenantId, invoiceId, { strict: true });
      if (!issued) return deny("NOT_FOUND");
      return { kind: "issued", issued } as const;
    } catch (e) {
      if (e instanceof SnapshotUnreadable) {
        console.error(`invoice pdf: ${e.message} (invoice ${invoiceId})`);
        return fail("INVOICE_PDF_UNAVAILABLE");
      }
      throw e;
    }
  });
  if (read.kind === "existing") return read.pdf;
  const print = read.issued.print;

  // The renderer is loaded HERE, when a PDF is drawn — never at import: it is
  // ESM-only, and a CommonJS importer of this module (a tsx script) must still
  // load.
  let renderer: typeof import("./pdf/invoice-pdf");
  try {
    renderer = await import("./pdf/invoice-pdf");
  } catch (e) {
    console.error(`invoice pdf: the renderer did not load (invoice ${invoiceId}): ${errorTag(e)}`);
    return fail("INVOICE_PDF_UNAVAILABLE");
  }
  const { invoicePdfFileName, renderInvoicePdf } = renderer;
  let bytes: Uint8Array;
  try {
    bytes = await renderInvoicePdf(print);
  } catch (e) {
    console.error(`invoice pdf: render failed (invoice ${invoiceId}): ${errorTag(e)}`);
    return fail("INVOICE_PDF_UNAVAILABLE");
  }
  const fileObjectId = newId();
  const r2Key = `${tenantId}/${fileObjectId}`;
  const fileName = invoicePdfFileName(print);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // The storage too is "try again", never a raw error: a deployment without
  // its bucket (the browser harness's production build — local disk is
  // dev-only) refuses here, after the drawing, with the same sentence.
  let storage: ReturnType<typeof getStorage>;
  try {
    storage = getStorage();
    await storage.putObject(r2Key, bytes, "application/pdf");
  } catch (e) {
    console.error(`invoice pdf: upload failed (invoice ${invoiceId}): ${errorTag(e)}`);
    return fail("INVOICE_PDF_UNAVAILABLE");
  }

  try {
    await withTenant(tenantId, principal, async (tx) => {
      await tx.fileObject.create({
        data: {
          id: fileObjectId,
          tenantId,
          r2Key,
          kind: "INVOICE_PDF",
          sha256,
          sizeBytes: BigInt(bytes.byteLength),
          contentType: "application/pdf",
          originalFilename: fileName,
          status: "COMMITTED",
          committedAt: now,
          createdByMemberId: principal.type === "member" ? principal.id : null,
        },
        select: { id: true },
      });
      // Set once: whoever records first wins; the guard refuses any change after.
      const set = await tx.invoice.updateMany({
        where: { id: invoiceId, pdfFileId: null, status: { not: "DRAFT" } },
        data: { pdfFileId: fileObjectId },
      });
      if (set.count === 0) throw new LostRace();
      // Counted against the workspace's storage, never refused on it: a
      // bookkeeping record is kept whatever the plan (BFL).
      await tx.tenant.update({
        where: { id: tenantId },
        data: { storageUsedBytes: { increment: BigInt(bytes.byteLength) } },
        select: { id: true },
      });
      await record(tx, {
        action: "invoice.pdf_generated",
        targetType: "Invoice",
        targetId: invoiceId,
        metadata: { fileObjectId, sha256, sizeBytes: bytes.byteLength, templateVersion: INVOICE_PDF_TEMPLATE_VERSION },
      });
    });
  } catch (e) {
    // What the invoice points at NOW decides (the security review's low): an
    // ambiguous failure — a dropped connection during COMMIT — can leave the
    // record committed, and deleting its bytes then would leave an invoice
    // pointing at nothing, for good (its pdf_file_id and the file's row are
    // frozen). So the upload goes only when the invoice is not ours.
    let recorded: InvoicePdf | null = null;
    try {
      recorded = await withTenant(tenantId, principal, (tx) => recordedPdf(tx, invoiceId));
    } catch {
      // Unknown: keep the bytes. An orphan costs storage; a deleted record costs the archive.
      throw e;
    }
    if (recorded?.fileObjectId === fileObjectId) return { ...recorded, created: true };
    await storage.delete(r2Key).catch(() => undefined);
    // Another call's PDF is recorded: the invoice has its PDF, whatever ours met.
    if (recorded) return recorded;
    if (e instanceof LostRace) return fail("INVOICE_PDF_UNAVAILABLE");
    throw e;
  }
  return { fileObjectId, r2Key, fileName, created: true };
}

/**
 * `invoice:view` + the client in scope — the issued invoice's PDF, made now
 * if it was not yet. The member who issues, and anyone who downloads.
 */
export async function ensureInvoicePdf(ctx: InvoicingCtx, invoiceId: string, now: Date = new Date()): Promise<InvoicePdf> {
  const principal = { type: "member", id: ctx.actor.memberId } as const;
  await withTenant(ctx.tenantId, principal, async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
    const scoped = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { clientId: true, status: true } });
    if (!scoped) return deny("NOT_FOUND");
    await assertInScope(tx, ctx.actor, { clientId: scoped.clientId });
    if (scoped.status === "DRAFT") return fail("INVOICE_NOT_READY");
  });
  return makePdf(ctx.tenantId, principal, invoiceId, now);
}

/** A download link's life — the documents' own (`src/documents/service.ts`). */
const PDF_URL_EXPIRES_SEC = 60;

/**
 * `invoice:view` + the client in scope — a short-lived, attachment-only,
 * off-origin link to the issued invoice's PDF (SECURITY §5), making it first
 * if it was not yet. Asked for by a server action (a POST), so a cross-site
 * link cannot make one.
 */
export async function invoicePdfUrl(
  ctx: InvoicingCtx,
  invoiceId: string,
): Promise<{ readonly url: string; readonly fileName: string; readonly created: boolean }> {
  const pdf = await ensureInvoicePdf(ctx, invoiceId);
  const url = await getStorage().presignGet(pdf.r2Key, {
    expiresSec: PDF_URL_EXPIRES_SEC,
    responseContentDisposition: attachmentDisposition(pdf.fileName),
    responseContentType: "application/pdf",
  });
  return { url, fileName: pdf.fileName, created: pdf.created };
}

/** How long after its issue an invoice without a PDF is the sweep's (the issuer's own attempt first). */
export const PDF_SWEEP_AFTER_MS = 5 * 60_000;
/** At most this many PDFs per workspace per kick. */
export const PDF_SWEEP_BATCH = 20;

/**
 * The jobs route's sweep for ONE workspace, as its SYSTEM principal: every
 * issued invoice older than five minutes with no PDF gets one. Each failure is
 * its own (logged, retried next kick). NEWEST FIRST (both reviews' low): an
 * invoice that can never be drawn — a snapshot unreadable after its key was
 * destroyed — would otherwise sit at the head of every batch, and twenty of
 * them would starve every newer invoice for good. Returns how many were made
 * and failed.
 */
export async function makeMissingInvoicePdfs(tenantId: string, now: Date = new Date()): Promise<{ made: number; failed: number }> {
  const principal = { type: "system" } as const;
  const due = await withTenant(tenantId, principal, (tx) =>
    tx.invoice.findMany({
      where: { status: { not: "DRAFT" }, pdfFileId: null, issuedAt: { lt: new Date(now.getTime() - PDF_SWEEP_AFTER_MS) } },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      take: PDF_SWEEP_BATCH,
      select: { id: true },
    }),
  );
  const out = { made: 0, failed: 0 };
  for (const { id } of due) {
    try {
      await makePdf(tenantId, principal, id, now);
      out.made += 1;
    } catch (e) {
      out.failed += 1;
      console.error(`jobs: invoice pdf failed (invoice ${id}): ${errorTag(e)}`);
    }
  }
  return out;
}
