import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { LocalDiskTransport, setStorage } from "@/storage";

import { createCreditDraft, creditInFull } from "./credit";
import { addLine, createDraft, deleteDraft, getInvoice, removeLine, setDraftVatProfile, updateDraftDetails, updateLine } from "./drafts";
import { issueInvoice, readIssueCheck } from "./issue";
import { readIssuedInvoice } from "./issued";
import { ensureInvoicePdf } from "./pdf-store";
import { updateCompanyDetails, updatePaymentDetails } from "./seller";
import { setFirstInvoiceNumber } from "./series";

/**
 * CREDIT NOTES against the real database and the real app_runtime role
 * (Phase 4 slice 108b; founder decisions C76 (c), (f), C77; migration
 * 20261010090000):
 *   - who makes one (credit AND issue), of what (an issued INVOICE not yet
 *     credited in full), carrying what (its invoice's terms, kept);
 *   - the over-credit rule, signed, per VAT rate — the service names it, the
 *     guard holds it, and two credit notes issued at once never over-credit;
 *   - the parties as the invoice named them, nothing to pay, the invoice's
 *     number and date in its own record, the invoice's exchange rate;
 *   - CREDITED only once fully covered, in the same transaction;
 *   - crediting in full with a corrected copy, in one transaction;
 *   - the PDF ("kreditfaktura-…").
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let se: string; // Swedish, with an address
let de: string; // German business with a VAT number
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-credit-pdf-"));

const ctxOf = (memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });
const owner = () => ctxOf(f.seats.owner.memberId);
const admin = () => ctxOf(f.seats.admin.memberId);
const manager = () => ctxOf(f.seats.manager.memberId);

/** "ok" or the deterministic reason/code a call was refused with. */
const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

/** "ok", or which of the database's tokens / constraints refused a raw write. */
const TOKENS = [
  "INVOICE_OVER_CREDIT",
  "INVOICE_NOT_CREDITABLE",
  "INVOICE_NOT_DRAFT",
  "INVOICE_GUARD",
  "invoice_credit_reason",
  "invoice_credit_note_terms",
  "invoice_credits_reference",
  // Slice 109's CHECKs (sent, paid).
  "invoice_sent",
  "invoice_paid",
] as const;
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    const text = `${e instanceof Error ? e.message : String(e)} ${JSON.stringify((e as { meta?: unknown })?.meta ?? "")}`;
    return TOKENS.find((t) => text.includes(t)) ?? `unexpected: ${text.slice(0, 300)}`;
  }
};

const asMember = <T>(memberId: string, fn: (tx: TenantDb) => Promise<T>) =>
  withTenant(f.tenantId, { type: "member", id: memberId }, fn);

/**
 * An ISSUED invoice of `prices` (one line each) at 25 % — or at the rates
 * given — in SEK unless said. Drafts start in the client's last invoice's
 * currency, so the currency is always set.
 */
async function issuedInvoice(
  clientId: string,
  lines: readonly { price: string; rate?: string; quantity?: string }[],
  opts: { currency?: string; profile?: string; fetchText?: (url: string) => Promise<string> } = {},
): Promise<string> {
  const id = await createDraft(manager(), { clientId });
  if (opts.profile) await setDraftVatProfile(manager(), id, opts.profile);
  await updateDraftDetails(manager(), id, { currency: opts.currency ?? "SEK" });
  for (const l of lines) {
    const line = await addLine(manager(), id, { description: `Work at ${l.price}` });
    await updateLine(manager(), id, line, { unitPrice: l.price, ...(l.rate ? { vatRate: l.rate } : {}), ...(l.quantity ? { quantity: l.quantity } : {}) });
  }
  await issueInvoice(admin(), id, opts.fetchText ? { fetchText: opts.fetchText } : {});
  return id;
}

/** A credit-note draft's lines, by description. */
async function linesOf(invoiceId: string) {
  return f.platform.invoiceLine.findMany({ where: { invoiceId }, orderBy: { position: "asc" } });
}

