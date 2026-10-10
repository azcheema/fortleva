import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { todayIn } from "@/lib/due-date";
import { addDays } from "@/lib/week";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";

import { bookYearEnd, createExport, exportFile, readBookkeeping, readNewestYearEnd, readYearEndReminder, updateBookkeepingSettings } from "./bookkeeping";
import { createCreditDraft, creditInFull } from "./credit";
import { addLine, createDraft, removeLine, setDraftVatProfile, updateDraftDetails, updateLine } from "./drafts";
import { LIST_COLUMNS, LIST_EVENTS, type ListWords } from "./invoice-list";
import { issueInvoice } from "./issue";
import { divRoundHalfAway, readFixed } from "./money";
import { markInvoicePaid, markInvoiceUnpaid } from "./send";
import { updateCompanyDetails, updatePaymentDetails } from "./seller";
import { setFirstInvoiceNumber } from "./series";
import { decodeCp437 } from "./sie";
import { VAT_PROFILES } from "./vat";

/**
 * THE BOOKKEEPING FILE — against the real database and the real
 * `app_runtime` role (Phase 4 slice 111; founder decision C82; migration
 * 20261010230000_invoice_bookkeeping_export; the design's §10):
 *   - the DATABASE's rules on their own (raw writes): the booking rate at
 *     issue and frozen after; a file only by a holder of `invoice:export`,
 *     numbered by the database, of one method per workspace; an entry only in
 *     its file's own transaction, for an issued document, once, dated as its
 *     event says, a voucher that balances;
 *   - the INVOICE method (one workspace): each invoice and credit note once,
 *     on its date; nothing new → refused; two makers at once never share an
 *     invoice; the SIE and the list regenerate identically; who may;
 *   - the CASH method (a second workspace): a payment on its day less the
 *     credit notes before it, a reversal when it is unmarked, a re-mark on
 *     another day after it; credit notes listed with what they mean; and the
 *     year cut that must never stall (the re-check's 1).
 *
 * Tenant slug prefixes `bkx-` and `bkxc-` are registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

vi.setConfig({ testTimeout: 120_000 });

type Fixture = Awaited<ReturnType<typeof setupTenant>>;

let inv: Fixture; // the INVOICE method's workspace
let cash: Fixture; // the CASH method's workspace
const clients: Record<string, { se: string; us: string }> = {};
const run = randomUUID().slice(0, 8);
/** Users a test made beyond the fixture's (global rows: deleted after the tenants). */
const extraUserIds: string[] = [];

const ctxOf = (f: Fixture, memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });
const owner = (f: Fixture) => ctxOf(f, f.seats.owner.memberId);
const admin = (f: Fixture) => ctxOf(f, f.seats.admin.memberId);
const manager = (f: Fixture) => ctxOf(f, f.seats.manager.memberId);

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

