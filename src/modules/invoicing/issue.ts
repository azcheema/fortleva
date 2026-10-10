import { createHash } from "node:crypto";

import { record } from "@/audit/record";
import { assertInScope, requireRecentMfa } from "@/authz/authorize";
import { AuthzError, deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { todayIn } from "@/lib/due-date";
import { addDays } from "@/lib/week";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { INVOICE_PAY_LINK_ISSUED_MAIL } from "@/notify/invoice-pay-link-mail-key";
import { readPreferences } from "@/preferences/service";

import { readCreditedNets, readInvoiceNets } from "./credit-state";
import { guarded } from "./db-errors";
import type { InvoicingCtx } from "./drafts";
import { freeInvoiceHours, lockInvoiceHours, readHoursIssueFacts } from "./hours-record";
import { FX_MAX_AGE_DAYS, needsSekVat, rateDayFor, sekRateFor, vatGroupsInSek, type FetchText, type FxRate } from "./fx";
import { checkCreditIssue, checkIssue, creditCovers, mentionsPaymentDetails, type IssueCheck, type IssueClient } from "./issue-check";
import { formatFixed, invoiceTotals, readFixed, type InvoiceTotals } from "./money";
import { isInvoiceLocale, isoDay, type InvoiceLocale } from "./print";
import { INVOICE_DETAILS_STEP_UP_MINUTES, noticeToOwners, readSeller } from "./seller";
import { readNumbering } from "./series";
import type { VatProfile } from "./vat";

/**
 * ISSUING AN INVOICE (Phase 4 slice 108; founder decision C76) — and a CREDIT
 * NOTE (slice 108b; C76 (c), (f), C77). A draft is issued in ONE transaction
 * and from then on never changes: it gets the next number of the workspace's
 * series, today's date (in the workspace's time zone), its due date (its
 * payment terms later), its totals, its language, and — on another currency
 * carrying VAT — the VAT in SEK at the European Central Bank's rate of the day
 * the work ended (C78 (a)). The DATABASE does the rest and has the last word
 * (`invoice_guard`, migrations 20261009200000 and 20261010090000): it
 * allocates the number, writes the seller's, the bank's and the buyer's
 * snapshots from the live rows, and refuses anything an invoice must carry but
 * lacks.
 *
 * A CREDIT NOTE is issued the same way, with what differs: `invoice:credit`
 * as well; its invoice (the ORIGINAL) locked after it and still open to
 * credit; never more credited than is left at any VAT rate (`creditOverRates`
 * — the guard restates it); its parties the original's (the guard copies the
 * snapshots); its VAT in SEK at the original's rate; and, when it completes
 * the credit, the original moved to CREDITED in the same transaction.
 *
 * The recipe: `invoice:issue` (CA) → the client in DIRECT scope → the draft
 * locked (the one lock order — a credit note's original first, then the
 * draft, then the guard takes the series) → what issuing needs, checked here first so
 * the member reads a sentence (`checkIssue` / `checkCreditIssue` — the same
 * lists the dialog shows) → the write → the audit rows.
 *
 * THE RATE is fetched BEFORE the transaction (a network call never holds the
 * series), for the currency and the rate day the draft had then; the
 * transaction refuses with INVOICE_CHANGED if the draft now wants a rate it
 * was not given, or another one (the design review's medium).
 *
 * THE WAIT for the series row is bounded (`ISSUE_LOCK_WAIT_MS`): a statement
 * parked on a lock ignores the transaction's budget (memory: only
 * `lock_timeout` ends it), and a stuck issue must not hang every other.
 */

export const ISSUE_LOCK_WAIT_MS = 5_000;
/**
 * The issue transaction's own budget — well past the lock wait, so a wait that
 * ends in a lock timeout is answered INVOICE_ISSUE_BUSY rather than a closed
 * transaction (the code review's medium: the default budget equals the wait,
 * and a dozen statements have already run when the guard takes the series).
 */
export const ISSUE_TX_TIMEOUT_MS = 20_000;

export { FX_MAX_AGE_DAYS } from "./fx";

export { checkIssue, clientBlockers, type IssueBlocker, type IssueCheck, type IssueClient, type OverCredit } from "./issue-check";

const memberPrincipal = (ctx: InvoicingCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

type DraftFacts = {
  readonly id: string;
  readonly kind: "INVOICE" | "CREDIT_NOTE";
  readonly creditsInvoiceId: string | null;
  readonly creditReason: string | null;
  readonly clientId: string;
  readonly currency: string;
  readonly vatProfile: VatProfile;
  readonly paymentTermsDays: number;
  readonly locale: InvoiceLocale | null;
  readonly hasPeriod: boolean;
  /** `YYYY-MM-DD`. */
  readonly periodEnd: string | null;
  readonly lineCount: number;
  readonly totals: InvoiceTotals;
};

/** The draft's own facts and its lines' totals, read inside a transaction. */
async function readDraftFacts(tx: TenantDb, invoiceId: string): Promise<DraftFacts & { readonly status: string }> {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId },
    select: {
      kind: true,
      creditsInvoiceId: true,
      creditReason: true,
      clientId: true,
      status: true,
      currency: true,
      vatProfile: true,
      paymentTermsDays: true,
      locale: true,
      periodStart: true,
      periodEnd: true,
    },
  });
  if (!invoice) return deny("NOT_FOUND");
  const lines = await tx.invoiceLine.findMany({ where: { invoiceId }, select: { amountExVat: true, vatRatePct: true } });
  const totals = invoiceTotals(lines.map((l) => ({ amount: readFixed(l.amountExVat, 2), rate: readFixed(l.vatRatePct, 2) })));
  return {
    id: invoiceId,
    kind: invoice.kind,
    creditsInvoiceId: invoice.creditsInvoiceId,
    creditReason: invoice.creditReason,
    clientId: invoice.clientId,
    status: invoice.status,
    currency: invoice.currency,
    vatProfile: invoice.vatProfile,
    paymentTermsDays: invoice.paymentTermsDays,
    locale: isInvoiceLocale(invoice.locale) ? invoice.locale : null,
    hasPeriod: invoice.periodStart !== null || invoice.periodEnd !== null,
    periodEnd: invoice.periodEnd ? isoDay(invoice.periodEnd) : null,
    lineCount: lines.length,
    totals,
  };
}