/**
 * Issue a credit-note draft by raw SQL as `memberId` — past the service, the
 * guard all that stands. Dated as its invoice (never "earlier", whatever the
 * hour), with totals that are what its lines say.
 */
async function issueCreditRaw(creditNoteId: string, memberId: string) {
  const detail = await getInvoice(owner(), creditNoteId);
  const s = await f.platform.invoiceSeries.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  const fixed = (minor: bigint) => (Number(minor) / 100).toFixed(2);
  return asMember(memberId, (tx) => tx.$executeRaw`
    UPDATE invoice
       SET status = 'ISSUED', series_id = ${s.id},
           issue_date = (SELECT o.issue_date FROM invoice o WHERE o.id = invoice.credits_invoice_id),
           due_date = (SELECT o.issue_date FROM invoice o WHERE o.id = invoice.credits_invoice_id),
           issued_at = now(), issued_by_member_id = ${memberId},
           subtotal_ex_vat = ${fixed(detail.totals.subtotal)}::numeric, vat_total = ${fixed(detail.totals.vatTotal)}::numeric,
           total = ${fixed(detail.totals.total)}::numeric
     WHERE id = ${creditNoteId}`);
}

/** Set a credit-note draft's lines to these amounts (quantity 1), by position. */
async function creditLines(creditNoteId: string, prices: readonly string[]) {
  const lines = await linesOf(creditNoteId);
  for (const [i, line] of lines.entries()) {
    const price = prices[i];
    if (price === undefined) await removeLine(admin(), creditNoteId, line.id);
    else await updateLine(admin(), creditNoteId, line.id, { unitPrice: price, quantity: "1" });
  }
}

const statusOf = async (id: string) => (await f.platform.invoice.findUniqueOrThrow({ where: { id } })).status;

beforeAll(async () => {
  setStorage(new LocalDiskTransport(storageDir));
  f = await setupTenant("invc");
  se = randomUUID();
  de = randomUUID();
  const address = { addressLine1: "Gatan 1", postalCode: "111 22", city: "Stockholm" };
  await f.platform.client.createMany({
    data: [
      { id: se, tenantId: f.tenantId, name: "Acme AB", countryCode: "SE", orgNr: "556677-8899", ...address },
      { id: de, tenantId: f.tenantId, name: "Beta GmbH", countryCode: "DE", vatNumber: "DE123456789", ...address, city: "Berlin" },
    ],
  });
  await updateCompanyDetails(owner(), {
    legalName: "Invc Konsult AB",
    orgNr: "556016-0680",
    vatNumber: "SE556016068001",
    seat: "Stockholm",
    fSkattApproved: true,
    addressLine1: "Storgatan 1",
    postalCode: "111 22",
    city: "Stockholm",
    countryCode: "SE",
  });
  await updatePaymentDetails(owner(), { bankgiro: "5050-1055", footerNote: "Pay to Bankgiro 5050-1055." });
  await setFirstInvoiceNumber(owner(), "5001");
}, 120_000);

