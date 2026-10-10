import { record } from "@/audit/record";
import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import type { TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";

import { readCreditedNets } from "./credit-state";
import { CREDIT_REASON_MAX, ourReferenceOf, type InvoicingCtx } from "./drafts";
import { moveHoursToCopy } from "./hours-record";
import { inIssueTransaction, issueLocked } from "./issue";
import { readFixed } from "./money";
import { textOrNull } from "./seller-fields";

/**
 * CREDITING AN ISSUED INVOICE (Phase 4 slice 108b; founder decisions C76 (c),
 * (f) and C77). An issued invoice is never edited or deleted: it is corrected
 * by a CREDIT NOTE — an `invoice` row of kind CREDIT_NOTE naming it — which
 * takes the next number of the same series, credits the WHOLE invoice or PART
 * of it, says WHY (C77 (b)), and prints its amounts with a minus sign (C77
 * (a); stored positive — `print.ts`'s `signed`). The invoice reads Credited
 * once credit notes cover all of it, at every VAT rate; "partly credited" is
 * derived on its page, never a status.
 *
 * Two ways in, both `invoice:view` + `invoice:credit` + `invoice:issue` (a
 * credit-note draft is only ever made by someone who could finish it) and the
 * client in DIRECT scope:
 *   - `createCreditDraft` — PART of it: a credit-note DRAFT carrying every
 *     line of the invoice in full, which the member lowers or removes; issued
 *     later like an invoice (`issueInvoice`), refused if it credits more than
 *     is left at any rate.
 *   - `creditInFull` — THE WHOLE invoice, in ONE transaction: the credit note
 *     written and issued at once, the invoice moved to CREDITED, and — "credit
 *     and make a corrected copy" (C77 (c)) — a new INVOICE draft with the same
 *     details and lines, to fix and issue. No fingerprint: the issuer looked at
 *     a frozen record, and the one thing that can change under them — another
 *     credit note issued — refuses it (INVOICE_PARTLY_CREDITED or
 *     INVOICE_NOT_CREDITABLE).
 *
 * The database holds every rule here again (`invoice_guard`, migration
 * 20261010090000): who may make and issue a credit note, which invoice it may
 * credit, its terms (the original's), the over-credit rule, its parties (the
 * original's snapshots) and its rate (the original's).
 */

/** The reason, trimmed — required. */
export function parseCreditReason(raw: unknown): string {
  const reason = textOrNull(raw, CREDIT_REASON_MAX);
  if (reason === null) return fail("INVOICE_CREDIT_REASON_REQUIRED");
  return reason;
}

type Original = {
  readonly id: string;
  readonly clientId: string;
  readonly projectId: string | null;
  readonly vatProfile: "SE_DOMESTIC" | "EU_REVERSE_CHARGE" | "OUTSIDE_SCOPE";
  readonly currency: string;
  readonly locale: string | null;
  readonly paymentTermsDays: number;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly buyerReference: string | null;
  readonly note: string | null;
  readonly seriesId: string | null;
  readonly displayNumber: string | null;
};

/**
 * The gates, then the invoice locked and checked: an ISSUED/SENT/PAID
 * INVOICE (not a draft, not a credit note, not credited in full). Locking it
 * FIRST is harmless here — the credit note is a row nobody else can see yet —
 * and is the order `creditInFull`'s issue then follows (the original is
 * already held when the credit note's issue reaches for it).
 */
async function openCredit(tx: TenantDb, ctx: InvoicingCtx, invoiceId: string): Promise<Original> {
  await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:credit");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:issue");
  const scoped = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { clientId: true } });
  if (!scoped) return deny("NOT_FOUND");
  await assertInScope(tx, ctx.actor, { clientId: scoped.clientId });
  const locked = await tx.$queryRaw<{ kind: string; status: string; total: string | null }[]>`
    SELECT kind::text AS kind, status::text AS status, total::text AS total FROM invoice WHERE id = ${invoiceId} FOR UPDATE`;
  const row = locked[0];
  if (!row) return deny("NOT_FOUND");
  if (row.kind !== "INVOICE" || !(row.status === "ISSUED" || row.status === "SENT" || row.status === "PAID")) {
    return fail("INVOICE_NOT_CREDITABLE");
  }
  // An invoice of nothing has nothing to credit: a credit note's total is
  // above zero (the code review's low — Credit… offered, never possible).
  if (row.total === null || readFixed(row.total, 2) <= 0n) return fail("INVOICE_NOT_CREDITABLE");
  const original = await tx.invoice.findFirst({
    where: { id: invoiceId },
    select: {
      id: true,
      clientId: true,
      projectId: true,
      vatProfile: true,
      currency: true,
      locale: true,
      paymentTermsDays: true,
      periodStart: true,
      periodEnd: true,
      buyerReference: true,
      note: true,
      seriesId: true,
      displayNumber: true,
    },
  });
  if (!original) return deny("NOT_FOUND");
  return original;
}