/**
 * WHAT THE ISSUER SAW (the security review's medium). Issuing freezes the
 * draft and its client as they are AT THAT MOMENT, and a member who may edit
 * the draft or the client but not issue it could change the note, a line or
 * the client's address between an issuer's review and their click — C75 (i)
 * left a draft's note an ordinary edit precisely "because whoever issues that
 * invoice sees the whole invoice first". So the page hands the dialog a hash
 * of everything the invoice will print about the draft, its lines and its
 * client, the action sends it back, and the issue recomputes it under the
 * draft's lock: a difference is INVOICE_CHANGED ("look it over and issue it
 * again"). Every value hashed is one READ from Postgres both times (AGENTS.md:
 * never hash what you sent). The workspace's own details are not in it: they
 * change only with a code typed in the form and every owner mailed (C75).
 * A CREDIT NOTE hashes its kind and reason too, and not the live client —
 * nothing of it is printed there (its parties are its invoice's).
 */
export async function readIssueFingerprint(tx: TenantDb, invoiceId: string): Promise<string> {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId },
    select: {
      kind: true,
      creditReason: true,
      clientId: true,
      projectId: true,
      currency: true,
      vatProfile: true,
      paymentTermsDays: true,
      locale: true,
      periodStart: true,
      periodEnd: true,
      buyerReference: true,
      ourReference: true,
      note: true,
      payLinkUrl: true,
    },
  });
  if (!invoice) return deny("NOT_FOUND");
  const lines = await tx.invoiceLine.findMany({
    where: { invoiceId },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { id: true, description: true, quantity: true, unit: true, unitPriceExVat: true, vatRatePct: true, amountExVat: true },
  });
  const credit = invoice.kind === "CREDIT_NOTE";
  const client = credit
    ? null
    : await tx.client.findFirst({
        where: { id: invoice.clientId },
        select: {
          name: true,
          orgNr: true,
          vatNumber: true,
          addressLine1: true,
          addressLine2: true,
          postalCode: true,
          city: true,
          countryCode: true,
          invoiceLocale: true,
        },
      });
  if (!credit && !client) return deny("NOT_FOUND");
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const canonical = JSON.stringify([
    invoice.projectId,
    invoice.currency,
    invoice.vatProfile,
    invoice.paymentTermsDays,
    invoice.locale,
    day(invoice.periodStart),
    day(invoice.periodEnd),
    invoice.buyerReference,
    invoice.ourReference,
    invoice.note,
    lines.map((l) => [
      l.id,
      l.description,
      String(readFixed(l.quantity, 3)),
      l.unit,
      String(readFixed(l.unitPriceExVat, 2)),
      String(readFixed(l.vatRatePct, 2)),
      String(readFixed(l.amountExVat, 2)),
    ]),
    client
      ? [client.name, client.orgNr, client.vatNumber, client.addressLine1, client.addressLine2, client.postalCode, client.city, client.countryCode, client.invoiceLocale]
      : null,
    // Appended, so an INVOICE's canonical form keeps slice 108's prefix.
    ...(credit ? [invoice.kind, invoice.creditReason] : []),
    // Slice 109 (C79 (c)): the Pay now link — where the client's money goes,
    // seen by the issuer; a link set or changed after the page loaded is
    // INVOICE_CHANGED. Appended only when there is one.
    ...(invoice.payLinkUrl !== null ? ["payLink", invoice.payLinkUrl] : []),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The issue check, with the fingerprint of what it was read from — and (slice
 * 109's security review, its low on free text) whether the draft's own text
 * reads like somewhere to pay.
 */
export type IssueCheckSeen = IssueCheck & { readonly fingerprint: string; readonly paymentText: boolean };

/** The draft's own printed text — note, references, reason, line descriptions — read for `mentionsPaymentDetails`. */
async function readDraftPaymentText(tx: TenantDb, invoiceId: string): Promise<boolean> {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId },
    select: { note: true, buyerReference: true, ourReference: true, creditReason: true },
  });
  if (!invoice) return false;
  const lines = await tx.invoiceLine.findMany({ where: { invoiceId }, select: { description: true, unit: true } });
  return mentionsPaymentDetails([
    invoice.note,
    invoice.buyerReference,
    invoice.ourReference,
    invoice.creditReason,
    ...lines.flatMap((l) => [l.description, l.unit]),
  ]);
}

