import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { todayIn } from "@/lib/due-date";
import { addDays } from "@/lib/week";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";

import { bookYearEnd, createExport, exportFile, readBookkeeping, readNewestYearEnd, readYearEndReminder, updateBookkeepingSettings } from "./bookkeeping";
import { createCreditDraft, creditInFull } from "./credit";
import { addLine, createDraft, removeLine, updateLine } from "./drafts";
import { LIST_COLUMNS, LIST_EVENTS, type ListWords } from "./invoice-list";
import { issueInvoice } from "./issue";
import { markInvoicePaid, markInvoiceUnpaid } from "./send";
import { updateCompanyDetails, updatePaymentDetails } from "./seller";
import { setFirstInvoiceNumber } from "./series";
import { decodeCp437 } from "./sie";
import { VAT_PROFILES } from "./vat";

/**
 * THE CASH METHOD'S YEAR END, IN TIME (Phase 4 slice 111b; founder decision
 * C83; migrations 20261011090000 + 20261011090100; the design:
 * docs/research/2026-10-10-slice-111b-year-end-design.md, §13 overriding its
 * body). A year end books invoices DATED in a year that has ended, and the
 * database lets no writer date an invoice anything but today (± a day) — so
 * this file plants the past: invoices issued through the REAL services, then
 * their `issue_date`/`due_date` moved back through the database's OWNER
 * connection (`DIRECT_URL`) with `session_replication_role = replica` for that
 * one statement (`sealed-time.dbtest.ts`'s and `retention.dbtest.ts`'s
 * precedent; CHECKs stay on — so an original is planted BEFORE its credit note
 * is issued, as `invoice_credits_reference` holds `credits_issue_date ≤
 * issue_date`). Then the REAL services through the REAL guards:
 *
 *   - refused while a payment of the year waits; the preview; a press that
 *     saw another list refused; the year-end file's vouchers; booked once;
 *   - a late payment before the reversal is filed (withdrawal + payment, no
 *     reversal ever), and after (the reversal withdrawn on the file's day);
 *   - a late payment unmarked again before the reversal's withdrawal (the
 *     review's M2) — the withdrawal still filed;
 *   - a payment's date corrected inside the closed year (M3) — its reversal
 *     dated in that year;
 *   - the downloads; the database's refusals that need a past date.
 *
 * WHERE IT RUNS: in CI (`CI` set), or where `DBTEST_ALLOW_REPLICA=1` says so
 * — AND the owner is a superuser (CI's throwaway database's is; the dev
 * database's is not). Locally it SKIPS without connecting; in CI it FAILS
 * rather than skip if the owner is not a superuser.
 *
 * Tenant slug prefix `bkye-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

vi.setConfig({ testTimeout: 180_000 });

const directUrl = process.env["DIRECT_URL"];
const inCi = process.env["CI"] === "true";
const allowed = inCi || process.env["DBTEST_ALLOW_REPLICA"] === "1";

let owner: pg.Client | null = null;
let superuser = false;
if (allowed && directUrl) {
  owner = new pg.Client({ connectionString: directUrl });
  // A dropped idle connection must fail a test, not crash the worker.
  owner.on("error", () => {});
  try {
    await owner.connect();
    const r = await owner.query<{ rolsuper: boolean }>("SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
    superuser = r.rows[0]?.rolsuper === true;
  } catch (e) {
    if (inCi) throw e;
  }
  if (!superuser) {
    await owner.end().catch(() => {});
    owner = null;
  }
}
if (inCi && !superuser) {
  throw new Error("year-end.dbtest: CI's owner connection must be a superuser — this file must not skip in CI");
}

type Fixture = Awaited<ReturnType<typeof setupTenant>>;
let f: Fixture;
let clientId: string;
/** The workspace's today — what a raw file is dated, as the services date one. */
let T: string;
const run = randomUUID().slice(0, 8);

const ctxOf = (memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });
const owner_ = () => ctxOf(f.seats.owner.memberId);
const admin = () => ctxOf(f.seats.admin.memberId);
const manager = () => ctxOf(f.seats.manager.memberId);

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

/** A raw write's refusal, by the guard's token. */
const refusedBy = async (p: Promise<unknown>, token: string): Promise<boolean> => {
  try {
    await p;
    return false;
  } catch (e) {
    const text = `${e instanceof Error ? e.message : String(e)} ${JSON.stringify((e as { meta?: unknown })?.meta ?? "")}`;
    if (text.includes("ROLLBACK_OK")) return false;
    return text.includes(token);
  }
};

