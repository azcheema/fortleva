"use server";

import { redirect } from "next/navigation";

import { field } from "@/lib/server-actions";
import { resolvePortalInvoicePdf } from "@/modules/invoicing/portal-writes";
import { runPortalAction } from "@/portal/action";
import { requirePortalContext } from "@/portal/context";

/**
 * DOWNLOAD A SENT INVOICE'S PDF (Phase 4 slice 109; C79 (b)) — the files
 * page's download, for an invoice (`files/actions.ts` says the rest at
 * length): the principal from the SESSION and nowhere else; the invoice id an
 * argument that names a row and never widens what is reachable
 * (`resolvePortalInvoicePdf` proves it under the contact and restates the
 * gate as SYSTEM); success redirects off-origin to a short-lived
 * attachment-only link; a refusal lands back on the invoice's own page with
 * one of two words — `rate` (the reader's own budget) or `download`
 * (everything else, a fact about the agency).
 */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function downloadInvoiceAction(formData: FormData): Promise<void> {
  const raw = field(formData, "invoiceId") ?? "";
  // Only an id shapes the landing path — never an open redirect.
  const invoiceId = ID.test(raw) ? raw : "";
  const returnTo = invoiceId ? `/portal/invoices/${invoiceId}` : "/portal/invoices";
  const { principal } = await requirePortalContext();
  const result = await runPortalAction("downloadInvoice", () => resolvePortalInvoicePdf(principal, invoiceId));
  if (!result.ok) {
    redirect(`${returnTo}?error=${result.code === "DOWNLOAD_RATE_LIMITED" ? "rate" : "download"}`);
  }
  redirect(result.value.url);
}
