"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { verifyStepUpWithHeaders } from "@/auth/step-up";
import type { MemberActor } from "@/authz/authorize";
import { enrolUrl } from "@/authz/redirects";
import { isUuid } from "@/db/context";
import { DomainError } from "@/lib/domain-error";
import { caution, runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  addHoursToDraft,
  addLine,
  clearHourMarks,
  createCreditDraft,
  createDraft,
  createInvoiceFromHours,
  creditInFull,
  deleteDraft,
  isHourMark,
  issueInvoice,
  markHours,
  moveLine,
  removeLine,
  returnHours,
  setDraftVatProfile,
  updateDraftDetails,
  updateLine,
  type DraftDetailsPatch,
  type LineInput,
} from "@/modules/invoicing";
import { ensureInvoicePdf, errorTag, invoicePdfUrl } from "@/modules/invoicing/pdf-store";
import { markInvoicePaid, markInvoiceSent, markInvoiceUnpaid, sendInvoice } from "@/modules/invoicing/send";

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

/**
 * The authenticator code typed in a dialog (slice 109, C79 (g) — the bank
 * details' pattern, `settings/invoicing/actions.ts`): verified through the one
 * step-up path that spends the member's attempt budget; the context comes back
 * with a factor seconds old. A member with no authenticator is sent to set one
 * up; a wrong code is a sentence.
 */
async function withCode(
  rawCode: unknown,
  returnTo: string,
): Promise<{ readonly ok: true; readonly ctx: { readonly tenantId: string; readonly actor: MemberActor } } | IssueResult> {
  const t = await getTranslations("invoices.issue");
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  // Too short or too long to be a code: not checked, so the dialog keeps it.
  if (code.length < 6 || code.length > 32) return { ok: false, message: t("enterCode"), codeChecked: false };
  const { membership, actor } = await requireTenantContext();
  const verified = await verifyStepUpWithHeaders(code, await headers());
  if (!verified.ok) {
    if (verified.reason === "no_session") redirect("/login");
    if (verified.reason === "not_enrolled") redirect(enrolUrl(returnTo));
    const tStep = await getTranslations("account.stepUp");
    return { ok: false, message: verified.reason === "rate_limited" ? tStep("tooManyAttempts") : tStep("mismatch") };
  }
  return { ok: true, ctx: { tenantId: membership.tenantId, actor: { ...actor, mfa: { enrolled: true, verifiedAt: verified.verifiedAt } } } };
}

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
    // Slice 108b: a credit note's reason (the service refuses it on an invoice).
    "creditReason",
    // Slice 109 (C79 (c), (f)): the Pay now link (the service refuses it on a credit note).
    "payLinkUrl",
  ];
  const clean: Record<string, unknown> = {};
  for (const key of allowed) {
    if (!(key in input)) continue;
    const v = strOrNull(input[key]);
    if (v === undefined) return invalid();
    if (key === "projectId" && v !== null && v !== "" && !isUuid(v)) return invalid();
    clean[key] = v;
  }
  // Slice 110b (C80 (d)): the time breakdown tick — a boolean, never text
  // (the service refuses it on a credit note).
  if ("includeHours" in input) {
    if (typeof input.includeHours !== "boolean") return invalid();
    clean.includeHours = input.includeHours;
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
    // A line made from hours puts them back on the ready list (slice 110).
    const returned = await removeLine(ctx, invoiceId, lineId);
    return returned > 0 ? `${t("removed")} ${t("hoursReturned", { count: returned })}` : t("removed");
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
  // A credit note's draft is listed on its invoice's page too (slice 108b).
  if (r.ok) revalidatePath(LIST, "layout");
  return r;
}

/**
 * Issue the draft (slice 108), then make its PDF. The PDF failing does not
 * undo the issue: the answer is a CAUTION ("issued; its PDF could not be made
 * yet"), never a revert-looking error — Download PDF and the jobs route's
 * backstop make it later.
 */
/** An issue's answer; `codeChecked: false` when a typed code was refused before it was checked (the dialog keeps it). */
export type IssueResult = FormResult & { readonly codeChecked?: boolean };