/** Every line of `fromId`, copied onto `toId` (a draft of the same client) in the same order. */
async function copyLines(tx: TenantDb, ctx: InvoicingCtx, fromId: string, toId: string, clientId: string): Promise<number> {
  const lines = await tx.invoiceLine.findMany({
    where: { invoiceId: fromId },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { description: true, quantity: true, unit: true, unitPriceExVat: true, vatRatePct: true, amountExVat: true },
  });
  if (lines.length === 0) return 0;
  await tx.invoiceLine.createMany({
    data: lines.map((l, i) => ({
      tenantId: ctx.tenantId,
      clientId,
      invoiceId: toId,
      // Renumbered from 1: the original's positions may have gaps.
      position: i + 1,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPriceExVat: l.unitPriceExVat,
      vatRatePct: l.vatRatePct,
      amountExVat: l.amountExVat,
    })),
  });
  return lines.length;
}

/** A credit-note draft for `original`, with every line in full. */
async function writeCreditDraft(tx: TenantDb, ctx: InvoicingCtx, original: Original, reason: string): Promise<string> {
  const created = await tx.invoice.create({
    data: {
      tenantId: ctx.tenantId,
      clientId: original.clientId,
      projectId: original.projectId,
      kind: "CREDIT_NOTE",
      creditsInvoiceId: original.id,
      // The original's terms, which the guard holds it to (A3).
      vatProfile: original.vatProfile,
      currency: original.currency,
      locale: original.locale,
      periodStart: original.periodStart,
      periodEnd: original.periodEnd,
      seriesId: original.seriesId,
      paymentTermsDays: 0,
      buyerReference: original.buyerReference,
      ourReference: await ourReferenceOf(tx, ctx.actor.memberId),
      creditReason: reason,
      createdByMemberId: ctx.actor.memberId,
    },
    select: { id: true },
  });
  const lineCount = await copyLines(tx, ctx, original.id, created.id, original.clientId);
  await record(tx, {
    action: "invoice.created",
    targetType: "Invoice",
    targetId: created.id,
    metadata: { clientId: original.clientId, kind: "CREDIT_NOTE", creditsInvoiceId: original.id, lineCount },
  });
  return created.id;
}

/**
 * `invoice:credit` + `invoice:issue` — PART of an issued invoice: a
 * credit-note draft with every line of it in full, which the member lowers or
 * removes before issuing. Returns its id. (After an earlier part credit the
 * draft still starts from every line; its page says what is left per rate.)
 */
export async function createCreditDraft(ctx: InvoicingCtx, invoiceId: string, input: { readonly reason: unknown }): Promise<string> {
  const reason = parseCreditReason(input.reason);
  // The issue's bounded transaction: the original's lock is waited for at
  // most ISSUE_LOCK_WAIT_MS (the security review's nit — a blocked statement
  // ignores the transaction's own budget).
  return inIssueTransaction(ctx, async (tx) => {
    const original = await openCredit(tx, ctx, invoiceId);
    return writeCreditDraft(tx, ctx, original, reason);
  });
}

/**
 * THE CORRECTED COPY (C77 (c)): a plain INVOICE draft with the original's
 * details and lines — not its number, dates or snapshots (it reads its client
 * live again, as every draft does). Its language is the original's, as the
 * draft's own choice; its project only if that project is still live; "our
 * reference" the member who made it (`createDraft`'s rule). Written directly,
 * never through `createDraft`: an archived client's invoice is still credited
 * and copied (the draft page says the client is archived) — `createDraft`'s
 * ARCHIVED refusal would roll the credit back with it (the design review's low).
 */
