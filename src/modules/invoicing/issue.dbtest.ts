import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { updateClient } from "@/clients/service";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { actorFor, noMfa, setupTenant } from "@/members/dbtest-fixture";
import { LocalDiskTransport, setStorage } from "@/storage";

import { addLine, createDraft, getInvoice, setDraftVatProfile, updateDraftDetails, updateLine } from "./drafts";
import { issueInvoice, readIssueCheck } from "./issue";
import { ensureInvoicePdf, invoicePdfUrl, makeMissingInvoicePdfs } from "./pdf-store";
import { updateCompanyDetails, updatePaymentDetails } from "./seller";
import { isAktiebolagOrgNr } from "./seller-fields";
import { setFirstInvoiceNumber } from "./series";

/**
 * ISSUING against the real database and the real app_runtime role (Phase 4
 * slice 108; founder decision C76; migration 20261009200000):
 *   - the numbering: one series, its first number set by an owner (✦) and
 *     fixed once used; the DATABASE allocates — consecutive, never twice,
 *     never skipped, under concurrent issues and refused ones;
 *   - what an issued invoice says about its parties: written by the guard
 *     from the live rows (the app's own values overwritten), frozen after;
 *     the bank details are the tenant's ciphertexts and still decrypt;
 *   - what an invoice must carry, refused by the service AND the guard; the
 *     VAT treatment against the buyer's country;
 *   - VAT in SEK on another currency, at a given ECB file's rate; the rate for
 *     the wrong currency refused (INVOICE_CHANGED);
 *   - the PDF: made once, fail-closed, the file frozen, the sweep's backstop.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let se: string; // Swedish, with an address
let de: string; // German business with a VAT number
let us: string; // US
let bare: string; // Swedish, no address
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-invoice-pdf-"));

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
  "INVOICE_SERIES_IN_USE",
  "INVOICE_SERIES_GUARD",
  "INVOICE_NO_SERIES",
  "INVOICE_SELLER_INCOMPLETE",
  "INVOICE_BUYER_INCOMPLETE",
  "INVOICE_NOT_DRAFT",
  // Slice 111: the booking rate's own guard fires BEFORE `invoice_guard`
  // (name order), so it is matched first.
  "INVOICE_BOOK_RATE_GUARD",
  "INVOICE_GUARD",
  "FILE_INVOICE_PDF_GUARD",
  "invoice_series_tenant_id_key",
  "invoice_sek_vat",
  // The runtime role holds no DELETE on invoice_series at all — refused before any guard.
  "permission denied for table invoice_series",
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

const asMember = <T>(memberId: string, fn: (tx: TenantDb) => Promise<T>, opts?: { timeoutMs?: number }) =>
  withTenant(f.tenantId, { type: "member", id: memberId }, fn, opts);

const series = () => f.platform.invoiceSeries.findFirstOrThrow({ where: { tenantId: f.tenantId } });

/**
 * A draft with one line (quantity × price), at the treatment and currency
 * given — SEK unless said: a new draft starts in its client's LAST invoice's
 * currency, so after a EUR test the next "plain" draft would be in EUR.
 */
async function draftFor(clientId: string, price = "1000", opts: { profile?: string; currency?: string } = {}) {
  const id = await createDraft(manager(), { clientId });
  if (opts.profile) await setDraftVatProfile(manager(), id, opts.profile);
  await updateDraftDetails(manager(), id, { currency: opts.currency ?? "SEK" });
  const line = await addLine(manager(), id, { description: "Work" });
  await updateLine(manager(), id, line, { unitPrice: price });
  return id;
}

/** Issue by raw SQL as `memberId`, past the service — the guard is all that stands. */
async function issueRaw(invoiceId: string, memberId: string, extra: { sql?: "forged" } = {}) {
  const detail = await getInvoice(owner(), invoiceId);
  const s = await series();
  const sub = (Number(detail.totals.subtotal) / 100).toFixed(2);
  const vat = (Number(detail.totals.vatTotal) / 100).toFixed(2);
  const total = (Number(detail.totals.total) / 100).toFixed(2);
  return asMember(memberId, (tx) =>
    extra.sql === "forged"
      ? tx.$executeRaw`
          UPDATE invoice
             SET status = 'ISSUED', series_id = ${s.id}, locale = 'sv', number = 1, display_number = 'FORGED',
                 seller_snapshot = '{"legalName":"Someone Else AB"}'::jsonb,
                 payment_snapshot = '{"bankgiro":"999-9999"}'::jsonb,
                 buyer_snapshot = '{"name":"Not The Client"}'::jsonb,
                 issue_date = CURRENT_DATE, due_date = CURRENT_DATE + payment_terms_days,
                 issued_at = now(), issued_by_member_id = ${memberId},
                 subtotal_ex_vat = ${sub}::numeric, vat_total = ${vat}::numeric, total = ${total}::numeric
           WHERE id = ${invoiceId}`
      : tx.$executeRaw`
          UPDATE invoice
             SET status = 'ISSUED', series_id = ${s.id}, locale = 'sv',
                 issue_date = CURRENT_DATE, due_date = CURRENT_DATE + payment_terms_days,
                 issued_at = now(), issued_by_member_id = ${memberId},
                 subtotal_ex_vat = ${sub}::numeric, vat_total = ${vat}::numeric, total = ${total}::numeric
           WHERE id = ${invoiceId}`,
  );
}