afterAll(async () => {
  setStorage(null);
  if (!f) return;
  await f.deleteInvoices();
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 120_000);

describe("making a credit note's draft", () => {
  it("of an issued invoice, by a member who may credit AND issue, with every line and the invoice's terms", async () => {
    const original = await issuedInvoice(se, [{ price: "1000" }, { price: "200", rate: "6" }]);
    expect(await outcome(createCreditDraft(manager(), original, { reason: "Wrong hours" }))).toBe("FORBIDDEN");
    expect(await outcome(createCreditDraft(admin(), original, { reason: "   " }))).toBe("INVOICE_CREDIT_REASON_REQUIRED");
    const cn = await createCreditDraft(admin(), original, { reason: "Wrong hours" });
    const [o, c] = await Promise.all([
      f.platform.invoice.findUniqueOrThrow({ where: { id: original } }),
      f.platform.invoice.findUniqueOrThrow({ where: { id: cn } }),
    ]);
    expect(c).toMatchObject({
      kind: "CREDIT_NOTE",
      status: "DRAFT",
      creditsInvoiceId: original,
      clientId: se,
      creditReason: "Wrong hours",
      paymentTermsDays: 0,
      vatProfile: o.vatProfile,
      currency: o.currency,
      locale: o.locale,
      seriesId: o.seriesId,
      number: null,
    });
    expect((await linesOf(cn)).map((l) => [l.description, l.amountExVat.toFixed(2), l.vatRatePct.toFixed(2)])).toEqual(
      (await linesOf(original)).map((l) => [l.description, l.amountExVat.toFixed(2), l.vatRatePct.toFixed(2)]),
    );
    expect((await f.audits("invoice.created")).at(-1)?.metadata).toMatchObject({ kind: "CREDIT_NOTE", creditsInvoiceId: original, lineCount: 2 });
    // Its page: what it credits, and what is left of it per rate.
    const view = await getInvoice(admin(), cn);
    expect(view.credits?.id).toBe(original);
    expect([...(view.creditLeft ?? new Map())]).toEqual([
      [2500n, 100_000n],
      [600n, 20_000n],
    ]); // highest rate first
    expect(view.creditsBuyer?.name).toBe("Acme AB");
  });

  it("never of a draft, of a credit note, or of an invoice credited in full", async () => {
    const draft = await createDraft(manager(), { clientId: se });
    expect(await outcome(createCreditDraft(admin(), draft, { reason: "x" }))).toBe("INVOICE_NOT_CREDITABLE");
    const original = await issuedInvoice(se, [{ price: "100" }]);
    const whole = await creditInFull(admin(), original, { reason: "Cancelled", correctedCopy: false });
    expect(await outcome(createCreditDraft(admin(), whole.creditNoteId, { reason: "x" }))).toBe("INVOICE_NOT_CREDITABLE");
    expect(await outcome(createCreditDraft(admin(), original, { reason: "x" }))).toBe("INVOICE_NOT_CREDITABLE");
    // …and the database, past the service.
    const insert = (creditsId: string, memberId: string, currency = "SEK") =>
      asMember(memberId, (tx) => tx.$executeRaw`
        INSERT INTO invoice (id, tenant_id, client_id, kind, credits_invoice_id, vat_profile, currency, locale, payment_terms_days,
                             series_id, created_by_member_id, updated_at)
        SELECT ${randomUUID()}, tenant_id, client_id, 'CREDIT_NOTE', id, vat_profile, ${currency}, locale, 0, series_id, ${memberId}, now()
          FROM invoice WHERE id = ${creditsId}`);
    expect(await refusal(insert(original, f.seats.admin.memberId))).toBe("INVOICE_NOT_CREDITABLE");
    const open = await issuedInvoice(se, [{ price: "100" }]);
    expect(await refusal(insert(open, f.seats.manager.memberId))).toBe("INVOICE_GUARD");
    expect(await refusal(insert(open, f.seats.admin.memberId, "EUR"))).toBe("INVOICE_GUARD");
    expect(await refusal(insert(open, f.seats.admin.memberId))).toBe("ok");
  });

  it("keeps its invoice's terms: only its reason, references, note and lines change — by a member who may credit", async () => {
    const original = await issuedInvoice(se, [{ price: "500" }]);
    const cn = await createCreditDraft(admin(), original, { reason: "Discount agreed" });
    expect(await outcome(updateDraftDetails(admin(), cn, { currency: "EUR" }))).toBe("INVALID_INPUT");
    expect(await outcome(updateDraftDetails(admin(), cn, { paymentTermsDays: "30" }))).toBe("INVALID_INPUT");
    expect(await outcome(setDraftVatProfile(admin(), cn, "OUTSIDE_SCOPE"))).toBe("INVALID_INPUT");
    expect(await outcome(updateDraftDetails(admin(), cn, { creditReason: "" }))).toBe("INVOICE_CREDIT_REASON_REQUIRED");
    expect(await updateDraftDetails(admin(), cn, { creditReason: "Discount agreed in October", note: "Sorry" })).toEqual(["creditReason", "note"]);
    // A member who edits invoices but may not credit reaches none of it.
    const [line] = await linesOf(cn);
    expect(await outcome(updateLine(manager(), cn, line!.id, { unitPrice: "1" }))).toBe("FORBIDDEN");
    expect(await outcome(updateDraftDetails(manager(), cn, { note: "x" }))).toBe("FORBIDDEN");
    const view = await getInvoice(manager(), cn);
    expect(view.can).toEqual({
      edit: false,
      delete: false,
      issue: false,
      credit: false,
      copy: false,
      // Slice 109: a draft is never sent or paid.
      send: false,
      markSent: false,
      markPaid: false,
      markUnpaid: false,
    });
    // An invoice has no reason.
    const plain = await createDraft(manager(), { clientId: se });
    expect(await outcome(updateDraftDetails(manager(), plain, { creditReason: "x" }))).toBe("INVALID_INPUT");
    // The database: its terms, whoever writes.
    expect(await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET currency = 'EUR' WHERE id = ${cn}`))).toBe(
      "INVOICE_GUARD",
    );
    expect(
      await refusal(asMember(f.seats.manager.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET note = 'x' WHERE id = ${cn}`)),
    ).toBe("INVOICE_GUARD");
    expect(await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET payment_terms_days = 10 WHERE id = ${cn}`))).toBe(
      "invoice_credit_note_terms",
    );
    await deleteDraft(admin(), cn);
  });
});

describe("issuing a credit note", () => {
  it("credits part of it: same series, the invoice's parties and nothing to pay, its number and date recorded — the invoice stays open", async () => {
    const original = await issuedInvoice(se, [{ price: "1000" }, { price: "200", rate: "6" }]);
    const o = await f.platform.invoice.findUniqueOrThrow({ where: { id: original } });
    // The client renamed after the invoice: the credit note names it as the invoice did.
    await f.platform.client.update({ where: { id: se }, data: { name: "Acme Renamed AB" } });
    try {
      const cn = await createCreditDraft(admin(), original, { reason: "Line 1 overbilled" });
      await creditLines(cn, ["400"]);
      const check = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, cn));
      expect(check).toMatchObject({ kind: "CREDIT_NOTE", blockers: [], nextNumber: (o.number ?? 0) + 1 });
      const r = await issueInvoice(admin(), cn, { fingerprint: check.fingerprint });
      expect(r).toEqual({ kind: "CREDIT_NOTE", number: (o.number ?? 0) + 1, displayNumber: String((o.number ?? 0) + 1), creditedInFull: false });
      const c = await f.platform.invoice.findUniqueOrThrow({ where: { id: cn } });
      expect(c.sellerSnapshot).toEqual(o.sellerSnapshot);
      expect(c.buyerSnapshot).toEqual(o.buyerSnapshot);
      expect(c.paymentSnapshot).toEqual({});
      expect(c.creditsDisplayNumber).toBe(o.displayNumber);
      expect(c.creditsIssueDate).toEqual(o.issueDate);
      expect(c.total?.toFixed(2)).toBe("500.00");
      expect(c.dueDate).toEqual(c.issueDate);
      expect(await statusOf(original)).toBe("ISSUED");
      const view = await getInvoice(admin(), original);
      expect(view.creditSummary?.partly).toBe(true);
      expect(view.creditSummary?.notes.map((n) => n.id)).toEqual([cn]);
      expect(view.can.credit).toBe(true);
      expect((await f.audits("invoice.issued")).at(-1)?.metadata).toMatchObject({ kind: "CREDIT_NOTE", creditsInvoiceId: original });
      // The frozen record reads as printed.
      const printed = await asMember(f.seats.admin.memberId, (tx) => readIssuedInvoice(tx, f.tenantId, cn, { strict: true }));
      expect(printed?.print).toMatchObject({
        kind: "CREDIT_NOTE",
        credits: { displayNumber: o.displayNumber },
        creditReason: "Line 1 overbilled",
        payment: { bankgiro: null, plusgiro: null, iban: null, bic: null },
      });
      expect(printed?.print.buyer.name).toBe("Acme AB");
    } finally {
      await f.platform.client.update({ where: { id: se }, data: { name: "Acme AB" } });
    }
  });

  it("never credits more than is left at a rate — the service names the rate, the guard refuses it too", async () => {
    const original = await issuedInvoice(se, [{ price: "1000" }]);
    const first = await createCreditDraft(admin(), original, { reason: "Part one" });
    await creditLines(first, ["600"]);
    await issueInvoice(admin(), first);
    const second = await createCreditDraft(admin(), original, { reason: "Part two" });
    await creditLines(second, ["500"]);
    const check = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, second));
    expect(check.blockers).toEqual(["overCredit"]);
    expect(check.overCredit).toEqual([{ rate: 2500n, left: 40_000n, asked: 50_000n }]);
    expect(await outcome(issueInvoice(admin(), second))).toBe("INVOICE_NOT_READY");
    expect(await refusal(issueCreditRaw(second, f.seats.admin.memberId))).toBe("INVOICE_OVER_CREDIT");
    // What is left, exactly, is fine — and completes the credit: the invoice is CREDITED, in the same transaction.
    await creditLines(second, ["400"]);
    const r = await issueInvoice(admin(), second);
    expect(r.creditedInFull).toBe(true);
    expect(await statusOf(original)).toBe("CREDITED");
    expect((await f.audits("invoice.credited")).at(-1)).toMatchObject({ targetId: original, metadata: { byCreditNoteId: second } });
    // Nothing more: a third is refused at its making and at its issue.
    expect(await outcome(createCreditDraft(admin(), original, { reason: "x" }))).toBe("INVOICE_NOT_CREDITABLE");
  });

  it("a rate its invoice lacks, a discount alone, a total of nothing — refused", async () => {
    const original = await issuedInvoice(se, [{ price: "1000" }, { price: "-200", rate: "25" }]);
    const cn = await createCreditDraft(admin(), original, { reason: "Rates" });
    const [goods] = await linesOf(cn);
    // A line at 12 %, which the invoice does not have: the app refuses it…
    expect(await outcome(updateLine(admin(), cn, goods!.id, { vatRate: "12" }))).toBe("INVOICE_RATE_NOT_ALLOWED");
    // …and planted past the app (107's line guard lets any member write a
    // draft's lines), the dialog names it and the GUARD refuses the issue.
    await asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice_line SET vat_rate_pct = 12 WHERE id = ${goods!.id}`);
    let check = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, cn));
    expect(check.blockers).toContain("overCredit");
    expect(check.overCredit.map((o) => o.rate)).toContain(1200n);
    expect(await refusal(issueCreditRaw(cn, f.seats.admin.memberId))).toBe("INVOICE_OVER_CREDIT");
    // Back at 25 % and only the discount kept: it would raise the invoice, never credit it.
    await asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice_line SET vat_rate_pct = 25 WHERE id = ${goods!.id}`);
    await removeLine(admin(), cn, goods!.id);
    check = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, cn));
    expect(check.blockers).toContain("notPositive");
    await deleteDraft(admin(), cn);
  });

  it("two credit notes issued at once on one invoice: one is, the other is refused — never over-credited", async () => {
    const original = await issuedInvoice(se, [{ price: "1000" }]);
    const a = await createCreditDraft(admin(), original, { reason: "A" });
    const b = await createCreditDraft(owner(), original, { reason: "B" });
    await creditLines(a, ["600"]);
    await creditLines(b, ["600"]);
    const results = await Promise.allSettled([issueInvoice(admin(), a), issueInvoice(owner(), b)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(DomainError);
    // The second waits for the first's hold on the invoice, then reads what it credited.
    // (Over a slow link the wait may outrun its bound: busy, never over-credited.)
    expect(["INVOICE_NOT_READY", "INVOICE_ISSUE_BUSY"]).toContain((refused[0]!.reason as DomainError).code);
    const credited = await f.platform.invoiceLine.aggregate({
      where: { invoice: { creditsInvoiceId: original, status: { not: "DRAFT" } } },
      _sum: { amountExVat: true },
    });
    expect(credited._sum.amountExVat?.toFixed(2)).toBe("600.00");
  });

  it("is bound to what the issuer saw: a reason changed since is INVOICE_CHANGED", async () => {
    const original = await issuedInvoice(se, [{ price: "300" }]);
    const cn = await createCreditDraft(admin(), original, { reason: "First reason" });
    const seen = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, cn));
    await updateDraftDetails(owner(), cn, { creditReason: "Another reason" });
    expect(await outcome(issueInvoice(admin(), cn, { fingerprint: seen.fingerprint }))).toBe("INVOICE_CHANGED");
    expect(await statusOf(cn)).toBe("DRAFT");
  });

  it("the database: an invoice reaches CREDITED only when covered, and a credit note's status moves only to SENT", async () => {
    const original = await issuedInvoice(se, [{ price: "800" }]);
    expect(
      await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET status = 'CREDITED' WHERE id = ${original}`)),
    ).toBe("INVOICE_GUARD");
    const cn = await createCreditDraft(admin(), original, { reason: "Half" });
    await creditLines(cn, ["400"]);
    await issueInvoice(admin(), cn);
    expect(
      await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET status = 'CREDITED' WHERE id = ${original}`)),
    ).toBe("INVOICE_GUARD");
    // Slice 109: a credit note is sent like an invoice — ISSUED → SENT, and
    // only with a send (`sent_at` and its record — `send.dbtest.ts`); never paid.
    expect(await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET status = 'SENT' WHERE id = ${cn}`))).toBe(
      "invoice_sent",
    );
    expect(
      await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET status = 'PAID', paid_on = issue_date WHERE id = ${cn}`)),
    ).toBe("INVOICE_GUARD");
    // Issued, it is frozen like any invoice — its reason included.
    expect(
      await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET credit_reason = 'other' WHERE id = ${cn}`)),
    ).toBe("INVOICE_NOT_DRAFT");
  });

  it("a draft whose invoice was credited in full meanwhile is refused at its issue", async () => {
    const original = await issuedInvoice(se, [{ price: "250" }]);
    const part = await createCreditDraft(admin(), original, { reason: "Part" });
    await creditInFull(admin(), original, { reason: "All of it", correctedCopy: false });
    expect(await outcome(issueInvoice(admin(), part))).toBe("INVOICE_NOT_CREDITABLE");
    expect(await statusOf(part)).toBe("DRAFT");
  });
});