const TOKENS = [
  "INVOICE_EXPORT_LOCK",
  "INVOICE_BOOK_RATE_GUARD",
  "INVOICE_EXPORT_ENTRY_GUARD",
  "INVOICE_EXPORT_GUARD",
  "INVOICE_NOT_DRAFT",
  "invoice_export_entry_issue_once",
  // Slice 111b — the year end's constraints (none of these names holds another).
  "invoice_export_year_end_cash",
  "invoice_export_year_end_passed",
  "invoice_export_year_end_month_end",
  "invoice_export_year_end_once",
  "invoice_book_rate_when",
  "invoice_book_rate_pair",
  "permission denied",
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

const asMember = <T>(f: Fixture, memberId: string, fn: (tx: TenantDb) => Promise<T>) => withTenant(f.tenantId, { type: "member", id: memberId }, fn);

/** An issued invoice: lines of [price, VAT rate %], in a currency, under a treatment. */
async function issued(
  f: Fixture,
  clientId: string,
  lines: readonly (readonly [string, string])[],
  opts: { readonly currency?: string; readonly profile?: "SE_DOMESTIC" | "EU_REVERSE_CHARGE" | "OUTSIDE_SCOPE" } = {},
): Promise<string> {
  const id = await createDraft(manager(f), { clientId });
  if (opts.profile && opts.profile !== "SE_DOMESTIC") await setDraftVatProfile(manager(f), id, opts.profile);
  await updateDraftDetails(manager(f), id, { currency: opts.currency ?? "SEK" });
  for (const [price, rate] of lines) {
    const line = await addLine(manager(f), id, { description: `Work at ${price}` });
    await updateLine(manager(f), id, line, { unitPrice: price, ...(opts.profile && opts.profile !== "SE_DOMESTIC" ? {} : { vatRate: rate }) });
  }
  await issueInvoice(admin(f), id);
  return id;
}

/** A part credit note of an issued invoice: its first line lowered to `price`. */
async function partCredit(f: Fixture, invoiceId: string, price: string): Promise<string> {
  const cn = await createCreditDraft(admin(f), invoiceId, { reason: "Discount agreed" });
  const lines = await f.platform.invoiceLine.findMany({ where: { invoiceId: cn }, orderBy: { position: "asc" } });
  await updateLine(admin(f), cn, lines[0]!.id, { unitPrice: price });
  for (const l of lines.slice(1)) await removeLine(admin(f), cn, l.id);
  await issueInvoice(admin(f), cn);
  return cn;
}

const today = async (f: Fixture): Promise<string> => {
  const prefs = await f.platform.tenantPreference.findFirst({ where: { tenantId: f.tenantId, key: "timezone" } });
  return todayIn(typeof prefs?.value === "string" ? prefs.value : "Europe/Stockholm", new Date());
};

const entriesOf = (f: Fixture, exportId: string) =>
  f.platform.invoiceExportEntry.findMany({ where: { tenantId: f.tenantId, exportId }, orderBy: { position: "asc" } });

/** A stored voucher's rows as "account amount", signs pinned (the review's L6). */
const rowsOf = (voucher: unknown): string[] =>
  ((voucher as { rows?: { account: string; amount: string }[] } | null)?.rows ?? []).map((r) => `${r.account} ${r.amount}`);

const WORDS: ListWords & { readonly sheet: string } = {
  sheet: "Bookkeeping",
  headers: Object.fromEntries(LIST_COLUMNS.map((c) => [c, c])) as ListWords["headers"],
  events: Object.fromEntries(LIST_EVENTS.map((e) => [e, e])) as ListWords["events"],
  invoice: "Invoice",
  creditNote: "Credit note",
  treatments: Object.fromEntries(VAT_PROFILES.map((p) => [p, p])) as ListWords["treatments"],
  remark: (r) => (r.file === undefined ? r.kind : `${r.kind} ${r.day} #${r.file}`),
};

async function ready(f: Fixture, label: string, firstNumber: string): Promise<void> {
  const se = randomUUID();
  const us = randomUUID();
  clients[f.tenantId] = { se, us };
  await f.platform.client.createMany({
    data: [
      { id: se, tenantId: f.tenantId, name: `Åkesson Bygg ${label}`, orgNr: "556677-8899", addressLine1: "Gatan 1", postalCode: "111 22", city: "Stockholm", countryCode: "SE" },
      { id: us, tenantId: f.tenantId, name: `Globex ${label} Inc`, addressLine1: "1 Main St", city: "Springfield", countryCode: "US" },
    ],
  });
  await updateCompanyDetails(owner(f), {
    legalName: `Bokföring ${label} AB`,
    orgNr: "556016-0680",
    vatNumber: "SE556016068001",
    seat: "Stockholm",
    fSkattApproved: true,
    addressLine1: "Storgatan 1",
    postalCode: "111 22",
    city: "Stockholm",
    countryCode: "SE",
  });
  await updatePaymentDetails(owner(f), { bankgiro: "5050-1055" });
  await setFirstInvoiceNumber(owner(f), firstNumber);
}

beforeAll(async () => {
  inv = await setupTenant("bkx");
  cash = await setupTenant("bkxc");
  await ready(inv, `I${run}`, "9001");
  await ready(cash, `C${run}`, "8001");
}, 180_000);

afterAll(async () => {
  for (const f of [inv, cash]) {
    if (!f) continue;
    await f.deleteInvoices();
    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
    await f.cleanup();
  }
  if (extraUserIds.length > 0) await inv.platform.user.deleteMany({ where: { id: { in: extraUserIds } } });
}, 180_000);

describe("the booking rate (C82 (d), (f)) — the database's rules", () => {
  it("is the ECB's rate on the invoice date for an invoice in another currency without VAT, none for SEK", async () => {
    const { se, us } = clients[inv.tenantId]!;
    const usd = await issued(inv, us, [["1000", "0"]], { currency: "USD", profile: "OUTSIDE_SCOPE" });
    const sek = await issued(inv, se, [["1000", "25"]]);
    const u = await inv.platform.invoice.findUniqueOrThrow({ where: { id: usd } });
    const s = await inv.platform.invoice.findUniqueOrThrow({ where: { id: sek } });
    expect(u.bookRateToSek).not.toBeNull();
    expect(u.fxRateToSek).toBeNull();
    expect(u.bookRateDate!.getTime()).toBeLessThanOrEqual(u.issueDate!.getTime());
    expect(s.bookRateToSek).toBeNull();
    expect(s.bookRateDate).toBeNull();
  });

  it("is the VAT's own rate on an invoice in another currency carrying Swedish VAT", async () => {
    const { se } = clients[inv.tenantId]!;
    const eur = await issued(inv, se, [["1000", "25"]], { currency: "EUR" });
    const r = await inv.platform.invoice.findUniqueOrThrow({ where: { id: eur } });
    expect(r.fxRateToSek).not.toBeNull();
    expect(r.bookRateToSek?.toFixed(6)).toBe(r.fxRateToSek?.toFixed(6));
    expect(r.bookRateDate?.getTime()).toBe(r.fxRateDate?.getTime());
  });

  it("is the original's on a credit note, and frozen once issued; a draft never holds one", async () => {
    const { us } = clients[inv.tenantId]!;
    const usd = await issued(inv, us, [["400", "0"]], { currency: "USD", profile: "OUTSIDE_SCOPE" });
    const credited = await creditInFull(admin(inv), usd, { reason: "Wrong client", correctedCopy: false });
    const o = await inv.platform.invoice.findUniqueOrThrow({ where: { id: usd } });
    const c = await inv.platform.invoice.findUniqueOrThrow({ where: { id: credited.creditNoteId } });
    expect(c.bookRateToSek?.toFixed(6)).toBe(o.bookRateToSek?.toFixed(6));
    expect(c.bookRateDate?.getTime()).toBe(o.bookRateDate?.getTime());
    const admins = inv.seats.admin.memberId;
    expect(await refusal(asMember(inv, admins, (tx) => tx.$executeRaw`UPDATE invoice SET book_rate_to_sek = 1 WHERE id = ${usd}`))).toBe("INVOICE_NOT_DRAFT");
    const draft = await createDraft(manager(inv), { clientId: us });
    expect(
      await refusal(asMember(inv, admins, (tx) => tx.$executeRaw`UPDATE invoice SET book_rate_to_sek = 10, book_rate_date = CURRENT_DATE WHERE id = ${draft}`)),
    ).toBe("invoice_book_rate_when");
    await inv.platform.invoice.delete({ where: { id: draft } });
  });
});

describe("a file — the database's rules (raw writes)", () => {
  const insertExport = (f: Fixture, memberId: string, method: "INVOICE" | "CASH", number = 1) =>
    asMember(f, memberId, (tx) =>
      tx.$queryRaw<{ id: string; number: number }[]>`
        INSERT INTO invoice_export (id, tenant_id, number, method, series, made_on, created_by_member_id)
        VALUES (${randomUUID()}, ${f.tenantId}, ${number}, ${method}::invoice_export_method, 'F', CURRENT_DATE, ${memberId})
        RETURNING id, number`,
    );

  it("is made only by a member who may export, numbered by the database, one method per workspace, never changed", async () => {
    const raw = await setupTenant("bkx");
    try {
      await updateBookkeepingSettings(ctxOf(raw, raw.seats.owner.memberId), { method: "INVOICE" });
      expect(await refusal(insertExport(raw, raw.seats.manager.memberId, "INVOICE"))).toBe("INVOICE_EXPORT_GUARD");
      const first = await insertExport(raw, raw.seats.admin.memberId, "INVOICE", 99);
      expect(first[0]!.number).toBe(1);
      const second = await insertExport(raw, raw.seats.admin.memberId, "INVOICE", 1);
      expect(second[0]!.number).toBe(2);
      expect(await refusal(insertExport(raw, raw.seats.admin.memberId, "CASH"))).toBe("INVOICE_EXPORT_GUARD");
      const admins = raw.seats.admin.memberId;
      expect(await refusal(asMember(raw, admins, (tx) => tx.$executeRaw`UPDATE invoice_export SET series = 'X' WHERE id = ${first[0]!.id}`))).toBe(
        "permission denied",
      );
      expect(await refusal(asMember(raw, admins, (tx) => tx.$executeRaw`DELETE FROM invoice_export WHERE id = ${first[0]!.id}`))).toBe("permission denied");
    } finally {
      await raw.platform.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.invoice_maintenance', 'on', true)`;
        await tx.invoiceExportEntry.deleteMany({ where: { tenantId: raw.tenantId } });
        await tx.invoiceExport.deleteMany({ where: { tenantId: raw.tenantId } });
      });
      await raw.platform.tenantPreference.deleteMany({ where: { tenantId: raw.tenantId } });
      await raw.cleanup();
    }
  });

  it("an entry: only in its file's own transaction, for an issued document, once, balancing, dated as its event says", async () => {
    const { se } = clients[inv.tenantId]!;
    await updateBookkeepingSettings(owner(inv), { method: "INVOICE" });
    const doc = await issued(inv, se, [["100", "25"]]);
    const draft = await createDraft(manager(inv), { clientId: se });
    const admins = inv.seats.admin.memberId;
    const row = await inv.platform.invoice.findUniqueOrThrow({ where: { id: doc } });
    const day = row.issueDate!.toISOString().slice(0, 10);
    const good = { text: "Faktura x", rows: [{ account: "1510", amount: "125.00" }, { account: "3001", amount: "-100.00" }, { account: "2611", amount: "-25.00" }] };
    const entry = (tx: TenantDb, exportId: string, invoiceId: string, voucher: unknown, bookedOn = day) =>
      tx.$executeRaw`INSERT INTO invoice_export_entry (id, tenant_id, export_id, invoice_id, position, event, booked_on, voucher, detail)
                     VALUES (${randomUUID()}, ${inv.tenantId}, ${exportId}, ${invoiceId}, 1, 'ISSUE', ${bookedOn}::date, ${JSON.stringify(voucher)}::jsonb, '{}'::jsonb)`;
    const inFreshFile = (fn: (tx: TenantDb, exportId: string) => Promise<unknown>) =>
      asMember(inv, admins, async (tx) => {
        const made = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO invoice_export (id, tenant_id, number, method, series, made_on, created_by_member_id)
          VALUES (${randomUUID()}, ${inv.tenantId}, 1, 'INVOICE', 'F', CURRENT_DATE, ${admins}) RETURNING id`;
        await fn(tx, made[0]!.id);
        // Never commit a raw file: the services' tests own the numbering.
        throw new Error("ROLLBACK_OK");
      });
    const rolled = async (p: Promise<unknown>) => {
      const r = await refusal(p);
      return r.startsWith("unexpected") && r.includes("ROLLBACK_OK") ? "ok" : r;
    };
    expect(await rolled(inFreshFile((tx, id) => entry(tx, id, doc, good)))).toBe("ok");
    expect(await rolled(inFreshFile((tx, id) => entry(tx, id, draft, good)))).toBe("INVOICE_EXPORT_ENTRY_GUARD");
    expect(await rolled(inFreshFile((tx, id) => entry(tx, id, doc, { ...good, rows: good.rows.slice(1) })))).toBe("INVOICE_EXPORT_ENTRY_GUARD");
    expect(await rolled(inFreshFile((tx, id) => entry(tx, id, doc, { ...good, text: "x".repeat(51) })))).toBe("INVOICE_EXPORT_ENTRY_GUARD");
    expect(await rolled(inFreshFile((tx, id) => entry(tx, id, doc, good, "2020-01-01")))).toBe("INVOICE_EXPORT_ENTRY_GUARD");
    expect(await rolled(inFreshFile(async (tx, id) => {
      await entry(tx, id, doc, good);
      await tx.$executeRaw`INSERT INTO invoice_export_entry (id, tenant_id, export_id, invoice_id, position, event, booked_on, detail)
                           VALUES (${randomUUID()}, ${inv.tenantId}, ${id}, ${doc}, 2, 'ISSUE', ${day}::date, '{}'::jsonb)`;
    }))).toBe("invoice_export_entry_issue_once");
    // An event of the other method.
    expect(
      await rolled(
        inFreshFile((tx, id) =>
          tx.$executeRaw`INSERT INTO invoice_export_entry (id, tenant_id, export_id, invoice_id, position, event, booked_on, detail)
                         VALUES (${randomUUID()}, ${inv.tenantId}, ${id}, ${doc}, 1, 'CREDIT_NOTED', ${day}::date, '{}'::jsonb)`,
        ),
      ),
    ).toBe("INVOICE_EXPORT_ENTRY_GUARD");
    await inv.platform.invoice.delete({ where: { id: draft } });
  });
});

describe("the INVOICE method", () => {
  it("books each invoice and credit note once, on its date — and nothing new is refused", async () => {
    await updateBookkeepingSettings(owner(inv), { method: "INVOICE" });
    expect(await outcome(createExport(manager(inv)))).toBe("FORBIDDEN");
    const first = await createExport(admin(inv));
    expect(first.number).toBe(1);
    const entries = await entriesOf(inv, first.id);
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries.map((e) => e.invoiceId)).size).toBe(entries.length);
    expect(entries.every((e) => e.event === "ISSUE")).toBe(true);
    for (const e of entries) {
      const doc = await inv.platform.invoice.findUniqueOrThrow({ where: { id: e.invoiceId } });
      expect(e.bookedOn.getTime()).toBe(doc.issueDate!.getTime());
      if (e.voucher === null) continue;
      const rows = rowsOf(e.voucher);
      const sum = rows.reduce((s, r) => s + readFixed(r.split(" ")[1]!, 2), 0n);
      expect(sum).toBe(0n);
      const receivable = readFixed(rows.find((r) => r.startsWith("1510 "))!.split(" ")[1]!, 2);
      expect(doc.kind === "INVOICE" ? receivable > 0n : receivable < 0n).toBe(true);
    }
    expect(await outcome(createExport(admin(inv)))).toBe("INVOICE_EXPORT_EMPTY");
  });

  it("books a Swedish invoice at two rates exactly, and a US one at its booking rate", async () => {
    const { se, us } = clients[inv.tenantId]!;
    const sek = await issued(inv, se, [["1000", "25"], ["500", "12"]]);
    const usd = await issued(inv, us, [["1234.56", "0"]], { currency: "USD", profile: "OUTSIDE_SCOPE" });
    const made = await createExport(admin(inv));
    const entries = await entriesOf(inv, made.id);
    const of = (id: string) => entries.find((e) => e.invoiceId === id)!;
    const sekNo = (await inv.platform.invoice.findUniqueOrThrow({ where: { id: sek } })).displayNumber;
    expect((of(sek).voucher as { text: string }).text).toBe(`Faktura ${sekNo} Åkesson Bygg I${run}`);
    expect(rowsOf(of(sek).voucher)).toEqual(["1510 1810.00", "3001 -1000.00", "3002 -500.00", "2611 -250.00", "2621 -60.00"]);
    const rate = readFixed((await inv.platform.invoice.findUniqueOrThrow({ where: { id: usd } })).bookRateToSek!, 6);
    const kronor = divRoundHalfAway(123_456n * rate, 1_000_000n);
    const amount = `${kronor / 100n}.${String(kronor % 100n).padStart(2, "0")}`;
    expect(rowsOf(of(usd).voucher)).toEqual([`1510 ${amount}`, `3305 -${amount}`]);
  });

  it("two makers at once never put one invoice in two files", async () => {
    const { se } = clients[inv.tenantId]!;
    await issued(inv, se, [["10", "25"]]);
    await issued(inv, se, [["20", "25"]]);
    const results = await Promise.all([outcome(createExport(admin(inv))), outcome(createExport(owner(inv)))]);
    expect(results.sort()).toEqual(["INVOICE_EXPORT_EMPTY", "ok"]);
    const all = await inv.platform.invoiceExportEntry.findMany({ where: { tenantId: inv.tenantId } });
    expect(new Set(all.map((e) => e.invoiceId)).size).toBe(all.length);
  });

  it("regenerates the same bytes on every download, and audits each with their hash", async () => {
    const files = await inv.platform.invoiceExport.findMany({ where: { tenantId: inv.tenantId }, orderBy: { number: "asc" } });
    const id = files[0]!.id;
    const a = await exportFile(admin(inv), id, "sie", WORDS);
    const b = await exportFile(owner(inv), id, "sie", WORDS);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    const text = decodeCp437(a.bytes);
    expect(text.startsWith("#FLAGGA 0\r\n#PROGRAM \"Fortleva\" 1.0\r\n#FORMAT PC8\r\n")).toBe(true);
    expect(text).toContain(`#FNAMN "Bokföring I${run} AB"`);
    expect(text).toContain("#ORGNR 556016-0680");
    expect(text).toContain('#VER "F" "" ');
    const x1 = await exportFile(admin(inv), id, "xlsx", WORDS);
    const x2 = await exportFile(admin(inv), id, "xlsx", WORDS);
    expect(Buffer.from(x1.bytes).equals(Buffer.from(x2.bytes))).toBe(true);
    expect(x1.fileName).toBe(`fortleva-fakturor-${files[0]!.number}.xlsx`);
    const audits = await inv.platform.auditEvent.findMany({ where: { tenantId: inv.tenantId, action: "invoice_export.downloaded", targetId: id } });
    expect(audits).toHaveLength(4);
    const sha = createHash("sha256").update(a.bytes).digest("hex");
    expect(audits.filter((r) => (r.metadata as { sha256?: string }).sha256 === sha)).toHaveLength(2);
    expect(await outcome(exportFile(manager(inv), id, "sie", WORDS))).toBe("FORBIDDEN");
  });

  it("fixes the method once a file exists", async () => {
    expect(await outcome(updateBookkeepingSettings(owner(inv), { method: "CASH" }))).toBe("INVOICE_EXPORT_METHOD_FIXED");
    expect(await updateBookkeepingSettings(owner(inv), { salesSe25: "3041" })).toEqual(["salesSe25"]);
    expect(await outcome(updateBookkeepingSettings(owner(inv), { salesSe25: "1510" }))).toBe("INVALID_INPUT");
    expect(await updateBookkeepingSettings(owner(inv), { salesSe25: "" })).toEqual(["salesSe25"]);
  });
});

describe("the CASH method (C82 (e))", () => {
  it("asks for a method first", async () => {
    expect(await outcome(createExport(admin(cash)))).toBe("INVOICE_EXPORT_NO_METHOD");
    expect((await readBookkeeping(admin(cash))).next).toBeNull();
    await updateBookkeepingSettings(owner(cash), { method: "CASH" });
  });

  it("books a payment on its day to the bank, less the credit note before it; lists each credit note with what it means", async () => {
    const { se } = clients[cash.tenantId]!;
    const day = await today(cash);
    const paid = await issued(cash, se, [["1000", "25"], ["500", "12"]]);
    const before = await partCredit(cash, paid, "400"); // credits 25 % × 400 — before the payment
    await markInvoicePaid(admin(cash), paid, { paidOn: day, note: null });
    const unpaid = await issued(cash, se, [["300", "25"]]);
    const unpaidCredit = await partCredit(cash, unpaid, "100");
    const never = await issued(cash, se, [["200", "25"]]);
    const neverCredit = (await creditInFull(admin(cash), never, { reason: "Cancelled", correctedCopy: false })).creditNoteId;

    const made = await createExport(admin(cash));
    const entries = await entriesOf(cash, made.id);
    const payment = entries.find((e) => e.invoiceId === paid && e.event === "PAYMENT")!;
    expect(payment.bookedOn.toISOString().slice(0, 10)).toBe(day);
    expect(rowsOf(payment.voucher)).toEqual(["1930 1310.00", "3001 -600.00", "3002 -500.00", "2611 -150.00", "2621 -60.00"]);
    expect((payment.detail as { deductedIds: string[] }).deductedIds).toEqual([before]);
    const remark = (id: string) => (entries.find((e) => e.invoiceId === id && e.event === "CREDIT_NOTED")!.detail as { remark: { kind: string } }).remark.kind;
    expect(remark(before)).toBe("deducted");
    expect(remark(unpaidCredit)).toBe("unpaid");
    expect(remark(neverCredit)).toBe("creditedUnpaid");
    expect(entries.filter((e) => e.event === "CREDIT_NOTED").every((e) => e.voucher === null)).toBe(true);
    // A credit note after the payment: a refund, never deducted retroactively.
    const after = await partCredit(cash, paid, "50");
    const next = await createExport(admin(cash));
    const noted = (await entriesOf(cash, next.id)).find((e) => e.invoiceId === after)!;
    expect((noted.detail as { remark: { kind: string; file: number } }).remark).toMatchObject({ kind: "afterPayment", file: made.number });
  });

  it("reverses a payment marked as unpaid after its file, then books the re-mark on its new day — the reversal first", async () => {
    const { se } = clients[cash.tenantId]!;
    const day = await today(cash);
    const id = await issued(cash, se, [["800", "25"]]);
    await markInvoicePaid(admin(cash), id, { paidOn: day, note: null });
    const first = await createExport(admin(cash));
    const booked = (await entriesOf(cash, first.id)).find((e) => e.invoiceId === id)!;
    await markInvoiceUnpaid(admin(cash), id);
    await markInvoicePaid(admin(cash), id, { paidOn: addDays(day, -1), note: null });
    const second = await createExport(admin(cash));
    const entries = (await entriesOf(cash, second.id)).filter((e) => e.invoiceId === id);
    expect(entries.map((e) => e.event)).toEqual(["PAYMENT_UNDONE", "PAYMENT"]);
    expect(entries[0]!.bookedOn.toISOString().slice(0, 10)).toBe(day);
    expect(rowsOf(entries[0]!.voucher)).toEqual(rowsOf(booked.voucher).map((r) => {
      const [account, amount] = r.split(" ");
      return `${account} ${amount!.startsWith("-") ? amount!.slice(1) : `-${amount}`}`;
    }));
    expect(entries[1]!.bookedOn.toISOString().slice(0, 10)).toBe(addDays(day, -1));
    // Undone and re-marked on the SAME day: nothing new.
    await markInvoiceUnpaid(admin(cash), id);
    await markInvoicePaid(admin(cash), id, { paidOn: addDays(day, -1), note: null });
    expect(await outcome(createExport(admin(cash)))).toBe("INVOICE_EXPORT_EMPTY");
  });

  it("never stalls at the year's turn: a payment waiting on its reversal never decides the year (the re-check's 1)", async () => {
    const { se } = clients[cash.tenantId]!;
    const day = await today(cash);
    // The financial year starts this month, so the last day of last month is last year.
    const month = Number(day.slice(5, 7));
    await updateBookkeepingSettings(owner(cash), { yearStart: String(month) });
    const lastYear = addDays(`${day.slice(0, 7)}-01`, -1);
    // X paid this year and filed, then its day corrected into last year: its
    // reversal is this year's (the file's day), its re-mark last year's.
    const x = await issued(cash, se, [["100", "25"]]);
    await markInvoicePaid(admin(cash), x, { paidOn: day, note: null });
    await createExport(admin(cash)); // X's payment, this year
    await markInvoiceUnpaid(admin(cash), x);
    await markInvoicePaid(admin(cash), x, { paidOn: lastYear, note: null });
    const y = await issued(cash, se, [["200", "25"]]);
    await markInvoicePaid(admin(cash), y, { paidOn: lastYear, note: null });
    const events = async () => {
      const made = await createExport(admin(cash));
      return (await entriesOf(cash, made.id)).map((e) => `${e.event}:${e.invoiceId === x ? "x" : e.invoiceId === y ? "y" : "?"}`);
    };
    expect(await events()).toEqual(["PAYMENT:y"]); // last year's fileable payment first
    expect(await events()).toEqual(["PAYMENT_UNDONE:x"]); // this year: the reversal alone
    expect(await events()).toEqual(["PAYMENT:x"]); // then last year's re-mark
    expect(await outcome(createExport(admin(cash)))).toBe("INVOICE_EXPORT_EMPTY");
    await updateBookkeepingSettings(owner(cash), { yearStart: "1" });
  });

  it("keeps a payment's day corrected inside an ended year in that year — its reversal and the re-mark in one file (slice 111b, the review's M3)", async () => {
    const { se } = clients[cash.tenantId]!;
    const day = await today(cash);
    // The financial year starts this month, so last month's last day is last year — ended.
    await updateBookkeepingSettings(owner(cash), { yearStart: String(Number(day.slice(5, 7))) });
    const lastYear = addDays(`${day.slice(0, 7)}-01`, -1);
    const z = await issued(cash, se, [["300", "25"]]);
    await markInvoicePaid(admin(cash), z, { paidOn: lastYear, note: null });
    await createExport(admin(cash)); // Z's payment, last year
    await markInvoiceUnpaid(admin(cash), z);
    await markInvoicePaid(admin(cash), z, { paidOn: addDays(lastYear, -1), note: null });
    const made = await createExport(admin(cash));
    const entries = (await entriesOf(cash, made.id)).filter((e) => e.invoiceId === z);
    // The reversal first, dated the later day's month end — last month's last day, last year — then the re-mark.
    expect(entries.map((e) => e.event)).toEqual(["PAYMENT_UNDONE", "PAYMENT"]);
    expect(entries[0]!.bookedOn.toISOString().slice(0, 10)).toBe(lastYear);
    expect(entries[1]!.bookedOn.toISOString().slice(0, 10)).toBe(addDays(lastYear, -1));
    expect(await outcome(createExport(admin(cash)))).toBe("INVOICE_EXPORT_EMPTY");
    await updateBookkeepingSettings(owner(cash), { yearStart: "1" });
  });
});

describe("the year end — nothing due, and what the database refuses without a past date (slice 111b; C83)", () => {
  // Every invoice here is issued today, so no year end is ever due and none
  // can hold one; `year-end.dbtest.ts` (CI only) plants past dates for the rest.
  /** The last day of the month before last — always over a day before today, as a year-end file needs. */
  const pastMonthEnd = (day: string) => addDays(`${addDays(`${day.slice(0, 7)}-01`, -1).slice(0, 7)}-01`, -1);
  const thisMonthEnd = (day: string) => {
    const [y, m] = day.split("-").map(Number);
    return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
  };
  /** Dated the WORKSPACE's day, as the services date a file — never the database's UTC date (the fix pass's low: they differ for an hour or two each night). */
  const insertFile = (tx: TenantDb, f: Fixture, method: "INVOICE" | "CASH", yearEnd: string | null, madeOn: string) =>
    tx.$queryRaw<{ id: string }[]>`
      INSERT INTO invoice_export (id, tenant_id, number, method, series, made_on, year_end, created_by_member_id)
      VALUES (${randomUUID()}, ${f.tenantId}, 1, ${method}::invoice_export_method, 'F', ${madeOn}::date, ${yearEnd}::date, ${f.seats.admin.memberId})
      RETURNING id`;
  /** A raw file (a year end's when `yearEnd` is set) and `fn` in it — always rolled back. */
  const inFile = async (f: Fixture, method: "INVOICE" | "CASH", yearEnd: string | null, fn: (tx: TenantDb, exportId: string) => Promise<unknown> = async () => {}) => {
    const madeOn = await today(f);
    return asMember(f, f.seats.admin.memberId, async (tx) => {
      const made = await insertFile(tx, f, method, yearEnd, madeOn);
      await fn(tx, made[0]!.id);
      throw new Error("ROLLBACK_OK");
    });
  };
  const rolled = async (p: Promise<unknown>) => {
    const r = await refusal(p);
    return r.startsWith("unexpected") && r.includes("ROLLBACK_OK") ? "ok" : r;
  };
  const entry = (tx: TenantDb, exportId: string, invoiceId: string, event: string, bookedOn: string, yearEnd: string | null, voucher: unknown) =>
    tx.$executeRaw`INSERT INTO invoice_export_entry (id, tenant_id, export_id, invoice_id, position, event, booked_on, year_end, voucher, detail)
                   VALUES (${randomUUID()}, ${cash.tenantId}, ${exportId}, ${invoiceId}, 1, ${event}::invoice_export_event, ${bookedOn}::date,
                           ${yearEnd}::date, ${voucher === null ? null : JSON.stringify(voucher)}::jsonb, '{}'::jsonb)`;
  const voucher = { text: "Bokslut obetald faktura x", rows: [{ account: "1510", amount: "125.00" }, { account: "3001", amount: "-100.00" }, { account: "2611", amount: "-25.00" }] };
  const negated = { text: "Återföring bokslut faktura x", rows: voucher.rows.map((r) => ({ account: r.account, amount: r.amount.startsWith("-") ? r.amount.slice(1) : `-${r.amount}` })) };
  const fingerprint = { count: 0, totalSek: "0.00" };

  it("is never due while every invoice is of the current year; asked for anyway, refused", async () => {
    const page = await readBookkeeping(admin(cash));
    expect(page.method).toBe("CASH");
    expect(page.yearEnd).toBeNull();
    expect(page.next?.intoBookedYear ?? null).toBeNull();
    expect(page.files.every((f) => f.yearEnd === null)).toBe(true);
    expect(await readYearEndReminder(admin(cash))).toBeNull();
    expect(await readNewestYearEnd(admin(cash))).toBeNull();
    const end = pastMonthEnd(await today(cash));
    expect(await outcome(bookYearEnd(admin(cash), { yearEnd: end, ...fingerprint }))).toBe("INVOICE_YEAR_END_NOT_DUE");
    expect(await outcome(bookYearEnd(admin(cash), { yearEnd: "31 December", ...fingerprint }))).toBe("INVALID_INPUT");
    expect(await outcome(bookYearEnd(admin(cash), { yearEnd: end, count: -1, totalSek: "0.00" }))).toBe("INVALID_INPUT");
    expect(await outcome(bookYearEnd(manager(cash), { yearEnd: end, ...fingerprint }))).toBe("FORBIDDEN");
    // The invoice method has no year end at all.
    expect((await readBookkeeping(admin(inv))).yearEnd).toBeNull();
    expect(await readYearEndReminder(admin(inv))).toBeNull();
  });

  it("a year-end file: the cash method's only, from the second day after it, on a month's last day, in order", async () => {
    const day = await today(cash);
    const end = pastMonthEnd(day);
    expect(await rolled(inFile(cash, "CASH", end))).toBe("ok");
    expect(await rolled(inFile(inv, "INVOICE", pastMonthEnd(await today(inv))))).toBe("invoice_export_year_end_cash");
    expect(await rolled(inFile(cash, "CASH", thisMonthEnd(day)))).toBe("invoice_export_year_end_passed");
    expect(await rolled(inFile(cash, "CASH", addDays(end, -1)))).toBe("invoice_export_year_end_month_end");
    // A second for the same year, and an older one after a newer: the guard (before the unique index).
    expect(await rolled(inFile(cash, "CASH", end, (tx) => insertFile(tx, cash, "CASH", end, day)))).toBe("INVOICE_EXPORT_GUARD");
    const older = pastMonthEnd(end);
    expect(await rolled(inFile(cash, "CASH", end, (tx) => insertFile(tx, cash, "CASH", older, day)))).toBe("INVOICE_EXPORT_GUARD");
  });

  it("a year end's entries: only in its own file, nothing else there, only for an invoice issued by then, never without one to negate", async () => {
    const { se } = clients[cash.tenantId]!;
    const doc = await issued(cash, se, [["100", "25"]]);
    const end = pastMonthEnd(await today(cash));
    const after = addDays(end, 1);
    // A year end in a regular file, and a payment in a year-end file.
    expect(await rolled(inFile(cash, "CASH", null, (tx, id) => entry(tx, id, doc, "YEAR_END", end, end, voucher)))).toBe("INVOICE_EXPORT_ENTRY_GUARD");
    expect(await rolled(inFile(cash, "CASH", end, (tx, id) => entry(tx, id, doc, "PAYMENT", end, null, voucher)))).toBe("INVOICE_EXPORT_ENTRY_GUARD");
    // Issued today — after the year end.
    expect(await rolled(inFile(cash, "CASH", end, (tx, id) => entry(tx, id, doc, "YEAR_END", end, end, voucher)))).toBe("INVOICE_EXPORT_ENTRY_GUARD");
    // A reversal or a withdrawal of a year end that was never booked.
    expect(await rolled(inFile(cash, "CASH", null, (tx, id) => entry(tx, id, doc, "YEAR_END_REVERSED", after, end, negated)))).toBe("INVOICE_EXPORT_ENTRY_GUARD");
    expect(await rolled(inFile(cash, "CASH", null, (tx, id) => entry(tx, id, doc, "YEAR_END_UNDONE", end, end, negated)))).toBe("INVOICE_EXPORT_ENTRY_GUARD");
    expect(await rolled(inFile(cash, "CASH", null, (tx, id) => entry(tx, id, doc, "YEAR_END_REVERSAL_UNDONE", after, end, voucher)))).toBe("INVOICE_EXPORT_ENTRY_GUARD");
  });

  it("a payment's reversal: on the file's day, or a month's end inside an ended year — never an unmark into a closed one (the re-check's R3)", async () => {
    const { se } = clients[cash.tenantId]!;
    const day = await today(cash);
    const id = await issued(cash, se, [["90", "25"]]);
    await markInvoicePaid(admin(cash), id, { paidOn: day, note: null });
    const first = await createExport(admin(cash));
    const booked = (await entriesOf(cash, first.id)).find((e) => e.invoiceId === id && e.event === "PAYMENT")!;
    await markInvoiceUnpaid(admin(cash), id);
    const undo = { text: "Återförd inbetalning x", rows: rowsOf(booked.voucher).map((r) => {
      const [account, amount] = r.split(" ");
      return { account: account!, amount: amount!.startsWith("-") ? amount!.slice(1) : `-${amount}` };
    }) };
    // Dated before the booked payment's own day — a month's end or not: refused
    // (the month's-end and closed-year branches need a past payment: `year-end.dbtest.ts`).
    expect(await rolled(inFile(cash, "CASH", null, (tx, x) => entry(tx, x, id, "PAYMENT_UNDONE", pastMonthEnd(day), null, undo)))).toBe("INVOICE_EXPORT_ENTRY_GUARD");
    expect(await rolled(inFile(cash, "CASH", null, (tx, x) => entry(tx, x, id, "PAYMENT_UNDONE", addDays(day, -1), null, undo)))).toBe("INVOICE_EXPORT_ENTRY_GUARD");
    // On the file's day: fine.
    expect(await rolled(inFile(cash, "CASH", null, (tx, x) => entry(tx, x, id, "PAYMENT_UNDONE", day, null, undo)))).toBe("ok");
    await markInvoicePaid(admin(cash), id, { paidOn: day, note: null });
  });
});

describe("who may, and what the database refuses whoever asks (the security review's 2, 3)", () => {
  it("a member kept to some clients makes, reads and downloads no file — even holding both codes", async () => {
    const { se } = clients[inv.tenantId]!;
    const userId = randomUUID();
    extraUserIds.push(userId);
    await inv.platform.user.create({ data: { id: userId, name: `bkx-scoped-${run}@test.invalid`, email: `bkx-scoped-${run}@test.invalid` } });
    const member = await inv.platform.member.create({ data: { tenantId: inv.tenantId, userId } });
    const role = await inv.platform.role.create({ data: { tenantId: inv.tenantId, name: `Bookkeeper ${run}` } });
    for (const code of ["invoice:view", "invoice:export"]) {
      const perm = await inv.platform.permission.findFirstOrThrow({ where: { code } });
      await inv.platform.rolePermission.create({ data: { tenantId: inv.tenantId, roleId: role.id, permissionId: perm.id } });
    }
    await inv.platform.memberRole.create({ data: { tenantId: inv.tenantId, memberId: member.id, roleId: role.id } });
    await inv.platform.memberClient.create({ data: { tenantId: inv.tenantId, memberId: member.id, clientId: se } });
    const scoped = ctxOf(inv, member.id);
    const file = await inv.platform.invoiceExport.findFirstOrThrow({ where: { tenantId: inv.tenantId } });
    expect(await outcome(readBookkeeping(scoped))).toBe("FORBIDDEN");
    expect(await outcome(createExport(scoped))).toBe("FORBIDDEN");
    expect(await outcome(exportFile(scoped, file.id, "sie", WORDS))).toBe("FORBIDDEN");
    // Slice 111b: the year end takes the same gates; the reminder stays quiet.
    expect(await outcome(bookYearEnd(scoped, { yearEnd: "2025-12-31", count: 0, totalSek: "0.00" }))).toBe("FORBIDDEN");
    expect(await readYearEndReminder(scoped)).toBeNull();
    // The control (the fix-pass re-check's 2): every client is the ONE thing
    // missing — given it, the same member reads the page and the file.
    const all = await inv.platform.permission.findFirstOrThrow({ where: { code: "client:view_all" } });
    await inv.platform.rolePermission.create({ data: { tenantId: inv.tenantId, roleId: role.id, permissionId: all.id } });
    expect(await outcome(readBookkeeping(scoped))).toBe("ok");
    expect(await outcome(exportFile(scoped, file.id, "sie", WORDS))).toBe("ok");
  });

  it("another workspace's file is not found; its lock is not ours to take", async () => {
    const theirs = await inv.platform.invoiceExport.findFirstOrThrow({ where: { tenantId: inv.tenantId } });
    expect(await outcome(exportFile(admin(cash), theirs.id, "sie", WORDS))).toBe("NOT_FOUND");
    expect(
      await refusal(asMember(cash, cash.seats.admin.memberId, (tx) => tx.$executeRaw`SELECT invoice_export_lock(${inv.tenantId})`)),
    ).toBe("INVOICE_EXPORT_LOCK");
  });

  it("a file never grows after it is made, and is made by its maker as themselves", async () => {
    const { se } = clients[inv.tenantId]!;
    const admins = inv.seats.admin.memberId;
    const old = await inv.platform.invoiceExport.findFirstOrThrow({ where: { tenantId: inv.tenantId }, orderBy: { number: "asc" } });
    const doc = await issued(inv, se, [["70", "25"]]);
    const day = (await inv.platform.invoice.findUniqueOrThrow({ where: { id: doc } })).issueDate!.toISOString().slice(0, 10);
    const voucher = { text: "Faktura x", rows: [{ account: "1510", amount: "87.50" }, { account: "3001", amount: "-70.00" }, { account: "2611", amount: "-17.50" }] };
    // An entry into a file committed in an earlier transaction.
    expect(
      await refusal(
        asMember(inv, admins, (tx) =>
          tx.$executeRaw`INSERT INTO invoice_export_entry (id, tenant_id, export_id, invoice_id, position, event, booked_on, voucher, detail)
                         VALUES (${randomUUID()}, ${inv.tenantId}, ${old.id}, ${doc}, 999, 'ISSUE', ${day}::date, ${JSON.stringify(voucher)}::jsonb, '{}'::jsonb)`,
        ),
      ),
    ).toBe("INVOICE_EXPORT_ENTRY_GUARD");
    // A file "made" by someone else.
    expect(
      await refusal(
        asMember(inv, admins, (tx) =>
          tx.$executeRaw`INSERT INTO invoice_export (id, tenant_id, number, method, series, made_on, created_by_member_id)
                         VALUES (${randomUUID()}, ${inv.tenantId}, 1, 'INVOICE', 'F', CURRENT_DATE, ${inv.seats.owner.memberId})`,
        ),
      ),
    ).toBe("INVOICE_EXPORT_GUARD");
  });

  it("the method stays the files' once there is one — whoever asks", async () => {
    expect(await outcome(updateBookkeepingSettings(owner(cash), { method: "INVOICE" }))).toBe("INVOICE_EXPORT_METHOD_FIXED");
    expect(await updateBookkeepingSettings(owner(cash), { method: "CASH" })).toEqual([]);
  });

  it("is decided only by a member who may make files (the fix-pass re-check's 1)", async () => {
    // A custom role with the settings codes and invoice:view — no invoice:export.
    const userId = randomUUID();
    extraUserIds.push(userId);
    await cash.platform.user.create({ data: { id: userId, name: `bkxc-settings-${run}@test.invalid`, email: `bkxc-settings-${run}@test.invalid` } });
    const member = await cash.platform.member.create({ data: { tenantId: cash.tenantId, userId } });
    const role = await cash.platform.role.create({ data: { tenantId: cash.tenantId, name: `Settings only ${run}` } });
    for (const code of ["settings:view", "settings:edit", "invoice:view"]) {
      const perm = await cash.platform.permission.findFirstOrThrow({ where: { code } });
      await cash.platform.rolePermission.create({ data: { tenantId: cash.tenantId, roleId: role.id, permissionId: perm.id } });
    }
    await cash.platform.memberRole.create({ data: { tenantId: cash.tenantId, memberId: member.id, roleId: role.id } });
    const settingsOnly = ctxOf(cash, member.id);
    // Refused for the code — before "the files keep their method" is reached.
    expect(await outcome(updateBookkeepingSettings(settingsOnly, { method: "INVOICE" }))).toBe("FORBIDDEN");
    const stored = await cash.platform.tenantPreference.findFirstOrThrow({ where: { tenantId: cash.tenantId, key: "invoice.bookkeeping" } });
    expect((stored.value as { method?: string }).method).toBe("CASH");
    // The accounts are settings like any other: theirs to change.
    expect(await updateBookkeepingSettings(settingsOnly, { bank: "1940" })).toEqual(["bank"]);
    expect(await updateBookkeepingSettings(settingsOnly, { bank: "" })).toEqual(["bank"]);
    // Slice 111b (its design review's L2): the financial year decides what a
    // file holds and when a year end falls — not theirs, as the method isn't.
    expect(await outcome(updateBookkeepingSettings(settingsOnly, { yearStart: "7" }))).toBe("FORBIDDEN");
  });
});

describe("the booking rate — the database's window and the VAT's rate (the code review's 5 (b))", () => {
  /** `bookDate` null: the database's own today (CURRENT_DATE, the issue date the raw write sets). */
  const rawIssue = async (f: Fixture, id: string, set: { fx?: string; vat: string; total: string; book: string; bookDate: string | null; sekVat?: string }) => {
    const series = await f.platform.invoiceSeries.findFirstOrThrow({ where: { tenantId: f.tenantId } });
    const admins = f.seats.admin.memberId;
    return refusal(
      asMember(f, admins, (tx) => tx.$executeRaw`
        UPDATE invoice SET status = 'ISSUED', series_id = ${series.id}, locale = 'en',
               issue_date = CURRENT_DATE, due_date = CURRENT_DATE + payment_terms_days, issued_at = now(),
               issued_by_member_id = ${admins}, subtotal_ex_vat = 100, vat_total = ${set.vat}::numeric, total = ${set.total}::numeric,
               fx_rate_to_sek = ${set.fx ?? null}::numeric,
               fx_rate_date = CASE WHEN ${set.fx ?? null}::text IS NULL THEN NULL ELSE CURRENT_DATE - 1 END,
               vat_total_sek = ${set.sekVat ?? null}::numeric,
               book_rate_to_sek = ${set.book}::numeric, book_rate_date = coalesce(${set.bookDate}::date, CURRENT_DATE)
         WHERE id = ${id}`),
    );
  };

  it("holds an invoice without VAT to the ECB rate of its date — at most ten days old, never after", async () => {
    const { us } = clients[inv.tenantId]!;
    const id = await createDraft(manager(inv), { clientId: us });
    await setDraftVatProfile(manager(inv), id, "OUTSIDE_SCOPE");
    await updateDraftDetails(manager(inv), id, { currency: "USD" });
    const line = await addLine(manager(inv), id, { description: "Work" });
    await updateLine(manager(inv), id, line, { unitPrice: "100" });
    const day = await today(inv);
    expect(await rawIssue(inv, id, { vat: "0", total: "100", book: "10", bookDate: addDays(day, -12) })).toBe("INVOICE_BOOK_RATE_GUARD");
    expect(await rawIssue(inv, id, { vat: "0", total: "100", book: "10", bookDate: addDays(day, 2) })).toBe("INVOICE_BOOK_RATE_GUARD");
    // NaN orders above every number in Postgres: refused by name (the pre-apply review's 1).
    expect(await rawIssue(inv, id, { vat: "0", total: "100", book: "NaN", bookDate: null })).toBe("invoice_book_rate_pair");
  });

  it("holds an invoice carrying VAT in another currency to its VAT's own rate", async () => {
    const { se } = clients[inv.tenantId]!;
    const id = await createDraft(manager(inv), { clientId: se });
    await updateDraftDetails(manager(inv), id, { currency: "EUR" });
    const line = await addLine(manager(inv), id, { description: "Work" });
    await updateLine(manager(inv), id, line, { unitPrice: "100", vatRate: "25" });
    const yesterday = addDays(await today(inv), -1);
    expect(
      await rawIssue(inv, id, { fx: "11.194", vat: "25.00", total: "125.00", sekVat: "279.85", book: "11", bookDate: yesterday }),
    ).toBe("INVOICE_BOOK_RATE_GUARD");
  });
});

describe("the deduction tie (the code review's 2, 5 (a))", () => {
  it("a credit note issued AFTER the payment was marked is never deducted, even dated the same day", async () => {
    const { se } = clients[cash.tenantId]!;
    const day = await today(cash);
    const id = await issued(cash, se, [["600", "25"]]);
    await markInvoicePaid(admin(cash), id, { paidOn: day, note: null });
    const late = await partCredit(cash, id, "100");
    const made = await createExport(admin(cash));
    const entries = await entriesOf(cash, made.id);
    const payment = entries.find((e) => e.invoiceId === id && e.event === "PAYMENT")!;
    expect((payment.detail as { deductedIds: string[] }).deductedIds).toEqual([]);
    expect(rowsOf(payment.voucher)).toEqual(["1930 750.00", "3001 -600.00", "2611 -150.00"]);
    const noted = entries.find((e) => e.invoiceId === late && e.event === "CREDIT_NOTED")!;
    expect((noted.detail as { remark: { kind: string } }).remark.kind).toBe("afterPayment");
  });
});