/** An ECB daily file dated `day`, as the fetch would return it. */
const ecbFile = (day: string) => `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube><Cube time='${day}'>
    <Cube currency='USD' rate='1.1186'/>
    <Cube currency='SEK' rate='11.1940'/>
  </Cube></Cube>
</gesmes:Envelope>`;
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  setStorage(new LocalDiskTransport(storageDir));
  f = await setupTenant("invi");
  se = randomUUID();
  de = randomUUID();
  us = randomUUID();
  bare = randomUUID();
  const address = { addressLine1: "Gatan 1", postalCode: "111 22", city: "Stockholm" };
  await f.platform.client.createMany({
    data: [
      { id: se, tenantId: f.tenantId, name: "Acme AB", countryCode: "SE", orgNr: "556677-8899", ...address },
      { id: de, tenantId: f.tenantId, name: "Beta GmbH", countryCode: "DE", vatNumber: "DE123456789", ...address, city: "Berlin" },
      { id: us, tenantId: f.tenantId, name: "Gamma Inc", countryCode: "US", ...address, city: "Boston" },
      { id: bare, tenantId: f.tenantId, name: "Bare AB", countryCode: "SE" },
    ],
  });
  // The seller, through the protected services (the owner with a fresh code) —
  // so the bank detail is a real v2 ciphertext under the tenant's key.
  await updateCompanyDetails(owner(), {
    legalName: "Invi Konsult AB",
    orgNr: "556016-0680",
    vatNumber: "SE556016068001",
    seat: "Stockholm",
    fSkattApproved: true,
    addressLine1: "Storgatan 1",
    postalCode: "111 22",
    city: "Stockholm",
    countryCode: "SE",
  });
  await updatePaymentDetails(owner(), { bankgiro: "5050-1055", footerNote: "Thank you." });
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