/** The client's facts issuing reads. */
async function readIssueClient(tx: TenantDb, clientId: string): Promise<IssueClient> {
  const client = await tx.client.findFirst({
    where: { id: clientId },
    select: { name: true, addressLine1: true, city: true, countryCode: true, vatNumber: true, invoiceLocale: true },
  });
  if (!client) return deny("NOT_FOUND");
  return client;
}

/** A credit note's original, as its issue reads it. */
type OriginalFacts = {
  readonly id: string;
  readonly open: boolean;
  readonly fxRateToSek: bigint | null;
  readonly fxRateDate: string | null;
  readonly issueDate: string | null;
};

async function readOriginalFacts(tx: TenantDb, originalId: string): Promise<OriginalFacts> {
  const o = await tx.invoice.findFirst({
    where: { id: originalId },
    select: { id: true, kind: true, status: true, fxRateToSek: true, fxRateDate: true, issueDate: true },
  });
  if (!o) return deny("NOT_FOUND");
  return {
    id: o.id,
    open: o.kind === "INVOICE" && (o.status === "ISSUED" || o.status === "SENT" || o.status === "PAID"),
    fxRateToSek: o.fxRateToSek === null ? null : readFixed(o.fxRateToSek, 6),
    fxRateDate: o.fxRateDate ? isoDay(o.fxRateDate) : null,
    issueDate: o.issueDate ? isoDay(o.issueDate) : null,
  };
}

