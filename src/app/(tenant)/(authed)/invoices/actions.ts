"use server";

import { revalidatePath } from "next/cache";
import { getLocale, getTranslations } from "next-intl/server";

import { isUuid } from "@/db/context";
import { DomainError } from "@/lib/domain-error";
import { caution, runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  addLine,
  createDraft,
  deleteDraft,
  issueInvoice,
  moveLine,
  removeLine,
  setDraftVatProfile,
  updateDraftDetails,
  updateLine,
  type DraftDetailsPatch,
  type LineInput,
} from "@/modules/invoicing";
import { ensureInvoicePdf, errorTag, invoicePdfUrl } from "@/modules/invoicing/pdf-store";

/**
 * Server actions for /invoices (Phase 4 slice 107). Tenant and actor come
 * from the session, never from a parameter; `src/modules/invoicing/drafts.ts`
 * checks the permission, the client scope and the draft's state, and audits.
 * Each action only parses — an id that is not a uuid is refused here so it
 * never reaches a query.
 */

const LIST = "/invoices";
const pageOf = (invoiceId: string) => `/invoices/${invoiceId}`;

const ctxOf = async () => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

const invalid = async (): Promise<FormResult> => {
  const tCommon = await getTranslations("common");
  return { ok: false, message: tCommon("invalidInput") };
};

/** How this member types decimals: a Swedish reader's comma is the decimal separator. */
const lineParse = async () => ({ decimalComma: (await getLocale()).startsWith("sv") });

const strOrNull = (v: unknown): string | null | undefined =>
  v === undefined ? undefined : v === null ? null : typeof v === "string" ? v : undefined;

/** A new draft; the answer carries its id so the page navigates to it. */
export async function createDraftAction(clientId: unknown, projectId: unknown): Promise<ActionResult<string>> {
  if (typeof clientId !== "string" || !isUuid(clientId)) return { ok: false, message: (await invalid()).message };
  if (projectId !== null && projectId !== undefined && (typeof projectId !== "string" || (projectId !== "" && !isUuid(projectId)))) {
    return { ok: false, message: (await invalid()).message };
  }
  const ctx = await ctxOf();
  const r = await runAction(LIST, () => createDraft(ctx, { clientId, projectId: projectId ? projectId : null }));
  if (r.ok) revalidatePath(LIST);
  return r;
}

/** One or more of the draft's details. */
export async function updateDraftDetailsAction(invoiceId: unknown, patch: unknown): Promise<FormResult> {
  if (typeof invoiceId !== "string" || !isUuid(invoiceId) || typeof patch !== "object" || patch === null) return invalid();
  const input = patch as Record<string, unknown>;
  const allowed: (keyof DraftDetailsPatch)[] = [
    "projectId",
    "currency",
    "paymentTermsDays",
    "periodStart",
    "periodEnd",
    "buyerReference",
    "ourReference",
    "note",
    "locale",
  ];
  const clean: Record<string, unknown> = {};
  for (const key of allowed) {
    if (!(key in input)) continue;
    const v = strOrNull(input[key]);
    if (v === undefined) return invalid();
    if (key === "projectId" && v !== null && v !== "" && !isUuid(v)) return invalid();
    clean[key] = v;
  }
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const r = await runForm(pageOf(invoiceId), async () => {
    await updateDraftDetails(ctx, invoiceId, clean as DraftDetailsPatch);
    return tCommon("saved");
  });
  if (r.ok) revalidatePath(pageOf(invoiceId));
  return r;
}

/** The draft's VAT treatment (the lines' rates follow). */
export async function setVatProfileAction(invoiceId: unknown, profile: unknown): Promise<FormResult> {
  if (typeof invoiceId !== "string" || !isUuid(invoiceId)) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("invoices.draft");
  const r = await runForm(pageOf(invoiceId), async () => {
    const moved = await setDraftVatProfile(ctx, invoiceId, profile);
    return moved > 0 ? t("vat.changedLines", { count: moved }) : t("vat.changed");
  });
  if (r.ok) revalidatePath(pageOf(invoiceId));
  return r;
}

/** A new line at the end: only its description. */
export async function addLineAction(invoiceId: unknown, description: unknown): Promise<FormResult> {
  if (typeof invoiceId !== "string" || !isUuid(invoiceId) || typeof description !== "string") return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("invoices.lines");
  const r = await runForm(pageOf(invoiceId), async () => {
    await addLine(ctx, invoiceId, { description });
    return t("added");
  });
  if (r.ok) revalidatePath(pageOf(invoiceId));
  return r;
}