describe("the numbering (C76 (a)–(c))", () => {
  it("issuing waits for a first number: the dialog says so, the service refuses", async () => {
    const id = await draftFor(se);
    const check = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, id));
    expect(check.blockers).toEqual(["seller"]);
    expect(check.sellerMissing).toEqual(["numbering"]);
    expect(check.nextNumber).toBeNull();
    expect(await outcome(issueInvoice(admin(), id))).toBe("INVOICE_NOT_READY");
    // …and the database too, past the service.
    expect(await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`
      UPDATE invoice SET status = 'ISSUED', locale = 'sv', issue_date = CURRENT_DATE,
             due_date = CURRENT_DATE + payment_terms_days, issued_at = now(), issued_by_member_id = ${f.seats.admin.memberId},
             subtotal_ex_vat = 1000, vat_total = 250, total = 1250
       WHERE id = ${id}`))).toBe("INVOICE_NO_SERIES");
  });

  it("is an owner's to set (✦: a fresh second factor), and changes freely until an invoice holds a number", async () => {
    expect(await outcome(setFirstInvoiceNumber(admin(), "10001"))).toBe("FORBIDDEN");
    expect(
      await outcome(setFirstInvoiceNumber({ tenantId: f.tenantId, actor: noMfa(f.seats.owner.memberId) }, "10001")),
    ).toBe("MFA_REQUIRED");
    expect(await outcome(setFirstInvoiceNumber(owner(), "0"))).toBe("INVALID_INPUT");
    expect(await outcome(setFirstInvoiceNumber(owner(), "1 000 000 000"))).toBe("INVALID_INPUT");
    expect(await setFirstInvoiceNumber(owner(), "10 001")).toBe(true);
    expect(await setFirstInvoiceNumber(owner(), "10001")).toBe(false);
    expect(await setFirstInvoiceNumber(owner(), "20001")).toBe(true);
    const s = await series();
    expect([s.firstNumber, s.nextNumber]).toEqual([20001, 20001]);
    expect((await f.audits("series.created")).map((a) => (a.metadata as { firstNumber: number }).firstNumber)).toEqual([10001]);
    expect((await f.audits("series.first_number_changed")).map((a) => a.metadata)).toEqual([{ from: 10001, to: 20001 }]);
  });

  it("the database: no second series, no step it did not take, no rewind, no member without the code, no delete", async () => {
    const s = await series();
    expect(
      await refusal(asMember(f.seats.owner.memberId, (tx) => tx.$executeRaw`
        INSERT INTO invoice_series (id, tenant_id, first_number, next_number, created_by_member_id, updated_at)
        VALUES (${randomUUID()}, ${f.tenantId}, 5, 5, ${f.seats.owner.memberId}, now())`)),
    ).toBe("invoice_series_tenant_id_key");
    expect(
      await refusal(asMember(f.seats.owner.memberId, (tx) => tx.$executeRaw`UPDATE invoice_series SET next_number = next_number + 5 WHERE id = ${s.id}`)),
    ).toBe("INVOICE_SERIES_GUARD");
    expect(
      await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice_series SET first_number = 7, next_number = 7 WHERE id = ${s.id}`)),
    ).toBe("INVOICE_SERIES_GUARD");
    expect(await refusal(asMember(f.seats.owner.memberId, (tx) => tx.$executeRaw`DELETE FROM invoice_series WHERE id = ${s.id}`))).toBe(
      "permission denied for table invoice_series",
    );
    // …and the platform role, outside the maintenance GUC, meets the guard.
    expect(await refusal(f.platform.$executeRaw`DELETE FROM invoice_series WHERE id = ${s.id}`)).toBe("INVOICE_SERIES_GUARD");
  });
});

describe("issuing", () => {
  let first: string;

  it("gives the first number, today's date, its terms' due date, the language, and audits it", async () => {
    first = await draftFor(se, "1000");
    const check = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, first));
    expect(check.blockers).toEqual([]);
    expect(check.nextNumber).toBe(20001);
    expect(check.noPeriod).toBe(true);
    const r = await issueInvoice(admin(), first);
    expect(r).toEqual({ kind: "INVOICE", number: 20001, displayNumber: "20001", creditedInFull: false });
    const row = await f.platform.invoice.findUniqueOrThrow({ where: { id: first } });
    expect(row.status).toBe("ISSUED");
    expect(row.locale).toBe("sv");
    expect(row.total?.toFixed(2)).toBe("1250.00");
    expect(row.issueDate?.toISOString().slice(0, 10)).toBe(check.issueDate);
    expect(row.dueDate?.toISOString().slice(0, 10)).toBe(check.dueDate);
    expect([row.fxRateToSek, row.fxRateDate, row.vatTotalSek, row.pdfFileId]).toEqual([null, null, null, null]);
    expect((await series()).nextNumber).toBe(20002);
    const audit = (await f.audits("invoice.issued")).at(-1)!;
    expect(audit.targetId).toBe(first);
    expect(audit.metadata).toMatchObject({ number: 20001, displayNumber: "20001", clientId: se, currency: "SEK", total: "1250.00" });
  });

  it("writes the parties from the live rows — the bank detail as the tenant's ciphertext — and freezes them", async () => {
    const row = await f.platform.invoice.findUniqueOrThrow({ where: { id: first } });
    const seller = row.sellerSnapshot as Record<string, unknown>;
    const buyer = row.buyerSnapshot as Record<string, unknown>;
    const payment = row.paymentSnapshot as Record<string, unknown>;
    // The key sets are what `issued.ts` reads (the design review's pin).
    expect(Object.keys(seller).sort()).toEqual(
      ["addressLine1", "addressLine2", "city", "countryCode", "fSkattApproved", "footerNote", "legalName", "orgNr", "postalCode", "seat", "vatNumber"],
    );
    expect(Object.keys(buyer).sort()).toEqual(["addressLine1", "addressLine2", "city", "countryCode", "name", "orgNr", "postalCode", "vatNumber"]);
    expect(Object.keys(payment).sort()).toEqual(["bankgiro", "bic", "iban", "plusgiro"]);
    expect(seller).toMatchObject({ legalName: "Invi Konsult AB", seat: "Stockholm", fSkattApproved: true, footerNote: "Thank you." });
    expect(buyer).toMatchObject({ name: "Acme AB", orgNr: "556677-8899", city: "Stockholm" });
    const tenant = await f.platform.tenant.findUniqueOrThrow({ where: { id: f.tenantId } });
    expect(payment.bankgiro).toBe(tenant.bankgiro);
    expect(String(payment.bankgiro).startsWith("v2.")).toBe(true);

    // Later edits to the tenant and the client never reach it.
    await updateCompanyDetails(owner(), { legalName: "Renamed AB" });
    await f.platform.client.update({ where: { id: se }, data: { name: "Acme Renamed AB" } });
    const view = await getInvoice(manager(), first);
    expect(view.issued?.print.seller.legalName).toBe("Invi Konsult AB");
    expect(view.issued?.print.buyer.name).toBe("Acme AB");
    expect(view.issued?.print.payment.bankgiro).toBe("5050-1055");
    expect(view.issued?.paymentUnreadable).toBe(false);
    await updateCompanyDetails(owner(), { legalName: "Invi Konsult AB" });
    await f.platform.client.update({ where: { id: se }, data: { name: "Acme AB" } });
  });

  it("the first number is fixed once one is taken — the service and the database", async () => {
    expect(await outcome(setFirstInvoiceNumber(owner(), "30001"))).toBe("INVOICE_SERIES_IN_USE");
    const s = await series();
    expect(
      await refusal(asMember(f.seats.owner.memberId, (tx) => tx.$executeRaw`UPDATE invoice_series SET first_number = 30001, next_number = 30001 WHERE id = ${s.id}`)),
    ).toBe("INVOICE_SERIES_IN_USE");
  });

  it("the number is the database's: a forged number and forged snapshots are overwritten", async () => {
    const id = await draftFor(se);
    const before = (await series()).nextNumber;
    expect(await refusal(issueRaw(id, f.seats.admin.memberId, { sql: "forged" }))).toBe("ok");
    const row = await f.platform.invoice.findUniqueOrThrow({ where: { id } });
    expect(row.number).toBe(before);
    expect(row.displayNumber).toBe(String(before));
    expect((row.sellerSnapshot as Record<string, unknown>).legalName).toBe("Invi Konsult AB");
    expect((row.buyerSnapshot as Record<string, unknown>).name).toBe("Acme AB");
    expect(String((row.paymentSnapshot as Record<string, unknown>).bankgiro).startsWith("v2.")).toBe(true);
  });

  it("A RACE: concurrent issues take consecutive numbers — none twice, none skipped", async () => {
    const drafts: string[] = [];
    for (let i = 0; i < 6; i += 1) drafts.push(await draftFor(se, String(100 + i)));
    const start = (await series()).nextNumber;
    const results = await Promise.all(drafts.map((id) => issueInvoice(admin(), id)));
    const numbers = results.map((r) => r.number).sort((a, b) => a - b);
    expect(numbers).toEqual([0, 1, 2, 3, 4, 5].map((k) => start + k));
    expect((await series()).nextNumber).toBe(start + 6);
  }, 120_000);

  it("a refused issue takes nothing: the next one gets the very next number", async () => {
    const s = await series();
    const start = s.nextNumber;
    const noAddress = await draftFor(bare);
    expect(await outcome(issueInvoice(admin(), noAddress))).toBe("INVOICE_NOT_READY");
    expect(await refusal(issueRaw(noAddress, f.seats.admin.memberId))).toBe("INVOICE_BUYER_INCOMPLETE");
    // Forged totals: refused before the allocation — and a refusal anywhere rolls the statement back.
    const forged = await draftFor(se);
    expect(
      await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`
        UPDATE invoice SET status = 'ISSUED', series_id = ${s.id}, locale = 'sv',
               issue_date = CURRENT_DATE, due_date = CURRENT_DATE + payment_terms_days, issued_at = now(),
               issued_by_member_id = ${f.seats.admin.memberId}, subtotal_ex_vat = 1, vat_total = 0, total = 1
         WHERE id = ${forged}`)),
    ).toBe("INVOICE_GUARD");
    expect((await series()).nextNumber).toBe(start);
    expect((await issueInvoice(admin(), forged)).number).toBe(start);
  });

  it("only a member who may issue: the service and the database", async () => {
    const id = await draftFor(se);
    expect(await outcome(issueInvoice(manager(), id))).toBe("FORBIDDEN");
    expect(await refusal(issueRaw(id, f.seats.manager.memberId))).toBe("INVOICE_GUARD");
  });

  it("refuses an invoice missing what the seller must say — the guard too", async () => {
    const id = await draftFor(se);
    // The platform role is not judged by the details' backstop: blank the org. number underneath.
    const { orgNr } = await f.platform.tenant.findUniqueOrThrow({ where: { id: f.tenantId } });
    await f.platform.tenant.update({ where: { id: f.tenantId }, data: { orgNr: null } });
    try {
      expect(await outcome(issueInvoice(admin(), id))).toBe("INVOICE_NOT_READY");
      expect(await refusal(issueRaw(id, f.seats.admin.memberId))).toBe("INVOICE_SELLER_INCOMPLETE");
      // An aktiebolag without its registered office.
      await f.platform.tenant.update({ where: { id: f.tenantId }, data: { orgNr, seat: null } });
      expect(await refusal(issueRaw(id, f.seats.admin.memberId))).toBe("INVOICE_SELLER_INCOMPLETE");
    } finally {
      await f.platform.tenant.update({ where: { id: f.tenantId }, data: { orgNr, seat: "Stockholm" } });
    }
  });

  it("the säte rule reads an org. number the same in SQL and in the app", async () => {
    for (const orgNr of ["556016-0680", "5560160680", "502000-1234", "512345-6789", "212000-1355", "802000-0000", "19800101-1234"]) {
      const rows = await asMember(f.seats.owner.memberId, (tx) =>
        tx.$queryRaw<{ ab: boolean }[]>`SELECT regexp_replace(${orgNr}, '[^0-9]', '', 'g') ~ '^5[0-9][2-9]' AS ab`,
      );
      expect([orgNr, rows[0]!.ab]).toEqual([orgNr, isAktiebolagOrgNr(orgNr)]);
    }
  });

  it("the VAT treatment must fit the buyer's country", async () => {
    // Reverse charge to a German business with a DE number: fine (no VAT, so no rate).
    const ok = await draftFor(de, "500", { profile: "EU_REVERSE_CHARGE" });
    expect((await issueInvoice(admin(), ok)).number).toBeGreaterThan(0);
    // Reverse charge to a US client: not an EU business.
    const usRc = await draftFor(us, "500", { profile: "EU_REVERSE_CHARGE" });
    const check = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, usRc));
    expect(check.blockers).toEqual(["clientVatNumber"]);
    await f.platform.client.update({ where: { id: us }, data: { vatNumber: "US123" } });
    const check2 = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, usRc));
    expect(check2.blockers).toEqual(["clientVatCountry"]);
    expect(await refusal(issueRaw(usRc, f.seats.admin.memberId))).toBe("INVOICE_BUYER_INCOMPLETE");
    await f.platform.client.update({ where: { id: us }, data: { vatNumber: null } });
    // Outside the scope to a Swedish client: it is in the EU.
    const seOut = await draftFor(se, "500", { profile: "OUTSIDE_SCOPE" });
    const check3 = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, seOut));
    expect(check3.blockers).toEqual(["clientInEu"]);
    expect(await refusal(issueRaw(seOut, f.seats.admin.memberId))).toBe("INVOICE_BUYER_INCOMPLETE");
    // Outside the scope to the US client, in English by its country.
    const usOut = await draftFor(us, "500", { profile: "OUTSIDE_SCOPE", currency: "USD" });
    await issueInvoice(admin(), usOut);
    const row = await f.platform.invoice.findUniqueOrThrow({ where: { id: usOut } });
    expect([row.locale, row.fxRateToSek]).toEqual(["en", null]);
    // Slice 111 (C82 (d)): no VAT in kronor to state, but booked at the ECB's
    // rate of its date (the harness's fixed table, dated yesterday).
    expect(row.bookRateToSek).not.toBeNull();
  });

  it("a draft that names its language keeps it", async () => {
    const id = await draftFor(se);
    await updateDraftDetails(manager(), id, { locale: "en" });
    expect(await outcome(updateDraftDetails(manager(), id, { locale: "de" }))).toBe("INVALID_INPUT");
    await issueInvoice(admin(), id);
    expect((await f.platform.invoice.findUniqueOrThrow({ where: { id } })).locale).toBe("en");
  });
});

describe("VAT in SEK on another currency (the ECB's rate)", () => {
  it("states each rate's VAT in SEK at the file's rate, and the date of the file", async () => {
    const id = await draftFor(se, "1234.56", { currency: "EUR" });
    const day = yesterday();
    await issueInvoice(admin(), id, { fetchText: () => Promise.resolve(ecbFile(day)) });
    const row = await f.platform.invoice.findUniqueOrThrow({ where: { id } });
    expect(row.fxRateToSek?.toFixed(6)).toBe("11.194000");
    expect(row.fxRateDate?.toISOString().slice(0, 10)).toBe(day);
    // VAT 308.64 EUR × 11.194 = 3454.916… → 3454.92
    expect(row.vatTotal?.toFixed(2)).toBe("308.64");
    expect(row.vatTotalSek?.toFixed(2)).toBe("3454.92");
    const view = await getInvoice(manager(), id);
    expect(view.issued?.print.sekVat?.totalSek).toBe(345_492n);
  });

  it("never at a guessed rate: an unreachable ECB refuses, and the draft stays a draft", async () => {
    const id = await draftFor(se, "100", { currency: "EUR" });
    expect(await outcome(issueInvoice(admin(), id, { fetchText: () => Promise.reject(new Error("offline")) }))).toBe(
      "INVOICE_FX_UNAVAILABLE",
    );
    expect((await f.platform.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("DRAFT");
  });

  it("a rate for the wrong currency is refused (the draft changed while the rate was fetched)", async () => {
    const id = await draftFor(se, "100", { currency: "EUR" });
    const changing = async () => {
      await updateDraftDetails(manager(), id, { currency: "USD" });
      return ecbFile(yesterday());
    };
    expect(await outcome(issueInvoice(admin(), id, { fetchText: changing }))).toBe("INVOICE_CHANGED");
    expect((await f.platform.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("DRAFT");
  });

  // Slice 108b — founder decision C78 (a).
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  it("takes the ECB rate of the day the WORK ENDED, from the history file — the last one on or before it", async () => {
    const id = await draftFor(se, "1000", { currency: "EUR" });
    await updateDraftDetails(manager(), id, { periodStart: daysAgo(30), periodEnd: daysAgo(14) });
    const check = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, id));
    expect(check.rateDay).toBe(daysAgo(14));
    let asked = "";
    const history = `<Cube>
      <Cube time="${daysAgo(13)}"><Cube currency="SEK" rate="11.3000"/></Cube>
      <Cube time="${daysAgo(16)}"><Cube currency="SEK" rate="11.2000"/></Cube>
      <Cube time="${daysAgo(20)}"><Cube currency="SEK" rate="11.1000"/></Cube>
    </Cube>`;
    await issueInvoice(admin(), id, {
      fetchText: (url) => {
        asked = url;
        return Promise.resolve(history);
      },
    });
    expect(asked).toMatch(/eurofxref-hist-90d\.xml$/);
    const row = await f.platform.invoice.findUniqueOrThrow({ where: { id } });
    expect(row.fxRateDate?.toISOString().slice(0, 10)).toBe(daysAgo(16));
    expect(row.fxRateToSek?.toFixed(6)).toBe("11.200000");
  });

  it("a work period that ended over 90 days ago is refused before the click and at the issue, nothing fetched", async () => {
    const id = await draftFor(se, "100", { currency: "EUR" });
    await updateDraftDetails(manager(), id, { periodStart: daysAgo(120), periodEnd: daysAgo(100) });
    const check = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, id));
    expect(check.blockers).toEqual(["fxTooOld"]);
    expect(await outcome(issueInvoice(admin(), id, { fetchText: () => Promise.reject(new Error("never fetched")) }))).toBe(
      "INVOICE_FX_TOO_OLD",
    );
    await updateDraftDetails(manager(), id, { currency: "SEK" });
  });

  it("the database holds the rate's date to the ten days before the day the work ended", async () => {
    const id = await draftFor(se, "100", { currency: "EUR" });
    await updateDraftDetails(manager(), id, { periodEnd: daysAgo(30) });
    const s = await series();
    const raw = (rateDate: string) =>
      asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`
        UPDATE invoice SET status = 'ISSUED', series_id = ${s.id}, locale = 'sv',
               issue_date = CURRENT_DATE, due_date = CURRENT_DATE + payment_terms_days, issued_at = now(),
               issued_by_member_id = ${f.seats.admin.memberId}, subtotal_ex_vat = 100, vat_total = 25.00, total = 125.00,
               fx_rate_to_sek = 11.194, fx_rate_date = ${rateDate}::date, vat_total_sek = 279.85,
               -- Slice 111 (C82 (f)): carrying VAT, it is booked at its VAT's rate.
               book_rate_to_sek = 11.194, book_rate_date = ${rateDate}::date
         WHERE id = ${id}`);
    // Yesterday's rate is AFTER the work ended — slice 108's window took it, C78 (a) does not.
    expect(await refusal(raw(daysAgo(1)))).toBe("INVOICE_GUARD");
    expect(await refusal(raw(daysAgo(45)))).toBe("INVOICE_GUARD");
    expect(await refusal(raw(daysAgo(31)))).toBe("ok");
  });

  it("the database: no rate on SEK, no missing rate on another currency, the SEK VAT recomputed", async () => {
    const sek = await draftFor(se, "100");
    const s = await series();
    const raw = (id: string, fx: string | null, sekVat: string | null, vat: string, total: string) =>
      asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`
        UPDATE invoice SET status = 'ISSUED', series_id = ${s.id}, locale = 'sv',
               issue_date = CURRENT_DATE, due_date = CURRENT_DATE + payment_terms_days, issued_at = now(),
               issued_by_member_id = ${f.seats.admin.memberId}, subtotal_ex_vat = 100, vat_total = ${vat}::numeric, total = ${total}::numeric,
               fx_rate_to_sek = ${fx}::numeric, fx_rate_date = CASE WHEN ${fx}::text IS NULL THEN NULL ELSE CURRENT_DATE - 1 END,
               vat_total_sek = ${sekVat}::numeric,
               book_rate_to_sek = ${fx}::numeric, book_rate_date = CASE WHEN ${fx}::text IS NULL THEN NULL ELSE CURRENT_DATE - 1 END
         WHERE id = ${id}`);
    expect(await refusal(raw(sek, "11.194", "279.85", "25.00", "125.00"))).toBe("INVOICE_GUARD");
    const eur = await draftFor(se, "100", { currency: "EUR" });
    // No rate at all: since slice 111 the booking rate's guard says so first.
    expect(await refusal(raw(eur, null, null, "25.00", "125.00"))).toBe("INVOICE_BOOK_RATE_GUARD");
    expect(await refusal(raw(eur, "11.194", "279.86", "25.00", "125.00"))).toBe("INVOICE_GUARD");
    expect(await refusal(raw(eur, "11.194", "279.85", "25.00", "125.00"))).toBe("ok");
  });
});

describe("the PDF", () => {
  let id: string;

  beforeAll(async () => {
    id = await draftFor(se, "2500");
    await issueInvoice(admin(), id);
  });

  it("is made once, stored as a committed INVOICE_PDF, recorded on the invoice, and audited with its drawing's version", async () => {
    const pdf = await ensureInvoicePdf(manager(), id);
    const row = await f.platform.invoice.findUniqueOrThrow({ where: { id } });
    expect(row.pdfFileId).toBe(pdf.fileObjectId);
    const file = await f.platform.fileObject.findUniqueOrThrow({ where: { id: pdf.fileObjectId } });
    expect([file.kind, file.status, file.contentType]).toEqual(["INVOICE_PDF", "COMMITTED", "application/pdf"]);
    expect(file.originalFilename).toMatch(/^faktura-\d+\.pdf$/);
    const bytes = readFileSync(join(storageDir, file.r2Key));
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(Number(file.sizeBytes)).toBe(bytes.byteLength);
    const audit = (await f.audits("invoice.pdf_generated")).at(-1)!;
    expect(audit.metadata).toMatchObject({ fileObjectId: pdf.fileObjectId, sha256: file.sha256, templateVersion: 3 });
    // Again: the same file, nothing new.
    expect((await ensureInvoicePdf(manager(), id)).fileObjectId).toBe(pdf.fileObjectId);
    expect(await f.platform.fileObject.count({ where: { tenantId: f.tenantId, kind: "INVOICE_PDF", invoices: { some: { id } } } })).toBe(1);
  });

  it("two at once: one is recorded, the other's upload is not", async () => {
    const other = await draftFor(se, "300");
    await issueInvoice(admin(), other);
    const [a, b] = await Promise.all([ensureInvoicePdf(manager(), other), ensureInvoicePdf(admin(), other)]);
    expect(a.fileObjectId).toBe(b.fileObjectId);
    expect((await f.platform.invoice.findUniqueOrThrow({ where: { id: other } })).pdfFileId).toBe(a.fileObjectId);
    expect((await f.audits("invoice.pdf_generated")).filter((x) => x.targetId === other)).toHaveLength(1);
  });

  it("is never replaced, and its file never changes", async () => {
    const row = await f.platform.invoice.findUniqueOrThrow({ where: { id } });
    const stray = randomUUID();
    await f.platform.fileObject.create({
      data: { id: stray, tenantId: f.tenantId, r2Key: `${f.tenantId}/${stray}`, kind: "INVOICE_PDF", sha256: "0".repeat(64), sizeBytes: 1n, contentType: "application/pdf", status: "COMMITTED" },
    });
    expect(await refusal(asMember(f.seats.owner.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET pdf_file_id = ${stray} WHERE id = ${id}`))).toBe(
      "INVOICE_NOT_DRAFT",
    );
    expect(
      await refusal(asMember(f.seats.owner.memberId, (tx) => tx.$executeRaw`UPDATE file_object SET status = 'DELETED' WHERE id = ${row.pdfFileId}`)),
    ).toBe("FILE_INVOICE_PDF_GUARD");
    const general = randomUUID();
    await f.platform.fileObject.create({
      data: { id: general, tenantId: f.tenantId, r2Key: `${f.tenantId}/${general}`, kind: "GENERAL", sha256: "1".repeat(64), sizeBytes: 1n, contentType: "application/pdf", status: "COMMITTED" },
    });
    expect(
      await refusal(asMember(f.seats.owner.memberId, (tx) => tx.$executeRaw`UPDATE file_object SET kind = 'INVOICE_PDF' WHERE id = ${general}`)),
    ).toBe("FILE_INVOICE_PDF_GUARD");
    await f.platform.fileObject.deleteMany({ where: { id: { in: [stray, general] } } });
  });

  it("fails closed: bank details it cannot decrypt make no PDF at all; the sweep retries, and makes the others", async () => {
    const tenant = await f.platform.tenant.findUniqueOrThrow({ where: { id: f.tenantId } });
    const broken = await draftFor(se, "50");
    // A ciphertext of the right shape that will not authenticate — issued past the service.
    await f.platform.tenant.update({ where: { id: f.tenantId }, data: { bankgiro: `${tenant.bankgiro!.slice(0, -4)}AAAA` } });
    try {
      // The service will not issue on a bank detail it cannot read (the
      // migration review's low): it would be copied and stop the PDF for good.
      const check = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, broken));
      expect(check.sellerMissing).toEqual(["payment", "paymentUnreadable"]);
      expect(await outcome(issueInvoice(admin(), broken))).toBe("INVOICE_NOT_READY");
      expect(await refusal(issueRaw(broken, f.seats.admin.memberId))).toBe("ok");
    } finally {
      await f.platform.tenant.update({ where: { id: f.tenantId }, data: { bankgiro: tenant.bankgiro } });
    }
    expect(await outcome(ensureInvoicePdf(manager(), broken))).toBe("INVOICE_PDF_UNAVAILABLE");
    expect((await f.platform.invoice.findUniqueOrThrow({ where: { id: broken } })).pdfFileId).toBeNull();
    // The page still shows it, and says the bank details could not be read.
    expect((await getInvoice(manager(), broken)).issued?.paymentUnreadable).toBe(true);

    const pending = await draftFor(se, "60");
    await issueInvoice(admin(), pending);
    const later = new Date(Date.now() + 10 * 60_000);
    // Every invoice this suite issued without a PDF is the sweep's; a kick
    // takes a batch, so sweep until a kick makes nothing new.
    const swept = { made: 0, failed: 0 };
    for (let kick = 0; kick < 5; kick += 1) {
      const r = await makeMissingInvoicePdfs(f.tenantId, later);
      swept.made += r.made;
      swept.failed += r.failed;
      if (r.made === 0) break;
    }
    expect(swept.failed).toBeGreaterThanOrEqual(1);
    expect(swept.made).toBeGreaterThanOrEqual(1);
    expect((await f.platform.invoice.findUniqueOrThrow({ where: { id: pending } })).pdfFileId).not.toBeNull();
    expect((await f.platform.invoice.findUniqueOrThrow({ where: { id: broken } })).pdfFileId).toBeNull();
    const made = await f.platform.fileObject.findFirstOrThrow({ where: { invoices: { some: { id: pending } } } });
    expect(made.createdByMemberId).toBeNull();
  }, 240_000);

  it("is a draft's never", async () => {
    const id2 = await draftFor(se);
    expect(await outcome(ensureInvoicePdf(manager(), id2))).toBe("INVOICE_NOT_READY");
  });
});