/** What issuing this draft needs and would give — an invoice's check or a credit note's. */
async function checkDraft(
  tx: TenantDb,
  tenantId: string,
  draft: DraftFacts,
  now: Date,
): Promise<{ readonly check: IssueCheck; readonly numbering: Awaited<ReturnType<typeof readNumbering>>; readonly original: OriginalFacts | null }> {
  const numbering = await readNumbering(tx, tenantId);
  const prefs = await readPreferences(tx, tenantId);
  const today = todayIn(prefs.timezone, now);
  if (draft.kind === "CREDIT_NOTE") {
    if (!draft.creditsInvoiceId || !draft.locale) throw new Error("issue: a credit note without its invoice or language");
    const original = await readOriginalFacts(tx, draft.creditsInvoiceId);
    const originalNets = await readInvoiceNets(tx, original.id);
    const credited = await readCreditedNets(tx, original.id);
    const check = checkCreditIssue({
      reason: draft.creditReason,
      lineCount: draft.lineCount,
      totals: draft.totals,
      originalOpen: original.open,
      original: originalNets,
      credited,
      numbering,
      currency: draft.currency,
      originalRateDate: original.fxRateDate,
      originalIssueDate: original.issueDate,
      locale: draft.locale,
      today,
    });
    return { check, numbering, original };
  }
  const client = await readIssueClient(tx, draft.clientId);
  const { company, payment, unreadable } = await readSeller(tx, tenantId);
  // Slice 110: its tracked hours — a private task named on a line, a record
  // the marks disagree with (blockers), hours changed since added (a caution).
  const hours = await readHoursIssueFacts(tx, tenantId, draft.id);
  const check = checkIssue({
    company,
    payment,
    paymentUnreadable: unreadable.length > 0,
    numbering,
    client,
    vatProfile: draft.vatProfile,
    currency: draft.currency,
    lineCount: draft.lineCount,
    totals: draft.totals,
    paymentTermsDays: draft.paymentTermsDays,
    locale: draft.locale,
    hasPeriod: draft.hasPeriod,
    periodEnd: draft.periodEnd,
    today,
    hours,
  });
  return { check, numbering, original: null };
}

/**
 * The dialog's answer for one draft — what issuing still needs and what it
 * would give. Read inside the page's own transaction (the caller has checked
 * `invoice:view`, `invoice:issue` — and for a credit note `invoice:credit` —
 * and the scope); `checkIssue` / `checkCreditIssue` decide.
 */
export async function readIssueCheck(
  tx: TenantDb,
  tenantId: string,
  invoiceId: string,
  now: Date = new Date(),
  /** Read by the caller BEFORE what it shows (`getInvoice`); read here otherwise. */
  seen?: string,
): Promise<IssueCheckSeen> {
  const fingerprint = seen ?? (await readIssueFingerprint(tx, invoiceId));
  const draft = await readDraftFacts(tx, invoiceId);
  const { check } = await checkDraft(tx, tenantId, draft, now);
  const paymentText = await readDraftPaymentText(tx, invoiceId);
  return { ...check, fingerprint, paymentText };
}

/**
 * The gates every issue takes, in order: the permissions — to issue it AND to
 * see it (a custom role holding only `invoice:issue` issues nothing it cannot
 * read; the security review's nit) — then the client in DIRECT scope.
 */
async function openIssue(tx: TenantDb, ctx: InvoicingCtx, invoiceId: string): Promise<string> {
  await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:issue");
  const scoped = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { clientId: true } });
  if (!scoped) return deny("NOT_FOUND");
  await assertInScope(tx, ctx.actor, { clientId: scoped.clientId });
  return scoped.clientId;
}

/** A rate fetched before the transaction: for which currency and which day. */
export type FetchedRate = FxRate & { readonly currency: string; readonly rateDay: string };

export type Issued = {
  readonly kind: "INVOICE" | "CREDIT_NOTE";
  readonly number: number;
  readonly displayNumber: string;
  /** A credit note that completed its invoice's credit: the original is now CREDITED. */
  readonly creditedInFull: boolean;
};

/**
 * THE ISSUE ITSELF, inside the caller's transaction (`issueInvoice`, and
 * `creditInFull` for the credit note it has just written). Locks — a credit
 * note — its original, then the draft; checks; writes; audits; and moves a
 * fully credited original to CREDITED. The caller bounds the lock waits.
 */