describe("crediting in full (C77 (c))", () => {
  it("issues the credit note, credits the invoice and opens a corrected copy — in one transaction", async () => {
    const original = await issuedInvoice(se, [{ price: "1200" }, { price: "300", rate: "12" }]);
    const done = await creditInFull(admin(), original, { reason: "Wrong client reference", correctedCopy: true });
    expect(await statusOf(done.creditNoteId)).toBe("ISSUED");
    expect(await statusOf(original)).toBe("CREDITED");
    expect(done.copyId).not.toBeNull();
    const [o, copy] = await Promise.all([
      f.platform.invoice.findUniqueOrThrow({ where: { id: original } }),
      f.platform.invoice.findUniqueOrThrow({ where: { id: done.copyId! } }),
    ]);
    expect(copy).toMatchObject({
      kind: "INVOICE",
      status: "DRAFT",
      number: null,
      clientId: se,
      creditsInvoiceId: null,
      vatProfile: o.vatProfile,
      currency: o.currency,
      paymentTermsDays: o.paymentTermsDays,
      locale: o.locale,
      sellerSnapshot: null,
    });
    expect((await linesOf(done.copyId!)).map((l) => [l.description, l.amountExVat.toFixed(2), l.vatRatePct.toFixed(2)])).toEqual(
      (await linesOf(original)).map((l) => [l.description, l.amountExVat.toFixed(2), l.vatRatePct.toFixed(2)]),
    );
    // The copy is written FIRST (nothing slow while the series is held), so its row is not the newest.
    expect((await f.audits("invoice.created")).find((a) => a.targetId === done.copyId)?.metadata).toMatchObject({
      copiedFromInvoiceId: original,
    });
    // The next NEW draft for the client starts from its last INVOICE's terms,
    // never a credit note's none (the design review's medium).
    const next = await createDraft(manager(), { clientId: se });
    expect((await f.platform.invoice.findUniqueOrThrow({ where: { id: next } })).paymentTermsDays).toBe(copy.paymentTermsDays);
  });

  it("is refused once part of it is credited, and for a member without the codes or the client", async () => {
    const original = await issuedInvoice(se, [{ price: "900" }]);
    const part = await createCreditDraft(admin(), original, { reason: "Part" });
    await creditLines(part, ["100"]);
    await issueInvoice(admin(), part);
    expect(await outcome(creditInFull(admin(), original, { reason: "All", correctedCopy: true }))).toBe("INVOICE_PARTLY_CREDITED");
    expect(await outcome(creditInFull(manager(), original, { reason: "All", correctedCopy: false }))).toBe("FORBIDDEN");
    expect(await statusOf(original)).toBe("ISSUED");
  });

  it("a credit note in another currency takes its invoice's exchange rate", async () => {
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const file = `<Cube><Cube time='${day}'><Cube currency='SEK' rate='11.1940'/></Cube></Cube>`;
    const original = await issuedInvoice(se, [{ price: "1000" }], { currency: "EUR", fetchText: () => Promise.resolve(file) });
    const done = await creditInFull(admin(), original, { reason: "Currency", correctedCopy: false });
    const [o, c] = await Promise.all([
      f.platform.invoice.findUniqueOrThrow({ where: { id: original } }),
      f.platform.invoice.findUniqueOrThrow({ where: { id: done.creditNoteId } }),
    ]);
    expect(c.fxRateToSek?.toFixed(6)).toBe(o.fxRateToSek?.toFixed(6));
    expect(c.fxRateDate).toEqual(o.fxRateDate);
    expect(c.vatTotalSek?.toFixed(2)).toBe(o.vatTotalSek?.toFixed(2));
  });

  it("a reverse-charge invoice is credited with its wording and buyer kept", async () => {
    const original = await issuedInvoice(de, [{ price: "700", rate: "0" }], { profile: "EU_REVERSE_CHARGE" });
    const done = await creditInFull(admin(), original, { reason: "Duplicate", correctedCopy: false });
    const c = await f.platform.invoice.findUniqueOrThrow({ where: { id: done.creditNoteId } });
    expect(c.vatProfile).toBe("EU_REVERSE_CHARGE");
    expect((c.buyerSnapshot as { vatNumber?: string }).vatNumber).toBe("DE123456789");
  });
});