describe("what the issuer saw (the security review's medium)", () => {
  it("an issue refuses a draft — or its client — changed since the dialog was opened", async () => {
    const id = await draftFor(se, "700");
    const seen = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, id));
    // A manager (may edit, may not issue) rewrites the note after the issuer looked.
    await updateDraftDetails(manager(), id, { note: "Our bank details have changed: pay to BG 999-9999." });
    expect(await outcome(issueInvoice(admin(), id, { fingerprint: seen.fingerprint }))).toBe("INVOICE_CHANGED");
    expect((await f.platform.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("DRAFT");
    // The client's printed details count too.
    const again = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, id));
    expect(again.fingerprint).not.toBe(seen.fingerprint);
    await f.platform.client.update({ where: { id: se }, data: { addressLine2: "c/o Someone Else" } });
    try {
      expect(await outcome(issueInvoice(admin(), id, { fingerprint: again.fingerprint }))).toBe("INVOICE_CHANGED");
    } finally {
      await f.platform.client.update({ where: { id: se }, data: { addressLine2: null } });
    }
    // Looked at again, as it is now: issued.
    const now = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, id));
    expect(now.fingerprint).toBe(again.fingerprint);
    expect((await issueInvoice(admin(), id, { fingerprint: now.fingerprint })).number).toBe(now.nextNumber);
  });
});