export async function issueLocked(
  tx: TenantDb,
  ctx: InvoicingCtx,
  invoiceId: string,
  opts: {
    readonly now: Date;
    readonly rate: FetchedRate | null;
    readonly fingerprint?: string;
    /**
     * The issuer's code was TYPED AND VERIFIED in this very request (the issue
     * action sets it after `verifyStepUpWithHeaders`). A draft with a Pay now
     * link is issued only with it — any other step-up minutes ago (the vault's
     * door, a cost reveal) must not stand in for it (the security review's low).
     */
    readonly codeTypedNow?: boolean;
    /**
     * Slice 110 (C80 (f)): what a credit note that completes its invoice's
     * credit does to the invoice's hours — FREED (the default: back to "not
     * invoiced"), or KEPT for `creditInFull` to move onto the corrected copy
     * in the same transaction (the design review's H1).
     */
    readonly hours?: "free" | "keep";
  },
): Promise<Issued> {
  const { now, rate } = opts;
  const clientId = await openIssue(tx, ctx, invoiceId);
  // Its kind and its invoice, read unlocked — both never change (the guard).
  const kind = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { kind: true, creditsInvoiceId: true } });
  if (!kind) return deny("NOT_FOUND");
  const credit = kind.kind === "CREDIT_NOTE";
  if (credit) {
    // A credit note is also crediting: its own code.
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:credit");
    if (!kind.creditsInvoiceId) throw new Error("issue: a credit note without its invoice");
    // The ORIGINAL first, then the credit note — the migration's one lock
    // order (the design review's low): two credit notes on one invoice
    // serialise here, and every check below reads under both locks.
    await tx.$queryRaw`SELECT 1 FROM invoice WHERE id = ${kind.creditsInvoiceId} FOR UPDATE`;
    // …and its tracked hours, by id, NOW (slice 110; the design review's M2):
    // a credit that completes the credit frees them after the series is
    // taken, and that must never wait behind a member editing one.
    await lockInvoiceHours(tx, ctx.tenantId, kind.creditsInvoiceId);
  }
  const locked = await tx.$queryRaw<{ status: string; pay_link_url: string | null }[]>`
    SELECT status::text AS status, pay_link_url FROM invoice WHERE id = ${invoiceId} FOR UPDATE`;
  if (!locked[0]) return deny("NOT_FOUND");
  if (locked[0].status !== "DRAFT") return fail("INVOICE_NOT_DRAFT");
  if (!credit) {
    // The client held too (the fix-pass re-check's low): the invoice's
    // lock stops draft and line edits, nothing stopped a client edit
    // between the fingerprint, the checks and the guard's buyer
    // snapshot. FOR SHARE, after the invoice — the one lock order — and
    // bounded by the same lock_timeout.
    await tx.$queryRaw`SELECT 1 FROM client WHERE id = ${clientId} FOR SHARE`;
  }
  // Under the draft's lock: the draft (and its client) as the issuer saw them.
  if (opts.fingerprint !== undefined && (await readIssueFingerprint(tx, invoiceId)) !== opts.fingerprint) {
    return fail("INVOICE_CHANGED");
  }
  // A PAY NOW LINK takes the issuer's code AT THAT MOMENT (C79 (g); the design
  // review's high): the Stripe-or-PayPal fence cannot tell whose account a
  // link pays into, so issuing one is guarded like the bank details are — a
  // code typed in the dialog in THIS request, the one-minute window (C75 (h)),
  // decided from the LOCKED row. AFTER the fingerprint (the code review's
  // low): a link added since the page loaded is "it changed — look again", not
  // "type your code" in a dialog that has no field for one. Every owner is
  // told after the write.
  const payLink = locked[0].pay_link_url;
  if (payLink !== null) {
    if (opts.codeTypedNow !== true) return fail("INVOICE_PAY_LINK_CODE");
    try {
      await requireRecentMfa(ctx.actor, INVOICE_DETAILS_STEP_UP_MINUTES);
    } catch (e) {
      if (e instanceof AuthzError && e.reason === "MFA_REQUIRED") return fail("INVOICE_PAY_LINK_CODE");
      throw e;
    }
  }
  // Slice 110: the check reads whether a line names a task the client may not
  // see (`readHoursIssueFacts`) WITHOUT locking the tasks. A share-lock here
  // was tried and taken out (the fix-pass re-check's medium): it bypassed the
  // work module's rank-lock queue (`rank-lock.ts`), and a bulk edit — which
  // has no retry — could deadlock with it. The residual, accepted: a task made
  // private in the instant between this check and the issue's commit is
  // printed by that one issue.
  const draft = await readDraftFacts(tx, invoiceId);
  const { check, numbering, original } = await checkDraft(tx, ctx.tenantId, draft, now);
  if (original && !original.open) return fail("INVOICE_NOT_CREDITABLE");
  if (check.blockers.length > 0 || !numbering) return fail("INVOICE_NOT_READY");

  let fx: { readonly micros: bigint; readonly date: string } | null = null;
  if (original) {
    // A credit note: no fetch — its invoice's rate (the VAT it reverses was stated at it).
    if (check.needsFx) {
      if (original.fxRateToSek === null || original.fxRateDate === null) throw new Error("issue: a credit note's invoice has no rate");
      fx = { micros: original.fxRateToSek, date: original.fxRateDate };
    }
  } else {
    // The rate fetched for THIS currency and THIS day, and only when it is wanted.
    if (
      check.needsFx !== (rate !== null) ||
      (rate !== null && (rate.currency !== draft.currency || rate.rateDay !== check.rateDay))
    ) {
      return fail("INVOICE_CHANGED");
    }
    // …and the one ON OR BEFORE that day, at most ten days earlier: a file
    // outside that (a stale copy, an outage) is "try again" — the guard
    // refuses the same window (the migration review's low).
    if (rate !== null && (rate.date > rate.rateDay || rate.date < addDays(rate.rateDay, -FX_MAX_AGE_DAYS))) {
      return fail("INVOICE_FX_UNAVAILABLE");
    }
    fx = rate;
  }
  const sek = fx ? vatGroupsInSek(draft.totals.groups, fx.micros) : null;
  const issued = await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      status: "ISSUED",
      seriesId: numbering.seriesId,
      issuedAt: now,
      issuedByMemberId: ctx.actor.memberId,
      issueDate: new Date(`${check.issueDate}T00:00:00Z`),
      dueDate: new Date(`${check.dueDate}T00:00:00Z`),
      subtotalExVat: formatFixed(draft.totals.subtotal, 2),
      vatTotal: formatFixed(draft.totals.vatTotal, 2),
      total: formatFixed(draft.totals.total, 2),
      locale: check.locale,
      fxRateToSek: fx ? formatFixed(fx.micros, 6) : null,
      fxRateDate: fx ? new Date(`${fx.date}T00:00:00Z`) : null,
      vatTotalSek: sek ? formatFixed(sek.totalSek, 2) : null,
    },
    // The guard wrote the number: RETURNING reads the row as stored.
    select: { number: true, displayNumber: true, seriesId: true },
  });
  if (issued.number === null || issued.displayNumber === null) throw new Error("issueInvoice: the guard gave no number");
  await record(tx, {
    action: "invoice.issued",
    targetType: "Invoice",
    targetId: invoiceId,
    metadata: {
      number: issued.number,
      displayNumber: issued.displayNumber,
      seriesId: issued.seriesId,
      clientId: draft.clientId,
      currency: draft.currency,
      total: formatFixed(draft.totals.total, 2),
      issueDate: check.issueDate,
      locale: check.locale,
      ...(fx ? { fxRateToSek: formatFixed(fx.micros, 6), fxRateDate: fx.date } : {}),
      ...(original ? { kind: "CREDIT_NOTE", creditsInvoiceId: original.id } : {}),
      // Where the client's money would go (slice 109's design review's high).
      ...(payLink !== null ? { payLink } : {}),
    },
  });
  // C79 (g): every active owner told that an invoice went out with a Pay now
  // link — a link to it, never the URL (ARC-09); once per invoice.
  if (payLink !== null) {
    await noticeToOwners(tx, ctx.tenantId, now, {
      kind: INVOICE_PAY_LINK_ISSUED_MAIL,
      key: `invoice_pay_link_issued:${invoiceId}`,
      params: { invoiceId },
    });
  }

  // A credit note that completes the credit: its invoice is CREDITED now, in
  // the same transaction (the guard refuses the move unless it is so).
  let creditedInFull = false;
  if (original) {
    const covered = creditCovers(await readInvoiceNets(tx, original.id), await readCreditedNets(tx, original.id));
    if (covered) {
      await tx.invoice.update({ where: { id: original.id }, data: { status: "CREDITED" }, select: { id: true } });
      // C80 (f): credited in full, its hours are free again — unless the
      // corrected copy is taking them (`creditInFull`). Locked above.
      const hoursFreed = opts.hours === "keep" ? 0 : await freeInvoiceHours(tx, ctx.tenantId, original.id);
      await record(tx, {
        action: "invoice.credited",
        targetType: "Invoice",
        targetId: original.id,
        metadata: { byCreditNoteId: invoiceId, byCreditNoteNumber: issued.displayNumber, ...(hoursFreed > 0 ? { hoursFreed } : {}) },
      });
      creditedInFull = true;
    }
  }
  return { kind: credit ? "CREDIT_NOTE" : "INVOICE", number: issued.number, displayNumber: issued.displayNumber, creditedInFull };
}