/** One field (or more) of one line. */
export async function updateLineAction(invoiceId: unknown, lineId: unknown, patch: unknown): Promise<FormResult> {
  if (
    typeof invoiceId !== "string" ||
    !isUuid(invoiceId) ||
    typeof lineId !== "string" ||
    !isUuid(lineId) ||
    typeof patch !== "object" ||
    patch === null
  ) {
    return invalid();
  }
  const input = patch as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const key of ["description", "quantity", "unit", "unitPrice", "vatRate"] as const) {
    if (!(key in input)) continue;
    const v = strOrNull(input[key]);
    if (v === undefined) return invalid();
    clean[key] = v;
  }
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const r = await runForm(pageOf(invoiceId), async () => {
    await updateLine(ctx, invoiceId, lineId, clean as LineInput, await lineParse());
    return tCommon("saved");
  });
  if (r.ok) revalidatePath(pageOf(invoiceId));
  return r;
}

export async function removeLineAction(invoiceId: unknown, lineId: unknown): Promise<FormResult> {
  if (typeof invoiceId !== "string" || !isUuid(invoiceId) || typeof lineId !== "string" || !isUuid(lineId)) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("invoices.lines");
  const r = await runForm(pageOf(invoiceId), async () => {
    await removeLine(ctx, invoiceId, lineId);
    return t("removed");
  });
  if (r.ok) revalidatePath(pageOf(invoiceId));
  return r;
}

export async function moveLineAction(invoiceId: unknown, lineId: unknown, direction: unknown): Promise<FormResult> {
  if (
    typeof invoiceId !== "string" ||
    !isUuid(invoiceId) ||
    typeof lineId !== "string" ||
    !isUuid(lineId) ||
    (direction !== "up" && direction !== "down")
  ) {
    return invalid();
  }
  const ctx = await ctxOf();
  const t = await getTranslations("invoices.lines");
  const r = await runForm(pageOf(invoiceId), async () => {
    await moveLine(ctx, invoiceId, lineId, direction);
    return t("moved");
  });
  if (r.ok) revalidatePath(pageOf(invoiceId));
  return r;
}

/** Delete the draft; the page then goes back to the list. */
export async function deleteDraftAction(invoiceId: unknown): Promise<FormResult> {
  if (typeof invoiceId !== "string" || !isUuid(invoiceId)) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("invoices.draft");
  const r = await runForm(LIST, async () => {
    await deleteDraft(ctx, invoiceId);
    return t("deleted");
  });
  if (r.ok) revalidatePath(LIST);
  return r;
}

/**
 * Issue the draft (slice 108), then make its PDF. The PDF failing does not
 * undo the issue: the answer is a CAUTION ("issued; its PDF could not be made
 * yet"), never a revert-looking error — Download PDF and the jobs route's
 * backstop make it later.
 */
export async function issueInvoiceAction(invoiceId: unknown, fingerprint: unknown): Promise<FormResult> {
  // The fingerprint of what the issuer saw (the security review's medium) — a
  // sha-256 the page computed; the issue refuses if the draft moved since.
  if (typeof invoiceId !== "string" || !isUuid(invoiceId)) return invalid();
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("invoices.issue");
  const r = await runForm(pageOf(invoiceId), async () => {
    const { displayNumber } = await issueInvoice(ctx, invoiceId, { fingerprint });
    try {
      await ensureInvoicePdf(ctx, invoiceId);
    } catch (e) {
      // Never silent: the issue stands and the backstop will retry, but why
      // the PDF failed belongs in the log (names and messages carry no data).
      console.error(`invoices: the PDF after issuing ${invoiceId} failed: ${e instanceof DomainError ? e.code : errorTag(e)}`);
      return caution(t("issuedNoPdf", { number: displayNumber }));
    }
    return t("issued", { number: displayNumber });
  });
  revalidatePath(pageOf(invoiceId));
  if (r.ok) revalidatePath(LIST);
  return r;
}

/** A short-lived link to the issued invoice's PDF (made first if it was not yet); the client navigates to it. */
export async function invoicePdfUrlAction(invoiceId: unknown): Promise<ActionResult<string>> {
  if (typeof invoiceId !== "string" || !isUuid(invoiceId)) return { ok: false, message: (await invalid()).message };
  const ctx = await ctxOf();
  let created = false;
  const r = await runAction(pageOf(invoiceId), async () => {
    const pdf = await invoicePdfUrl(ctx, invoiceId);
    created = pdf.created;
    return pdf.url;
  });
  // Only a PDF made just now changes the page (its "not made yet" note goes).
  if (created) revalidatePath(pageOf(invoiceId));
  return r;
}