describe("who may — DIRECT client scope on every new path (the security review's low)", () => {
  it("a member given the codes but assigned only to another client reaches neither the issue nor the PDF", async () => {
    const employee = () => ctxOf(f.seats.employee.memberId);
    const issued = await draftFor(se, "800");
    await issueInvoice(admin(), issued);
    const draft = await draftFor(se, "900");
    for (const code of ["invoice:view", "invoice:issue"]) {
      const p = await f.platform.permission.findUniqueOrThrow({ where: { code }, select: { id: true } });
      await f.platform.rolePermission.create({
        data: { tenantId: f.tenantId, roleId: f.seats.employee.roleId, permissionId: p.id, source: "TENANT_GRANT" },
      });
    }
    await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: de } });
    await f.platform.tenant.update({ where: { id: f.tenantId }, data: { permissionsVersion: { increment: 1 } } });
    try {
      expect(await outcome(issueInvoice(employee(), draft))).toBe("NOT_FOUND");
      expect(await outcome(ensureInvoicePdf(employee(), issued))).toBe("NOT_FOUND");
      expect(await outcome(invoicePdfUrl(employee(), issued))).toBe("NOT_FOUND");
      expect((await f.platform.invoice.findUniqueOrThrow({ where: { id: draft } })).status).toBe("DRAFT");
      // Never vacuous: the same seat issues its own client's draft.
      const own = await draftFor(de, "100", { profile: "EU_REVERSE_CHARGE" });
      expect((await issueInvoice(employee(), own)).number).toBeGreaterThan(0);
    } finally {
      await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId } });
      await f.platform.rolePermission.deleteMany({ where: { tenantId: f.tenantId, source: "TENANT_GRANT" } });
      await f.platform.tenant.update({ where: { id: f.tenantId }, data: { permissionsVersion: { increment: 1 } } });
    }
  });
});