/** Run `fn` as the issue's transaction: the member, the bounded lock wait, the guard's tokens mapped. */
export async function inIssueTransaction<T>(ctx: InvoicingCtx, fn: (tx: TenantDb) => Promise<T>): Promise<T> {
  try {
    return await guarded(() =>
      withTenant(ctx.tenantId, memberPrincipal(ctx), fn, { lockTimeoutMs: ISSUE_LOCK_WAIT_MS, timeoutMs: ISSUE_TX_TIMEOUT_MS }),
    );
  } catch (e) {
    // A deadlock with a writer outside every queue (the fix-pass re-check's
    // medium) is the same "try again" as a lock held past the bound.
    if (isLockTimeout(e) || isDeadlock(e)) return fail("INVOICE_ISSUE_BUSY");
    throw e;
  }
}

/**
 * `invoice:issue` — issue a draft (an invoice, or a credit note with
 * `invoice:credit` too). Returns its number. Any blocker is INVOICE_NOT_READY
 * (the dialog names them); a draft issued meanwhile is INVOICE_NOT_DRAFT; a
 * draft or client changed since the issuer looked (the fingerprint), or a rate
 * that no longer fits, is INVOICE_CHANGED; the ECB unreachable is
 * INVOICE_FX_UNAVAILABLE, a work period ended before its history
 * INVOICE_FX_TOO_OLD; a credit note's invoice credited in full meanwhile is
 * INVOICE_NOT_CREDITABLE; a series held past the bound is INVOICE_ISSUE_BUSY.
 * The PDF is the caller's next step (`pdf-store.ts`).
 */