export async function issueInvoiceAction(invoiceId: unknown, fingerprint: unknown, code?: unknown): Promise<IssueResult> {
  // The fingerprint of what the issuer saw (the security review's medium) — a
  // sha-256 the page computed; the issue refuses if the draft moved since.
  if (typeof invoiceId !== "string" || !isUuid(invoiceId)) return invalid();
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) return invalid();
  // Slice 109 (C79 (g)): a draft with a Pay now link is issued only with the
  // issuer's code typed in the dialog — verified here through the one step-up
  // path that spends the attempt budget; the service accepts a factor no older
  // than a minute (and asks for one only when the LOCKED draft has a link).
  let ctx = await ctxOf();
  // The service accepts a draft with a link ONLY when this request verified a
  // typed code (`codeTypedNow`) — never because some other step-up in the
  // last minute left the session fresh (the security review's low).
  let codeTypedNow = false;
  if (code !== undefined && code !== null && code !== "") {
    const verified = await withCode(code, pageOf(invoiceId));
    if (!("ctx" in verified)) return verified;
    ctx = verified.ctx;
    codeTypedNow = true;
  }
  const t = await getTranslations("invoices.issue");
  const r = await runForm(pageOf(invoiceId), async () => {
    const { displayNumber, kind } = await issueInvoice(ctx, invoiceId, { fingerprint, codeTypedNow });
    const credit = kind === "CREDIT_NOTE";
    if (!(await pdfMade(ctx, invoiceId))) return caution(t(credit ? "creditIssuedNoPdf" : "issuedNoPdf", { number: displayNumber }));
    return t(credit ? "creditIssued" : "issued", { number: displayNumber });
  });
  revalidatePath(pageOf(invoiceId));
  // A credit note may have moved its invoice to Credited: the whole list.
  if (r.ok) revalidatePath(LIST, "layout");
  return r;
}

/**
 * Make an issued invoice's PDF right after its issue. A failure does not undo
 * the issue: the caller answers with a CAUTION, never a revert-looking error —
 * Download PDF and the jobs route's backstop make it later.
 */
async function pdfMade(ctx: Awaited<ReturnType<typeof ctxOf>>, invoiceId: string): Promise<boolean> {
  try {
    await ensureInvoicePdf(ctx, invoiceId);
    return true;
  } catch (e) {
    // Never silent: the issue stands and the backstop will retry, but why
    // the PDF failed belongs in the log (names and messages carry no data).
    console.error(`invoices: the PDF after issuing ${invoiceId} failed: ${e instanceof DomainError ? e.code : errorTag(e)}`);
    return false;
  }
}

/**
 * Credit PART of an issued invoice (slice 108b): a credit-note draft with every
 * line; the answer carries its id so the dialog navigates to it.
 */
export async function createCreditDraftAction(invoiceId: unknown, reason: unknown): Promise<ActionResult<string>> {
  if (typeof invoiceId !== "string" || !isUuid(invoiceId) || typeof reason !== "string") return { ok: false, message: (await invalid()).message };
  const ctx = await ctxOf();
  const r = await runAction(pageOf(invoiceId), () => createCreditDraft(ctx, invoiceId, { reason }));
  if (r.ok) {
    revalidatePath(pageOf(invoiceId));
    revalidatePath(LIST);
  }
  return r;
}

export type CreditedAnswer = {
  readonly message: string;
  readonly caution: boolean;
  /** Where the dialog goes next: the corrected copy, or the credit note. */
  readonly goTo: string;
};

/**
 * Credit the WHOLE issued invoice (slice 108b; C77 (c)): the credit note
 * issued now and its PDF made, and — with `correctedCopy` — a new draft of
 * the invoice to fix and issue, which the dialog then opens.
 */