/** Whether a rolled-back raw write got all the way to its own rollback — nothing refused it. */
const rolledBackClean = async (p: Promise<unknown>): Promise<boolean> => {
  try {
    await p;
    return false;
  } catch (e) {
    return String(e instanceof Error ? e.message : e).includes("ROLLBACK_OK");
  }
};

const asAdmin = <T>(fn: (tx: TenantDb) => Promise<T>) => withTenant(f.tenantId, { type: "member", id: f.seats.admin.memberId }, fn);

/** Move an issued document's dates back (CI only — the owner connection, triggers off for this one statement). */
async function plant(invoiceId: string, issueDate: string, dueDate = addDays(issueDate, 30)): Promise<void> {
  await owner!.query("BEGIN");
  try {
    await owner!.query("SET LOCAL session_replication_role = replica");
    const r = await owner!.query("UPDATE invoice SET issue_date = $1::date, due_date = $2::date WHERE id = $3 AND tenant_id = $4", [
      issueDate,
      dueDate,
      invoiceId,
      f.tenantId,
    ]);
    if (r.rowCount !== 1) throw new Error("plant: no such invoice");
    await owner!.query("COMMIT");
  } catch (e) {
    await owner!.query("ROLLBACK");
    throw e;
  }
}

/** An issued SEK invoice of one 25 % line, dated `issueDate`. */
async function issuedOn(price: string, issueDate: string): Promise<string> {
  const id = await createDraft(manager(), { clientId });
  const line = await addLine(manager(), id, { description: `Work at ${price}` });
  await updateLine(manager(), id, line, { unitPrice: price, vatRate: "25" });
  await issueInvoice(admin(), id);
  await plant(id, issueDate);
  return id;
}

/** A part credit note of an invoice already planted: its line lowered to `price`, dated `issueDate`. */
async function partCreditOn(invoiceId: string, price: string, issueDate: string): Promise<string> {
  const cn = await createCreditDraft(admin(), invoiceId, { reason: "Discount agreed" });
  const lines = await f.platform.invoiceLine.findMany({ where: { invoiceId: cn }, orderBy: { position: "asc" } });
  await updateLine(admin(), cn, lines[0]!.id, { unitPrice: price });
  for (const l of lines.slice(1)) await removeLine(admin(), cn, l.id);
  await issueInvoice(admin(), cn);
  await plant(cn, issueDate, issueDate);
  return cn;
}

const entriesOf = (exportId: string) => f.platform.invoiceExportEntry.findMany({ where: { tenantId: f.tenantId, exportId }, orderBy: { position: "asc" } });
const rowsOf = (voucher: unknown): string[] =>
  ((voucher as { rows?: { account: string; amount: string }[] } | null)?.rows ?? []).map((r) => `${r.account} ${r.amount}`);
const negate = (rows: string[]) =>
  rows.map((r) => {
    const [account, amount] = r.split(" ");
    return `${account} ${amount!.startsWith("-") ? amount!.slice(1) : `-${amount}`}`;
  });
const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

const WORDS: ListWords & { readonly sheet: string } = {
  sheet: "Bookkeeping",
  headers: Object.fromEntries(LIST_COLUMNS.map((c) => [c, c])) as ListWords["headers"],
  events: Object.fromEntries(LIST_EVENTS.map((e) => [e, e])) as ListWords["events"],
  invoice: "Invoice",
  creditNote: "Credit note",
  treatments: Object.fromEntries(VAT_PROFILES.map((p) => [p, p])) as ListWords["treatments"],
  remark: (r) => (r.file === undefined ? r.kind : `${r.kind} ${r.day} #${r.file}`),
};