async function writeCorrectedCopy(tx: TenantDb, ctx: InvoicingCtx, original: Original): Promise<string> {
  const project = original.projectId
    ? await tx.project.findFirst({ where: { id: original.projectId }, select: { status: true } })
    : null;
  const created = await tx.invoice.create({
    data: {
      tenantId: ctx.tenantId,
      clientId: original.clientId,
      projectId: project && project.status !== "ARCHIVED" ? original.projectId : null,
      vatProfile: original.vatProfile,
      currency: original.currency,
      locale: original.locale,
      paymentTermsDays: original.paymentTermsDays,
      periodStart: original.periodStart,
      periodEnd: original.periodEnd,
      buyerReference: original.buyerReference,
      ourReference: await ourReferenceOf(tx, ctx.actor.memberId),
      note: original.note,
      createdByMemberId: ctx.actor.memberId,
    },
    select: { id: true },
  });
  const lineCount = await copyLines(tx, ctx, original.id, created.id, original.clientId);
  await record(tx, {
    action: "invoice.created",
    targetType: "Invoice",
    targetId: created.id,
    metadata: { clientId: original.clientId, projectId: project && project.status !== "ARCHIVED" ? original.projectId : null, copiedFromInvoiceId: original.id, lineCount },
  });
  return created.id;
}

export type CreditedInFull = {
  readonly creditNoteId: string;
  readonly number: number;
  readonly displayNumber: string;
  /** The corrected copy's id, when one was asked for. */
  readonly copyId: string | null;
};

/**
 * `invoice:credit` + `invoice:issue` (+ `invoice:create` for the copy) — THE
 * WHOLE issued invoice, in one transaction: a credit note with every line,
 * issued now, the invoice CREDITED, and with `correctedCopy` a new draft of
 * it. Refused once any part of it has been credited (INVOICE_PARTLY_CREDITED —
 * "the whole" would no longer be the whole). The PDF is the caller's next step.
 */
export async function creditInFull(
  ctx: InvoicingCtx,
  invoiceId: string,
  input: { readonly reason: unknown; readonly correctedCopy: boolean },
  opts: { readonly now?: Date } = {},
): Promise<CreditedInFull> {
  const reason = parseCreditReason(input.reason);
  const now = opts.now ?? new Date();
  return inIssueTransaction(ctx, async (tx) => {
    const original = await openCredit(tx, ctx, invoiceId);
    if (input.correctedCopy) await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:create");
    // Under the original's lock: no credit note of it issued yet.
    if ((await readCreditedNets(tx, original.id)).size > 0) return fail("INVOICE_PARTLY_CREDITED");
    // The copy FIRST: the issue takes the series as its last step, and
    // nothing slow may run while it is held (the design review's low).
    const copyId = input.correctedCopy ? await writeCorrectedCopy(tx, ctx, original) : null;
    const creditNoteId = await writeCreditDraft(tx, ctx, original, reason);
    // Slice 110 (C80 (f)): credited in full, its tracked hours are freed — or,
    // with a corrected copy, KEPT through the issue and then moved onto the
    // copy's lines (the design review's H1: the copy bills exactly what the
    // original did, edited hours included; never freed while a copy bills them).
    const issued = await issueLocked(tx, ctx, creditNoteId, { now, rate: null, hours: copyId ? "keep" : "free" });
    if (!issued.creditedInFull) throw new Error("creditInFull: the credit note did not cover its invoice");
    if (copyId) {
      const moved = await moveHoursToCopy(tx, ctx.tenantId, original.id, copyId);
      if (moved > 0) {
        await record(tx, {
          action: "invoice.hours_added",
          targetType: "Invoice",
          targetId: copyId,
          metadata: { op: "corrected_copy", fromInvoiceId: original.id, hours: moved },
        });
      }
    }
    return { creditNoteId, number: issued.number, displayNumber: issued.displayNumber, copyId };
  });
}