describe("the client's invoice language (C76 (e))", () => {
  it("a value from before it was a choice does not refuse the card's other edits; a new one must be sv or en", async () => {
    await f.platform.client.update({ where: { id: us }, data: { invoiceLocale: "en-US" } });
    try {
      // The card posts every field: the old value comes back with the edit.
      expect(await outcome(updateClient(admin(), us, { city: "Cambridge", invoiceLocale: "en-US" }))).toBe("ok");
      expect(await outcome(updateClient(admin(), us, { invoiceLocale: "de" }))).toBe("INVALID_INPUT");
      expect(await outcome(updateClient(admin(), us, { invoiceLocale: "sv" }))).toBe("ok");
      expect((await f.platform.client.findUniqueOrThrow({ where: { id: us } })).invoiceLocale).toBe("sv");
    } finally {
      await f.platform.client.update({ where: { id: us }, data: { invoiceLocale: null, city: "Boston" } });
    }
  });
});

describe("the guard's census", () => {
  // The worry this pins: a BEFORE trigger firing AFTER `invoice_guard` (same
  // timing fires in name order) that returned NULL would skip the row's write
  // after the guard had taken a number — a gap in the series. Slice 110's
  // `invoice_billed_hours_guard` sorts BEFORE it ('b' < 'g'), only ever raises
  // or returns NEW, and so can refuse an issue but never burn a number. Since
  // slice 110b it also WRITES `NEW.hours_page` as the invoice leaves DRAFT —
  // still before the number is taken, and still never NULL. Slice 111's
  // `invoice_book_rate_guard` ('bo') sorts between them: it raises, or writes
  // a credit note's booking rate, and always returns NEW.
  it("invoice_guard is the LAST BEFORE trigger on invoice (a later one returning NULL would burn a number)", async () => {
    const rows = await f.platform.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
       WHERE tgrelid = 'invoice'::regclass AND NOT tgisinternal AND (tgtype & 2) = 2
       ORDER BY tgname`;
    expect(rows.map((r) => r.tgname)).toEqual(["invoice_billed_hours_guard", "invoice_book_rate_guard", "invoice_guard"]);
  });
});