/** A raw file of the cash method — `fn` in it, always rolled back. */
const inFreshFile = (yearEnd: string | null, fn: (tx: TenantDb, exportId: string) => Promise<unknown>) =>
  asAdmin(async (tx) => {
    const made = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO invoice_export (id, tenant_id, number, method, series, made_on, year_end, created_by_member_id)
      VALUES (${randomUUID()}, ${f.tenantId}, 1, 'CASH', 'F', ${T}::date, ${yearEnd}::date, ${f.seats.admin.memberId}) RETURNING id`;
    await fn(tx, made[0]!.id);
    throw new Error("ROLLBACK_OK");
  });
const rawEntry = (tx: TenantDb, exportId: string, invoiceId: string, event: string, bookedOn: string, yearEnd: string | null, rows: string[]) =>
  tx.$executeRaw`INSERT INTO invoice_export_entry (id, tenant_id, export_id, invoice_id, position, event, booked_on, year_end, voucher, detail)
                 VALUES (${randomUUID()}, ${f.tenantId}, ${exportId}, ${invoiceId}, 1, ${event}::invoice_export_event, ${bookedOn}::date, ${yearEnd}::date,
                         ${JSON.stringify({ text: "Test x", rows: rows.map((r) => ({ account: r.split(" ")[0], amount: r.split(" ")[1] })) })}::jsonb, '{}'::jsonb)`;

describe.skipIf(!superuser)("the cash method's year end, in time (CI only — a superuser plants the past)", () => {
  let E: string; // the year end: the last day of the month before last
  const ids: Record<string, string> = {};
  const credits: Record<string, string> = {};

  beforeAll(async () => {
    f = await setupTenant("bkye");
    clientId = randomUUID();
    await f.platform.client.create({
      data: { id: clientId, tenantId: f.tenantId, name: `Bokslut ${run} AB`, orgNr: "556677-8899", addressLine1: "Gatan 1", postalCode: "111 22", city: "Stockholm", countryCode: "SE" },
    });
    await updateCompanyDetails(owner_(), {
      legalName: `Bokslutsbyrå ${run} AB`,
      orgNr: "556016-0680",
      vatNumber: "SE556016068001",
      seat: "Stockholm",
      fSkattApproved: true,
      addressLine1: "Storgatan 1",
      postalCode: "111 22",
      city: "Stockholm",
      countryCode: "SE",
    });
    await updatePaymentDetails(owner_(), { bankgiro: "5050-1055" });
    await setFirstInvoiceNumber(owner_(), "7001");
    const prefs = await f.platform.tenantPreference.findFirst({ where: { tenantId: f.tenantId, key: "ui.timezone" } });
    T = todayIn(typeof prefs?.value === "string" ? prefs.value : "Europe/Stockholm", new Date());
    const lastMonthEnd = addDays(`${T.slice(0, 7)}-01`, -1);
    E = addDays(`${lastMonthEnd.slice(0, 7)}-01`, -1);
    // The financial year starts the month after E, so E closes the year before this one.
    await updateBookkeepingSettings(owner_(), { method: "CASH", yearStart: String((Number(E.slice(5, 7)) % 12) + 1) });

    const dated = addDays(E, -20);
    for (const k of ["A", "B", "C", "G", "H", "K"]) ids[k] = await issuedOn("1000", dated);
    ids["D"] = await issuedOn("1000", dated);
    credits["D"] = await partCreditOn(ids["D"]!, "400", addDays(E, -5));
    ids["F"] = await issuedOn("1000", dated);
    credits["F"] = (await creditInFull(admin(), ids["F"]!, { reason: "Cancelled", correctedCopy: false })).creditNoteId;
    await plant(credits["F"]!, addDays(E, -5), addDays(E, -5));
  }, 300_000);

  afterAll(async () => {
    if (f) {
      await f.deleteInvoices();
      await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
      await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
      await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
      await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
      await f.cleanup();
    }
    await owner?.end();
  }, 180_000);

  it("waits for the year's payments to be filed, then shows exactly the invoices unpaid on its last day", async () => {
    await markInvoicePaid(admin(), ids["B"]!, { paidOn: addDays(E, -3), note: null });
    await markInvoicePaid(admin(), ids["H"]!, { paidOn: addDays(E, -10), note: null });
    await markInvoicePaid(admin(), ids["C"]!, { paidOn: T, note: null });

    const before = await readBookkeeping(admin());
    expect(before.yearEnd?.date).toBe(E);
    expect(before.yearEnd?.waiting).toBe(2); // B's and H's payments — not C's (the new year), not the credit notes' listings
    expect(await readYearEndReminder(admin())).toBe(E);
    expect(await outcome(bookYearEnd(admin(), { yearEnd: E, count: 5, totalSek: "5750.00" }))).toBe("INVOICE_YEAR_END_WAITING");

    const first = await createExport(admin());
    const events = (await entriesOf(first.id)).map((e) => e.event).sort();
    expect(events).toEqual(["CREDIT_NOTED", "CREDIT_NOTED", "PAYMENT", "PAYMENT"]);

    const page = await readBookkeeping(admin());
    expect(page.yearEnd?.waiting).toBe(0);
    expect(page.yearEnd?.leftOut).toEqual([]);
    // A, C (paid after E), D (less its credit before E), G, K — not B, H (paid by E), F (credited in full).
    expect(page.yearEnd?.count).toBe(5);
    expect(page.yearEnd?.totalSek).toBe("5750.00");
    const numbers = await f.platform.invoice.findMany({ where: { id: { in: [ids["A"]!, ids["C"]!, ids["D"]!, ids["G"]!, ids["K"]!] } }, select: { displayNumber: true } });
    expect(page.yearEnd?.rows.map((r) => r.number).sort()).toEqual(numbers.map((n) => n.displayNumber!).sort());

    // The exact back-dated days the database admits (migration 20261011090200; the fix pass's low) — rolled back.
    // B unmarked, its year ended and not closed: the booked day's month end (E — E − 3 is in E's month) …
    await markInvoiceUnpaid(admin(), ids["B"]!);
    const bPaid = await f.platform.invoiceExportEntry.findFirstOrThrow({ where: { tenantId: f.tenantId, invoiceId: ids["B"]!, event: "PAYMENT" } });
    const bUndo = negate(rowsOf(bPaid.voucher));
    expect(await rolledBackClean(inFreshFile(null, (tx, x) => rawEntry(tx, x, ids["B"]!, "PAYMENT_UNDONE", E, null, bUndo)))).toBe(true);
    // … and no other back-dated day.
    expect(await refusedBy(inFreshFile(null, (tx, x) => rawEntry(tx, x, ids["B"]!, "PAYMENT_UNDONE", addDays(E, -1), null, bUndo)), "INVOICE_EXPORT_ENTRY_GUARD")).toBe(true);
    // B moved forward into the new year: the booked day's month end still (its code review's 1).
    await markInvoicePaid(admin(), ids["B"]!, { paidOn: T, note: null });
    expect(await rolledBackClean(inFreshFile(null, (tx, x) => rawEntry(tx, x, ids["B"]!, "PAYMENT_UNDONE", E, null, bUndo)))).toBe(true);
    // Back on its own day: nothing left to file.
    await markInvoiceUnpaid(admin(), ids["B"]!);
    await markInvoicePaid(admin(), ids["B"]!, { paidOn: addDays(E, -3), note: null });
    expect((await readBookkeeping(admin())).yearEnd?.waiting).toBe(0);
  });

  it("refuses, in the database, a year end for an invoice paid by then", async () => {
    const yeRows = ["1510 1250.00", "3001 -1000.00", "2611 -250.00"];
    expect(await refusedBy(inFreshFile(E, (tx, x) => rawEntry(tx, x, ids["B"]!, "YEAR_END", E, E, yeRows)), "INVOICE_EXPORT_ENTRY_GUARD")).toBe(true);
    // And accepts one for an invoice unpaid then (rolled back).
    expect(await rolledBackClean(inFreshFile(E, (tx, x) => rawEntry(tx, x, ids["A"]!, "YEAR_END", E, E, yeRows)))).toBe(true);
  });

  it("books the year end: a voucher per unpaid invoice on its last day, to receivables, less the credits by then — once", async () => {
    expect(await outcome(bookYearEnd(manager(), { yearEnd: E, count: 5, totalSek: "5750.00" }))).toBe("FORBIDDEN");
    expect(await outcome(bookYearEnd(admin(), { yearEnd: E, count: 4, totalSek: "5750.00" }))).toBe("INVOICE_YEAR_END_CHANGED");
    const booked = await bookYearEnd(admin(), { yearEnd: E, count: 5, totalSek: "5750.00" });
    expect(booked.count).toBe(5);
    const file = await f.platform.invoiceExport.findUniqueOrThrow({ where: { id: booked.id } });
    expect(day(file.yearEnd)).toBe(E);
    const entries = await entriesOf(booked.id);
    expect(entries.every((e) => e.event === "YEAR_END" && day(e.bookedOn) === E && day(e.yearEnd) === E)).toBe(true);
    const of = (k: string) => entries.find((e) => e.invoiceId === ids[k])!;
    expect(rowsOf(of("A").voucher)).toEqual(["1510 1250.00", "3001 -1000.00", "2611 -250.00"]);
    expect(rowsOf(of("D").voucher)).toEqual(["1510 750.00", "3001 -600.00", "2611 -150.00"]);
    const creditNumber = (await f.platform.invoice.findUniqueOrThrow({ where: { id: credits["D"]! } })).displayNumber;
    expect((of("D").detail as { relates: string[] }).relates).toEqual([creditNumber]);
    expect((of("A").voucher as { text: string }).text.startsWith("Bokslut obetald faktura")).toBe(true);

    expect(await readNewestYearEnd(admin())).toBe(E);
    expect(await readYearEndReminder(admin())).toBeNull();
    expect((await readBookkeeping(admin())).yearEnd).toBeNull();
    expect(await outcome(bookYearEnd(admin(), { yearEnd: E, count: 0, totalSek: "0.00" }))).toBe("INVOICE_YEAR_END_NOT_DUE");

    // The SIE: each voucher on E, Swedish texts; the list names the event.
    const sie = decodeCp437((await exportFile(admin(), booked.id, "sie", WORDS)).bytes);
    expect(sie).toContain("Bokslut obetald faktura");
    expect(sie).toContain(`#VER "F" "" ${E.split("-").join("")}`);
    expect((await exportFile(admin(), booked.id, "xlsx", WORDS)).bytes.length).toBeGreaterThan(0);

    // Nothing is issued dated on or before a booked year end (the review's L5) — the raw write a zone change could make.
    const draft = await createDraft(manager(), { clientId });
    expect(
      await refusedBy(asAdmin((tx) => tx.$executeRaw`UPDATE invoice SET status = 'ISSUED', issue_date = ${E}::date WHERE id = ${draft}`), "INVOICE_CLOSED_YEAR_GUARD"),
    ).toBe(true);
    await f.platform.invoice.delete({ where: { id: draft } });
  });

  it("a late payment before the reversal is filed: withdrawn with its payment, in one file — and never reversed", async () => {
    await markInvoicePaid(admin(), ids["G"]!, { paidOn: addDays(E, -2), note: null });
    expect((await readBookkeeping(admin())).next?.intoBookedYear).toBe(E);
    const made = await createExport(admin());
    const g = (await entriesOf(made.id)).filter((e) => e.invoiceId === ids["G"]);
    expect(g.map((e) => e.event).sort()).toEqual(["PAYMENT", "YEAR_END_UNDONE"]);
    const withdrawal = g.find((e) => e.event === "YEAR_END_UNDONE")!;
    expect(day(withdrawal.bookedOn)).toBe(E);
    expect(rowsOf(withdrawal.voucher)).toEqual(negate(["1510 1250.00", "3001 -1000.00", "2611 -250.00"]));
    expect(day(g.find((e) => e.event === "PAYMENT")!.bookedOn)).toBe(addDays(E, -2));
    // A reversal of the withdrawn year end: the database refuses it.
    expect(
      await refusedBy(inFreshFile(null, (tx, x) => rawEntry(tx, x, ids["G"]!, "YEAR_END_REVERSED", addDays(E, 1), E, negate(["1510 1250.00", "3001 -1000.00", "2611 -250.00"]))), "INVOICE_EXPORT_ENTRY_GUARD"),
    ).toBe(true);
  });

  it("the new year's file: each standing year end reversed the next day, exactly; the after-the-year payment as any payment", async () => {
    const made = await createExport(admin());
    const entries = await entriesOf(made.id);
    const reversed = entries.filter((e) => e.event === "YEAR_END_REVERSED");
    expect(reversed.map((e) => e.invoiceId).sort()).toEqual([ids["A"]!, ids["C"]!, ids["D"]!, ids["K"]!].sort());
    expect(reversed.every((e) => day(e.bookedOn) === addDays(E, 1) && day(e.yearEnd) === E)).toBe(true);
    expect(rowsOf(reversed.find((e) => e.invoiceId === ids["D"])!.voucher)).toEqual(negate(["1510 750.00", "3001 -600.00", "2611 -150.00"]));
    const paidAfter = entries.find((e) => e.invoiceId === ids["C"] && e.event === "PAYMENT");
    expect(day(paidAfter?.bookedOn ?? null)).toBe(T);
    expect(await outcome(createExport(admin()))).toBe("INVOICE_EXPORT_EMPTY");
  });

  it("a late payment after the reversal is filed: withdrawn with its payment, the reversal withdrawn in its own year — and still when unmarked between (M2)", async () => {
    // The payment alone, while its year end stands: the database refuses it.
    await markInvoicePaid(admin(), ids["A"]!, { paidOn: addDays(E, -1), note: null });
    await markInvoicePaid(admin(), ids["K"]!, { paidOn: addDays(E, -1), note: null });
    const payRows = ["1930 1250.00", "3001 -1000.00", "2611 -250.00"];
    expect(await refusedBy(inFreshFile(null, (tx, x) => rawEntry(tx, x, ids["A"]!, "PAYMENT", addDays(E, -1), null, payRows)), "INVOICE_EXPORT_ENTRY_GUARD")).toBe(true);

    const old = await createExport(admin());
    const oldEvents = (await entriesOf(old.id)).map((e) => `${e.event}:${e.invoiceId === ids["A"] ? "A" : e.invoiceId === ids["K"] ? "K" : "?"}`).sort();
    expect(oldEvents).toEqual(["PAYMENT:A", "PAYMENT:K", "YEAR_END_UNDONE:A", "YEAR_END_UNDONE:K"]);

    // K unmarked before the reversal's withdrawal is filed (the review's M2): it is filed all the same.
    await markInvoiceUnpaid(admin(), ids["K"]!);
    const next = await createExport(admin());
    const nextEntries = await entriesOf(next.id);
    const nextEvents = nextEntries.map((e) => `${e.event}:${e.invoiceId === ids["A"] ? "A" : e.invoiceId === ids["K"] ? "K" : "?"}`).sort();
    expect(nextEvents).toEqual(["PAYMENT_UNDONE:K", "YEAR_END_REVERSAL_UNDONE:A", "YEAR_END_REVERSAL_UNDONE:K"]);
    // On the file's day — never back on E + 1 (the review's L1); K's unmark of a closed year too.
    // The FILE's day (its row's own `made_on` — a run crossing midnight never trips on a T from beforeAll).
    const madeOn = day((await f.platform.invoiceExport.findUniqueOrThrow({ where: { id: next.id } })).madeOn);
    expect(nextEntries.every((e) => day(e.bookedOn) === madeOn)).toBe(true);
    const back = nextEntries.find((e) => e.event === "YEAR_END_REVERSAL_UNDONE" && e.invoiceId === ids["A"])!;
    expect(rowsOf(back.voucher)).toEqual(["1510 1250.00", "3001 -1000.00", "2611 -250.00"]);
  });

  it("refuses an unmarked payment of a closed year dated back into it (the re-check's R3)", async () => {
    await markInvoiceUnpaid(admin(), ids["B"]!);
    const booked = await f.platform.invoiceExportEntry.findFirstOrThrow({ where: { tenantId: f.tenantId, invoiceId: ids["B"]!, event: "PAYMENT" } });
    expect(await refusedBy(inFreshFile(null, (tx, x) => rawEntry(tx, x, ids["B"]!, "PAYMENT_UNDONE", E, null, negate(rowsOf(booked.voucher)))), "INVOICE_EXPORT_ENTRY_GUARD")).toBe(true);
    // Marked again on its own day: nothing to file.
    await markInvoicePaid(admin(), ids["B"]!, { paidOn: addDays(E, -3), note: null });
  });

  it("a payment's date corrected inside the closed year stays in it (the review's M3)", async () => {
    await markInvoiceUnpaid(admin(), ids["H"]!);
    await markInvoicePaid(admin(), ids["H"]!, { paidOn: addDays(E, -8), note: null });
    const page = await readBookkeeping(admin());
    expect(page.next?.intoBookedYear).toBe(E);
    const made = await createExport(admin());
    const h = (await entriesOf(made.id)).filter((e) => e.invoiceId === ids["H"]);
    expect(h.map((e) => e.event).sort()).toEqual(["PAYMENT", "PAYMENT_UNDONE"]);
    // The later day's month's end — E itself (E − 8 is in E's month).
    expect(day(h.find((e) => e.event === "PAYMENT_UNDONE")!.bookedOn)).toBe(E);
    expect(day(h.find((e) => e.event === "PAYMENT")!.bookedOn)).toBe(addDays(E, -8));
    expect(await outcome(createExport(admin()))).toBe("INVOICE_EXPORT_EMPTY");
  });
});
