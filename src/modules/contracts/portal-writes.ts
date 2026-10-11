import { record } from "@/audit/record";
import { deny } from "@/authz/errors";
import { withTenant } from "@/db";
import { assertDownloadBudget } from "@/documents/download-budget";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { attachmentDisposition } from "@/lib/http-download";
import { retryOnContention } from "@/lib/retry";
import { authorizePortal, withPortalRead, type PortalPrincipal } from "@/portal";
import { allow } from "@/ratelimit";
import { getStorage } from "@/storage";

/**
 * THE CONTRACTS MODULE'S PORTAL BROKER (Phase 4 slice 112b2; founder decision
 * C85 (b)) — what a client's contract needs that a contact's own transaction
 * cannot read: its PDFs (`file_object` is class A). The PDF AS SENT, once the
 * contract was sent; the SIGNED COPY, once it is signed (C85 (b): the client's
 * signed copy is in their portal).
 *
 * It proves the contract under the CONTACT first —
 * `authorizePortal(…, "portal.contract.view", { kind: "contract" })`, whose
 * probe `contract`'s `portal_gate` and `portal_contract_primary` answer (the
 * client's own, sent, a main contact) — and only then opens a SYSTEM
 * transaction, which restates the gate's every term on the row it reads
 * (`src/portal/brokered-writes.test.ts` pins the order). Mirrors the invoice
 * broker (`src/modules/invoicing/portal-writes.ts`).
 */

/** Presigned GETs live this long (SECURITY §5); the documents' own. */
const GET_EXPIRES_SEC = 60;
/** A client pressing a button is told to try again rather than parked. */
const PORTAL_LOCK_WAIT_MS = 3000;

export type PortalContractPdfKind = "sent" | "signed";

/**
 * DOWNLOAD A SENT CONTRACT'S PDF, OR ITS SIGNED COPY (`portal.contract.view`) —
 * the archived bytes, as a short-lived off-origin link with
 * `Content-Disposition: attachment` (SECURITY §5), audited to the CONTACT
 * (`contract.pdf_downloaded`) BEFORE the link is minted, on the contact's one
 * download budget (shared with files and invoices). A PDF not made yet (the
 * jobs route's sweep makes it within minutes) answers NOT_FOUND like
 * everything else on this plane — the page offers the button only once the
 * projection says the file is there.
 */
export async function resolvePortalContractPdf(
  principal: PortalPrincipal,
  contractId: string,
  kind: PortalContractPdfKind,
): Promise<{ readonly url: string; readonly filename: string }> {
  // The belt every broker carries: an empty id never reaches a system `where`.
  if (!contractId) fail("INVALID_INPUT", "contract");
  if (kind !== "sent" && kind !== "signed") fail("INVALID_INPUT", "kind");
  if (!(await allow("portal.document_download", principal.contactId))) fail("DOWNLOAD_RATE_LIMITED", "front filter");

  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.contract.view", { kind: "contract", contractId }));

  const download = () =>
    withTenant(
      principal.tenantId,
      { type: "system" },
      async (tx) => {
        await assertDownloadBudget(tx, principal.tenantId, principal.contactId);
        const contract = await tx.contract.findFirst({
          where: {
            id: contractId,
            // `portal_gate`'s terms, restated for a SYSTEM read — and SIGNED for the signed copy.
            tenantId: principal.tenantId,
            clientId: principal.clientId,
            origin: "WRITTEN",
            sentAt: { not: null },
            status: kind === "signed" ? "SIGNED" : { not: "DRAFT" },
          },
          select: {
            id: true,
            pdfFile: { select: { id: true, r2Key: true, originalFilename: true, status: true } },
            signedPdf: { select: { id: true, r2Key: true, originalFilename: true, status: true } },
          },
        });
        const file = kind === "signed" ? contract?.signedPdf : contract?.pdfFile;
        if (!contract || !file || file.status !== "COMMITTED") return deny("NOT_FOUND", "contract pdf");
        await record(tx, {
          action: "contract.pdf_downloaded",
          targetType: "Contract",
          targetId: contract.id,
          // The contact, not the system transaction (`record()`'s own note).
          brokeredForContactId: principal.contactId,
          // Ids only, never the file name (SECURITY §7).
          metadata: { kind, fileObjectId: file.id, clientId: principal.clientId },
        });
        return { key: file.r2Key, filename: file.originalFilename ?? `${contract.id}.pdf` };
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
