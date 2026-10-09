import { createHash } from "node:crypto";

import { record } from "@/audit/record";
import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { todayIn } from "@/lib/due-date";
import { addDays } from "@/lib/week";
import { fail, isLockTimeout } from "@/lib/domain-error";
import { readPreferences } from "@/preferences/service";

import { guarded } from "./db-errors";
import type { InvoicingCtx } from "./drafts";
import { latestSekRate, needsSekVat, vatGroupsInSek, type FetchText, type FxRate } from "./fx";
import { checkIssue, type IssueCheck, type IssueClient } from "./issue-check";
import { formatFixed, invoiceTotals, readFixed, type InvoiceTotals } from "./money";
import type { InvoiceLocale } from "./print";
import { readSeller } from "./seller";
import { readNumbering } from "./series";
import type { VatProfile } from "./vat";

/**
 * ISSUING AN INVOICE (Phase 4 slice 108; founder decision C76). A draft is
 * issued in ONE transaction and from then on never changes: it gets the next
 * number of the workspace's series, today's date (in the workspace's time
 * zone), its due date (its payment terms later), its totals, its language,
 * and — on another currency carrying VAT — the VAT in SEK at the European
 * Central Bank's latest rate. The DATABASE does the rest and has the last
 * word (`invoice_guard`, migration 20261009200000): it allocates the number,
 * writes the seller's, the bank's and the buyer's snapshots from the live
 * rows, and refuses anything an invoice must carry but lacks.
 *
 * The recipe: `invoice:issue` (CA) → the client in DIRECT scope → the draft
 * locked (`lockDraft`'s lock order — invoice, then the guard takes the series)
 * → what issuing needs, checked here first so the member reads a sentence
 * (`checkIssue` — the same list the dialog shows) → the write → the audit row.
 *
 * THE RATE is fetched BEFORE the transaction (a network call never holds the
 * series), for the currency the draft had then; the transaction refuses with
 * INVOICE_CHANGED if the draft now wants a rate it was not given, or one for
 * another currency (the design review's medium).
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

/** The oldest ECB file an issue accepts, in days before its date — the guard's window (Easter is a four-day gap). */
export const FX_MAX_AGE_DAYS = 10;



export { checkIssue, clientBlockers, type IssueBlocker, type IssueCheck, type IssueClient } from "./issue-check";