export async function issueInvoice(
  ctx: InvoicingCtx,
  invoiceId: string,
  opts: {
    readonly now?: Date;
    readonly fetchText?: FetchText;
    /** What the issuer saw (`readIssueCheck`'s fingerprint); the action always sends it. */
    readonly fingerprint?: string;
    /** The issuer's code typed and verified in this request (C79 (g); `issueLocked`). */
    readonly codeTypedNow?: boolean;
  } = {},
): Promise<Issued> {
  const now = opts.now ?? new Date();

  // 1. What the draft looks like now — whether it needs a rate, in which
  //    currency, and of which day.
  const before = await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await openIssue(tx, ctx, invoiceId);
    const facts = await readDraftFacts(tx, invoiceId);
    if (facts.status !== "DRAFT") return fail("INVOICE_NOT_DRAFT");
    const prefs = await readPreferences(tx, ctx.tenantId);
    return { ...facts, today: todayIn(prefs.timezone, now) };
  });
  // 2. The rate, outside any transaction — an invoice's only (a credit note
  //    takes its invoice's).
  let rate: FetchedRate | null = null;
  if (before.kind === "INVOICE" && needsSekVat(before.currency, before.totals.vatTotal)) {
    const rateDay = rateDayFor(before.today, before.periodEnd);
    const fetched = await sekRateFor(before.currency, { rateDay, issueDate: before.today }, { fetchText: opts.fetchText, now });
    rate = { ...fetched, currency: before.currency, rateDay };
  }

  // 3. The issue.
  return inIssueTransaction(ctx, (tx) =>
    issueLocked(tx, ctx, invoiceId, { now, rate, fingerprint: opts.fingerprint, codeTypedNow: opts.codeTypedNow }),
  );
}