describe("who may, and of what (the reviews' lows)", () => {
  it("a member holding the codes but assigned only to another client reaches none of it — NOT_FOUND", async () => {
    const employee = () => ctxOf(f.seats.employee.memberId);
    const original = await issuedInvoice(se, [{ price: "640" }]);
    const cn = await createCreditDraft(admin(), original, { reason: "Scope" });
    // The grants INSIDE the try, so a failure halfway still cleans up (the re-check's nit).
    try {
      for (const code of ["invoice:view", "invoice:credit", "invoice:issue", "invoice:edit", "invoice:create"]) {
        const p = await f.platform.permission.findUniqueOrThrow({ where: { code }, select: { id: true } });
        await f.platform.rolePermission.create({
          data: { tenantId: f.tenantId, roleId: f.seats.employee.roleId, permissionId: p.id, source: "TENANT_GRANT" },
        });
      }
      await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: de } });
      await f.platform.tenant.update({ where: { id: f.tenantId }, data: { permissionsVersion: { increment: 1 } } });
      expect(await outcome(createCreditDraft(employee(), original, { reason: "x" }))).toBe("NOT_FOUND");
      expect(await outcome(creditInFull(employee(), original, { reason: "x", correctedCopy: true }))).toBe("NOT_FOUND");
      expect(await outcome(issueInvoice(employee(), cn))).toBe("NOT_FOUND");
      expect(await outcome(getInvoice(employee(), cn))).toBe("NOT_FOUND");
      expect(await outcome(updateDraftDetails(employee(), cn, { note: "x" }))).toBe("NOT_FOUND");
      expect(await statusOf(original)).toBe("ISSUED");
      // Never vacuous: the same seat credits its own client's invoice.
      const own = await issuedInvoice(de, [{ price: "100", rate: "0" }], { profile: "EU_REVERSE_CHARGE" });
      expect((await creditInFull(employee(), own, { reason: "Own client", correctedCopy: true })).copyId).not.toBeNull();
    } finally {
      await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId } });
      await f.platform.rolePermission.deleteMany({ where: { tenantId: f.tenantId, source: "TENANT_GRANT" } });
      await f.platform.tenant.update({ where: { id: f.tenantId }, data: { permissionsVersion: { increment: 1 } } });
    }
  });

  it("an invoice of nothing offers no Credit… and refuses one", async () => {
    const zero = await issuedInvoice(se, [{ price: "0" }]);
    expect((await getInvoice(admin(), zero)).can.credit).toBe(false);
    expect(await outcome(createCreditDraft(admin(), zero, { reason: "x" }))).toBe("INVOICE_NOT_CREDITABLE");
    expect(await outcome(creditInFull(admin(), zero, { reason: "x", correctedCopy: false }))).toBe("INVOICE_NOT_CREDITABLE");
  });

  it("a credit note's lines keep to its invoice's VAT rates — a new one takes the invoice's highest", async () => {
    const original = await issuedInvoice(se, [{ price: "300", rate: "12" }]);
    const cn = await createCreditDraft(admin(), original, { reason: "Rates" });
    const added = await addLine(admin(), cn, { description: "Another" });
    expect((await f.platform.invoiceLine.findUniqueOrThrow({ where: { id: added } })).vatRatePct.toFixed(2)).toBe("12.00");
    expect(await outcome(updateLine(admin(), cn, added, { vatRate: "25" }))).toBe("INVOICE_RATE_NOT_ALLOWED");
    expect(await outcome(addLine(admin(), cn, { description: "At 6", vatRate: "6" }))).toBe("INVOICE_RATE_NOT_ALLOWED");
    // The member's own copy draft — an invoice — keeps its treatment's rates.
    const draft = await createDraft(manager(), { clientId: se });
    const line = await addLine(manager(), draft, { description: "Plain" });
    expect(await outcome(updateLine(manager(), draft, line, { vatRate: "6" }))).toBe("ok");
    await deleteDraft(admin(), cn);
  });
});

describe("the credit note's PDF", () => {
  it("is made once, under its own word: kreditfaktura-<n>.pdf", async () => {
    const original = await issuedInvoice(se, [{ price: "150" }]);
    const done = await creditInFull(admin(), original, { reason: "PDF", correctedCopy: false });
    const pdf = await ensureInvoicePdf(admin(), done.creditNoteId);
    expect(pdf.fileName).toBe(`kreditfaktura-${done.displayNumber}.pdf`);
    expect((await f.platform.invoice.findUniqueOrThrow({ where: { id: done.creditNoteId } })).pdfFileId).toBe(pdf.fileObjectId);
  });
});