export async function creditInFullAction(invoiceId: unknown, reason: unknown, correctedCopy: unknown): Promise<ActionResult<CreditedAnswer>> {
  if (typeof invoiceId !== "string" || !isUuid(invoiceId) || typeof reason !== "string" || typeof correctedCopy !== "boolean") {
    return { ok: false, message: (await invalid()).message };
  }
  const ctx = await ctxOf();
  const t = await getTranslations("invoices.credit");
  const r = await runAction(pageOf(invoiceId), async (): Promise<CreditedAnswer> => {
    const done = await creditInFull(ctx, invoiceId, { reason, correctedCopy });
    const made = await pdfMade(ctx, done.creditNoteId);
    // The copy opens (C77 (c)) even when the credit note's PDF failed, so
    // that caution says where the credit note is (the code review's nit).
    const message = done.copyId
      ? t(made ? "issuedCopy" : "issuedCopyNoPdf", { number: done.displayNumber })
      : t(made ? "issued" : "issuedNoPdf", { number: done.displayNumber });
    return { message, caution: !made, goTo: pageOf(done.copyId ?? done.creditNoteId) };
  });
  if (r.ok) {
    revalidatePath(pageOf(invoiceId));
    revalidatePath(LIST);
  }
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

/**
 * Send… / Send again… (slice 109; C79 (a), (e)): the issued invoice or credit
 * note emailed with its PDF to one to three addresses. The answer says exactly
 * which addresses took it: a send that reached none is a refusal (nothing was
 * recorded); one that reached some, or whose record failed after the mail
 * went, is a CAUTION — never a plain success, never a revert-looking error.
 */
export async function sendInvoiceAction(invoiceId: unknown, to: unknown): Promise<FormResult> {
  if (typeof invoiceId !== "string" || !isUuid(invoiceId) || !Array.isArray(to)) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("invoices.send");
  const r = await runAction(pageOf(invoiceId), () => sendInvoice(ctx, invoiceId, { to }));
  if (!r.ok) return r;
  const { sent, blocked, failed, recorded, kind, displayNumber } = r.value;
  if (sent.length === 0) {
    // Both causes named when both happened (the code review's nit): a retry
    // cures a transport failure, never a blocked address.
    return {
      ok: false,
      message:
        failed.length > 0 && blocked.length > 0
          ? t("failedAndBlocked", { list: blocked.join(", ") })
          : failed.length > 0
            ? t("failed")
            : t("blocked", { list: blocked.join(", ") }),
    };
  }
  revalidatePath(pageOf(invoiceId));
  revalidatePath(LIST);
  const list = sent.join(", ");
  if (!recorded) return { ok: true, caution: true, message: t("notRecorded", { list }) };
  const missed = [...blocked, ...failed];
  if (missed.length > 0) return { ok: true, caution: true, message: t("some", { list, missed: missed.join(", ") }) };
  return { ok: true, message: t(kind === "CREDIT_NOTE" ? "sentCredit" : "sent", { number: displayNumber, list }) };
}

/** Mark as sent (C79 (a)): sent some other way — once; it is in the client's portal from now on. */
export async function markInvoiceSentAction(invoiceId: unknown): Promise<FormResult> {
  if (typeof invoiceId !== "string" || !isUuid(invoiceId)) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("invoices.send");
  const r = await runForm(pageOf(invoiceId), async () => {
    await markInvoiceSent(ctx, invoiceId);
    return t("marked");
  });
  if (r.ok) {
    revalidatePath(pageOf(invoiceId));
    revalidatePath(LIST);
  }
  return r;
}

/** Mark as paid… (C79 (d)): the day the money arrived and the agency's own note. */
export async function markInvoicePaidAction(invoiceId: unknown, paidOn: unknown, note: unknown): Promise<FormResult> {
  if (typeof invoiceId !== "string" || !isUuid(invoiceId) || typeof paidOn !== "string") return invalid();
  if (note !== null && note !== undefined && typeof note !== "string") return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("invoices.payment");
  const r = await runForm(pageOf(invoiceId), async () => {
    await markInvoicePaid(ctx, invoiceId, { paidOn, note: note ?? null });
    return t("marked");
  });
  if (r.ok) {
    revalidatePath(pageOf(invoiceId));
    revalidatePath(LIST);
  }
  return r;
}

/** Mark as unpaid (C79 (h)): a Paid mark undone — the invoice back to unpaid, audited. */
export async function markInvoiceUnpaidAction(invoiceId: unknown): Promise<FormResult> {
  if (typeof invoiceId !== "string" || !isUuid(invoiceId)) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("invoices.payment");
  const r = await runForm(pageOf(invoiceId), async () => {
    await markInvoiceUnpaid(ctx, invoiceId);
    return t("undone");
  });
  if (r.ok) {
    revalidatePath(pageOf(invoiceId));
    revalidatePath(LIST);
  }
  return r;
}

// ── Slice 110: hours onto invoices (C80) ─────────────────────────────

const readyPath = (clientId: string) => `/invoices/ready/${clientId}`;

/** A list of hour ids, every one a uuid (the service checks the count and the rest). */
const hourIds = (raw: unknown): string[] | null =>
  Array.isArray(raw) && raw.length > 0 && raw.every((x) => typeof x === "string" && isUuid(x)) ? (raw as string[]) : null;

/** "Create invoice" from a client's hours: one transaction; the answer carries the new draft's id and how many hours stayed behind. */
export async function createInvoiceFromHoursAction(
  clientId: unknown,
  entryIds: unknown,
  grouping: unknown,
): Promise<ActionResult<{ readonly invoiceId: string; readonly leftOut: number }>> {
  const ids = hourIds(entryIds);
  if (typeof clientId !== "string" || !isUuid(clientId) || !ids || typeof grouping !== "string") {
    return { ok: false, message: (await invalid()).message };
  }
  const ctx = await ctxOf();
  const r = await runAction(readyPath(clientId), async () => {
    const made = await createInvoiceFromHours(ctx, { clientId, entryIds: ids, grouping });
    return { invoiceId: made.invoiceId, leftOut: made.leftOut };
  });
  if (r.ok) {
    revalidatePath(LIST);
    revalidatePath(readyPath(clientId));
  }
  return r;
}

/** "Add to draft": the chosen hours onto the open draft. The page goes back to the draft. */
export async function addHoursToDraftAction(invoiceId: unknown, clientId: unknown, entryIds: unknown, grouping: unknown): Promise<FormResult> {
  const ids = hourIds(entryIds);
  if (typeof invoiceId !== "string" || !isUuid(invoiceId) || typeof clientId !== "string" || !isUuid(clientId) || !ids) return invalid();
  if (typeof grouping !== "string") return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("invoices.hours");
  const r = await runForm(readyPath(clientId), async () => {
    const added = await addHoursToDraft(ctx, invoiceId, { entryIds: ids, grouping });
    const message = t("added", { count: added.lineIds.length });
    return added.leftOut > 0 ? caution(`${message} ${t("leftOut", { count: added.leftOut })}`) : message;
  });
  if (r.ok) {
    revalidatePath(pageOf(invoiceId));
    revalidatePath(readyPath(clientId));
    revalidatePath(LIST);
  }
  return r;
}

/** "Billed elsewhere" / "Won't invoice" on the chosen hours (C80 (g)). */
export async function markHoursAction(clientId: unknown, entryIds: unknown, mark: unknown): Promise<FormResult> {
  const ids = hourIds(entryIds);
  if (typeof clientId !== "string" || !isUuid(clientId) || !ids || !isHourMark(mark)) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("invoices.hours");
  const r = await runForm(readyPath(clientId), async () => t("marked", { count: await markHours(ctx, { clientId, entryIds: ids, mark }) }));
  if (r.ok) {
    revalidatePath(readyPath(clientId));
    revalidatePath(LIST);
  }
  return r;
}

/** Undo either mark: the chosen hours back on the ready list. */
export async function clearHourMarksAction(clientId: unknown, entryIds: unknown): Promise<FormResult> {
  const ids = hourIds(entryIds);
  if (typeof clientId !== "string" || !isUuid(clientId) || !ids) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("invoices.hours");
  const r = await runForm(readyPath(clientId), async () => t("unmarked", { count: await clearHourMarks(ctx, { clientId, entryIds: ids }) }));
  if (r.ok) {
    revalidatePath(readyPath(clientId));
    revalidatePath(LIST);
  }
  return r;
}

/** After a part credit, particular hours of the invoice back to "not invoiced" (C80 (f)). */
export async function returnHoursAction(invoiceId: unknown, entryIds: unknown): Promise<FormResult> {
  const ids = hourIds(entryIds);
  if (typeof invoiceId !== "string" || !isUuid(invoiceId) || !ids) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("invoices.hoursCard");
  const r = await runForm(pageOf(invoiceId), async () => t("returned", { count: await returnHours(ctx, invoiceId, { entryIds: ids }) }));
  if (r.ok) {
    revalidatePath(pageOf(invoiceId));
    revalidatePath(LIST, "layout");
  }
  return r;
}