const memberPrincipal = (ctx: InvoicingCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

type DraftFacts = {
  readonly clientId: string;
  readonly currency: string;
  readonly vatProfile: VatProfile;
  readonly paymentTermsDays: number;
  readonly locale: InvoiceLocale | null;
  readonly hasPeriod: boolean;
  readonly lineCount: number;
  readonly totals: InvoiceTotals;
};

/** The draft's own facts and its lines' totals, read inside a transaction. */
async function readDraftFacts(tx: TenantDb, invoiceId: string): Promise<DraftFacts & { readonly status: string }> {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId },
    select: {
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
    clientId: invoice.clientId,
    status: invoice.status,
    currency: invoice.currency,
    vatProfile: invoice.vatProfile,
    paymentTermsDays: invoice.paymentTermsDays,
    locale: invoice.locale === "sv" || invoice.locale === "en" ? invoice.locale : null,
    hasPeriod: invoice.periodStart !== null || invoice.periodEnd !== null,
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
 */
export async function readIssueFingerprint(tx: TenantDb, invoiceId: string): Promise<string> {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId },
    select: {
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
    },
  });
  if (!invoice) return deny("NOT_FOUND");
  const lines = await tx.invoiceLine.findMany({
    where: { invoiceId },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { id: true, description: true, quantity: true, unit: true, unitPriceExVat: true, vatRatePct: true, amountExVat: true },
  });
  const client = await tx.client.findFirst({
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
  if (!client) return deny("NOT_FOUND");
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
    [client.name, client.orgNr, client.vatNumber, client.addressLine1, client.addressLine2, client.postalCode, client.city, client.countryCode, client.invoiceLocale],
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** The issue check, with the fingerprint of what it was read from. */
export type IssueCheckSeen = IssueCheck & { readonly fingerprint: string };

/** The client's facts issuing reads. */
async function readIssueClient(tx: TenantDb, clientId: string): Promise<IssueClient> {
  const client = await tx.client.findFirst({
    where: { id: clientId },
    select: { name: true, addressLine1: true, city: true, countryCode: true, vatNumber: true, invoiceLocale: true },
  });
  if (!client) return deny("NOT_FOUND");
  return client;
}

/**
 * The dialog's answer for one draft — what issuing still needs and what it
 * would give. Read inside the page's own transaction (the caller has checked
 * `invoice:view` and the scope); `checkIssue` decides.
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
  const client = await readIssueClient(tx, draft.clientId);
  const { company, payment, unreadable } = await readSeller(tx, tenantId);
  const numbering = await readNumbering(tx, tenantId);
  const prefs = await readPreferences(tx, tenantId);
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
    today: todayIn(prefs.timezone, now),
  });
  return { ...check, fingerprint };
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

/**
 * `invoice:issue` — issue a draft. Returns its number. Any blocker is
 * INVOICE_NOT_READY (the dialog names them); a draft issued meanwhile is
 * INVOICE_NOT_DRAFT; a draft or client changed since the issuer looked (the
 * fingerprint), or a rate that no longer fits, is INVOICE_CHANGED; the ECB
 * unreachable is INVOICE_FX_UNAVAILABLE; a series held past the bound is
 * INVOICE_ISSUE_BUSY. The PDF is the caller's next step (`pdf-store.ts`).
 */
export async function issueInvoice(
  ctx: InvoicingCtx,
  invoiceId: string,
  opts: {
    readonly now?: Date;
    readonly fetchText?: FetchText;
    /** What the issuer saw (`readIssueCheck`'s fingerprint); the action always sends it. */
    readonly fingerprint?: string;
  } = {},
): Promise<{ readonly number: number; readonly displayNumber: string }> {
  const now = opts.now ?? new Date();

  // 1. What the draft looks like now — whether it needs a rate, and in which currency.
  const before = await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await openIssue(tx, ctx, invoiceId);
    const facts = await readDraftFacts(tx, invoiceId);
    if (facts.status !== "DRAFT") return fail("INVOICE_NOT_DRAFT");
    return facts;
  });
  // 2. The rate, outside any transaction.
  let rate: (FxRate & { readonly currency: string }) | null = null;
  if (needsSekVat(before.currency, before.totals.vatTotal)) {
    rate = { ...(await latestSekRate(before.currency, { fetchText: opts.fetchText, now })), currency: before.currency };
  }

  // 3. The issue.
  try {
    return await guarded(() =>
      withTenant(
        ctx.tenantId,
        memberPrincipal(ctx),
        async (tx) => {
          const clientId = await openIssue(tx, ctx, invoiceId);
          const locked = await tx.$queryRaw<{ status: string }[]>`
            SELECT status::text AS status FROM invoice WHERE id = ${invoiceId} FOR UPDATE`;
          if (!locked[0]) return deny("NOT_FOUND");
          if (locked[0].status !== "DRAFT") return fail("INVOICE_NOT_DRAFT");
          // The client held too (the fix-pass re-check's low): the invoice's
          // lock stops draft and line edits, nothing stopped a client edit
          // between the fingerprint, the checks and the guard's buyer
          // snapshot. FOR SHARE, after the invoice — the one lock order — and
          // bounded by the same lock_timeout.
          await tx.$queryRaw`SELECT 1 FROM client WHERE id = ${clientId} FOR SHARE`;
          // Under the draft's lock: the draft and its client as the issuer saw them.
          if (opts.fingerprint !== undefined && (await readIssueFingerprint(tx, invoiceId)) !== opts.fingerprint) {
            return fail("INVOICE_CHANGED");
          }
          const draft = await readDraftFacts(tx, invoiceId);
          const client = await readIssueClient(tx, draft.clientId);
          const { company, payment, unreadable } = await readSeller(tx, ctx.tenantId);
          const numbering = await readNumbering(tx, ctx.tenantId);
          const prefs = await readPreferences(tx, ctx.tenantId);
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
            today: todayIn(prefs.timezone, now),
          });
          if (check.blockers.length > 0 || !numbering) return fail("INVOICE_NOT_READY");
          // The rate fetched for THIS currency, and only when it is wanted.
          if (check.needsFx !== (rate !== null) || (rate !== null && rate.currency !== draft.currency)) {
            return fail("INVOICE_CHANGED");
          }
          // …and the LATEST one: a file dated after the invoice, or over ten
          // days before it (a stale copy, an outage), is "try again" — the
          // guard refuses the same window (the migration review's low).
          if (rate !== null && (rate.date > check.issueDate || rate.date < addDays(check.issueDate, -FX_MAX_AGE_DAYS))) {
            return fail("INVOICE_FX_UNAVAILABLE");
          }
          const sek = rate ? vatGroupsInSek(draft.totals.groups, rate.micros) : null;
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
              fxRateToSek: rate ? formatFixed(rate.micros, 6) : null,
              fxRateDate: rate ? new Date(`${rate.date}T00:00:00Z`) : null,
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
              ...(rate ? { fxRateToSek: formatFixed(rate.micros, 6), fxRateDate: rate.date } : {}),
            },
          });
          return { number: issued.number, displayNumber: issued.displayNumber };
        },
        { lockTimeoutMs: ISSUE_LOCK_WAIT_MS, timeoutMs: ISSUE_TX_TIMEOUT_MS },
      ),
    );
  } catch (e) {
    if (isLockTimeout(e)) return fail("INVOICE_ISSUE_BUSY");
    throw e;
  }
}
