import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { defaultFakeCompany, fakeCompanyTenantIdFor, fakeConsent, readFakeCompany, removeFakeCompany, setFakeCompany } from "@/integrations/fortnox/fake";
import { DomainError } from "@/lib/domain-error";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { resetLocalLimiter } from "@/ratelimit";
import { LocalDiskTransport, setStorage } from "@/storage";

import { createExport, exportFile, makeFortnoxFile, readBookkeeping, updateBookkeepingSettings } from "./bookkeeping";
import { addLine, createDraft, updateLine } from "./drafts";
import { beginFortnoxConnect, completeFortnoxConnect, disconnectFortnox } from "./fortnox-connection";
import { sendToFortnox } from "./fortnox-send";
import { isThrowawayWorkspace } from "./fortnox-voucher";
import { LIST_COLUMNS, LIST_EVENTS, type ListWords } from "./invoice-list";
import { issueInvoice } from "./issue";
import { orgDigitsOf } from "./org-digits";
import { ensureInvoicePdf } from "./pdf-store";
import { updateCompanyDetails, updatePaymentDetails } from "./seller";
import { setFirstInvoiceNumber } from "./series";
import { VAT_PROFILES } from "./vat";

/**
 * THE NIGHTLY SEND — against the real database, the real `app_runtime` role
 * and the FAKE Fortnox (Phase 4 slice 114b; founder decision C89 (b), (c);
 * migration 20261020090000_fortnox_send; the design's §5 as amended by
 * §10–§12):
 *   - the org. number's two readings (SQL and app) agree;
 *   - a night: the file made as SYSTEM to the connection, every voucher in
 *     Fortnox in order with its PDF attached, its numbers recorded,
 *     `invoice_export.sent`; the night closes;
 *   - each company's sales only into its own books — Make file takes only
 *     another seller's, and the database refuses the connected company's in a
 *     download file;
 *   - the database's rules: the night's file and its lock only behind the
 *     GUC; no voucher of a Fortnox file without its delivery; a delivery
 *     moved only by the run holding the live lease, forward only; a person's
 *     acts by a holder of `invoice:export`, never while a lease is live;
 *   - an UNKNOWN answer reconciled by number — one voucher, never two;
 *   - a refusal stops the line in order, BROKEN once, restored when it goes;
 *     no financial year; a PDF attached on a later run, and a PDF owed past a
 *     day reported without flapping;
 *   - a stop only a person mends is left alone; a disconnect sends nothing.
 *
 * Not here: the year end's Fortnox file (a year end needs invoices dated in
 * an ended year — `year-end.dbtest.ts` plants them, CI only).
 *
 * Tenant slug prefix `fnxs-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

vi.setConfig({ testTimeout: 240_000 });

type Fixture = Awaited<ReturnType<typeof setupTenant>>;

/** The connected company's org. number (the company card's), and another company's. */
const ORG = "556016-0680";
const OTHER_ORG = "559100-0004";

let f: Fixture;
let clientId: string;
let companyTenantId: string;
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-fortnox-send-"));

const ctxOf = (memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });
const owner = () => ctxOf(f.seats.owner.memberId);
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

/**
 * A raw write's refusal by its guard's token — read from the error's META,
 * never its message (outside production Prisma prints the CALLER'S SOURCE in
 * the message, so a token in an assertion would match itself — memory
 * `prisma-code-frame-trap`).
 */
const TOKENS = [
  "INVOICE_EXPORT_DELIVERY_GUARD",
  "INVOICE_EXPORT_ENTRY_OWED",
  "INVOICE_EXPORT_ENTRY_GUARD",
  "INVOICE_EXPORT_GUARD",
  "INVOICE_EXPORT_LOCK",
  "invoice_export_member_fortnox_year_end",
  "invoice_export_night_file",
  "permission denied",
] as const;
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    const meta = JSON.stringify((e as { meta?: unknown })?.meta ?? {});
    const found = TOKENS.find((t) => meta.includes(t));
    if (found) return found;
    throw e;
  }
};

const WORDS: ListWords & { readonly sheet: string } = {
  sheet: "Bookkeeping",
  headers: Object.fromEntries(LIST_COLUMNS.map((c) => [c, c])) as ListWords["headers"],
  events: Object.fromEntries(LIST_EVENTS.map((e) => [e, e])) as ListWords["events"],
  invoice: "Invoice",
  creditNote: "Credit note",
  treatments: Object.fromEntries(VAT_PROFILES.map((p) => [p, p])) as ListWords["treatments"],
  remark: (r) => r.kind,
};

/** An issued SEK invoice of one line at 25 % VAT — with its PDF unless asked not to. */
async function issued(price: string, opts: { readonly pdf?: boolean } = {}): Promise<string> {
  const id = await createDraft(manager(), { clientId });
  const line = await addLine(manager(), id, { description: `Work at ${price}` });
  await updateLine(manager(), id, line, { unitPrice: price, vatRate: "25" });
  await issueInvoice(admin(), id);
  if (opts.pdf !== false) await ensureInvoicePdf(admin(), id);
  return id;
}

/** A run of the nightly send, now (or at `now`), with two minutes of its own. */
const night = (now?: Date) => sendToFortnox(f.tenantId, { deadline: Date.now() + 120_000, ...(now ? { now } : {}) });

/** The connection, as the database holds it. */
const connection = () => f.platform.integrationConnection.findFirstOrThrow({ where: { tenantId: f.tenantId, status: { not: "DISCONNECTED" } } });

/** Its night opened again: its last night two days back (the platform role is not judged). */
async function openNight(): Promise<void> {
  const c = await connection();
  await f.platform.integrationConnection.update({ where: { id: c.id }, data: { lastNight: new Date(Date.now() - 2 * 86_400_000) } });
}

/** The fake company, changed. */
const fake = (patch: Partial<ReturnType<typeof defaultFakeCompany>>) => setFakeCompany({ ...readFakeCompany(companyTenantId)!, ...patch });

/** A SYSTEM transaction with the sender's GUC (and, when given, a run id) — what `fortnox-send.ts` opens. */
const asSender = <T>(fn: (tx: TenantDb) => Promise<T>, run?: string) =>
  withTenant(f.tenantId, { type: "system" }, async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.fortnox_sending', 'on', true)`;
    if (run) await tx.$executeRaw`SELECT set_config('app.fortnox_run', ${run}, true)`;
    return fn(tx);
  });

/** While `fn` runs, `run` holds the connection's lease — claimed and released as a run would. */
async function withLease<T>(run: string, fn: () => Promise<T>): Promise<T> {
  const conn = await connection();
  await asSender((tx) => tx.$executeRaw`UPDATE integration_connection SET send_lease_until = now() + interval '5 minutes', send_run_id = ${run} WHERE id = ${conn.id}`);
  try {
    return await fn();
  } finally {
    await asSender((tx) => tx.$executeRaw`UPDATE integration_connection SET send_lease_until = NULL, send_run_id = NULL WHERE id = ${conn.id}`);
  }
}

const deliveriesOf = (exportId: string) =>
  f.platform.invoiceExportDelivery.findMany({
    where: { tenantId: f.tenantId, exportId },
    include: { entry: { select: { position: true, bookedOn: true, invoiceId: true } } },
    orderBy: { entry: { position: "asc" } },
  });

/** Press Connect, approve at the fake Fortnox, come back (fortnox-connection.dbtest's walk). */
async function connect(): Promise<void> {
  resetLocalLimiter();
  const { url } = await beginFortnoxConnect(owner());
  const q = new URL(url).searchParams;
  const answer = fakeConsent({ companyTenantId: q.get("company")!, name: q.get("name")!, orgNr: q.get("org")!, codeChallenge: q.get("code_challenge")! });
  if (!("code" in answer)) throw new Error("the fake consent refused");
  const done = await completeFortnoxConnect(owner(), { state: q.get("state")!, code: answer.code, error: null });
  if (done.outcome !== "CONNECTED" && done.outcome !== "RECONNECTED") throw new Error(`connect: ${done.outcome}`);
}

beforeAll(async () => {
  setStorage(new LocalDiskTransport(storageDir));
  f = await setupTenant("fnxs");
  clientId = randomUUID();
  await f.platform.client.create({
    data: { id: clientId, tenantId: f.tenantId, name: "Fnxs Kund AB", orgNr: "556677-8899", addressLine1: "Gatan 1", postalCode: "111 22", city: "Stockholm", countryCode: "SE" },
  });
  await updateCompanyDetails(owner(), {
    legalName: "Fnxs Konsult AB",
    orgNr: ORG,
    vatNumber: "SE556016068001",
    seat: "Stockholm",
    fSkattApproved: true,
    addressLine1: "Storgatan 1",
    postalCode: "111 22",
    city: "Stockholm",
    countryCode: "SE",
  });
  await updatePaymentDetails(owner(), { bankgiro: "5050-1055" });
  await setFirstInvoiceNumber(owner(), "6001");
  await updateBookkeepingSettings(owner(), { method: "INVOICE" });
  companyTenantId = fakeCompanyTenantIdFor(f.tenantId);
  removeFakeCompany(companyTenantId);
  await connect();
}, 240_000);

beforeEach(() => {
  resetLocalLimiter();
});

afterAll(async () => {
  setStorage(null);
  removeFakeCompany(companyTenantId ?? "");
  rmSync(storageDir, { recursive: true, force: true });
  if (!f) return;
  await f.deleteInvoices();
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 240_000);

describe("whose books an entry belongs in", () => {
  it("the database's reading of an org. number is the app's, on every input", async () => {
    const inputs = ["556016-0680", "5560160680", " 556016 0680 ", "16556016-0680", "19800101-1234", "18800101-1234", "17556016-0680", "556016-068", "", "-", "SE556016068001"];
    const sql = await withTenant(f.tenantId, { type: "system" }, (tx) =>
      tx.$queryRaw<{ raw: string; digits: string | null }[]>`SELECT x AS raw, invoice_org_digits(x) AS digits FROM unnest(${inputs}::text[]) AS t(x)`,
    );
    for (const row of sql) expect(row.digits, JSON.stringify(row.raw)).toBe(orgDigitsOf(row.raw));
    const [nul] = await withTenant(f.tenantId, { type: "system" }, (tx) => tx.$queryRaw<{ d: string | null }[]>`SELECT invoice_org_digits(NULL) AS d`);
    expect(nul?.d).toBeNull();
  });
});

describe("who is sent", () => {
  it("a connection made by another deployment's Fortnox app is never sent from here (S2); a test workspace is the fake's (S′10b)", async () => {
    expect(await sendToFortnox(f.tenantId, { deadline: Date.now() + 60_000, appClientId: "another-fortnox-app" })).toMatchObject({ skipped: "foreign", booked: 0, files: 0 });
    // Nothing touched: no lease claimed, no file made.
    expect(await connection()).toMatchObject({ sendRunId: null, sendLeaseUntil: null });
    expect(await f.platform.invoiceExport.count({ where: { tenantId: f.tenantId } })).toBe(0);
    // Every fixture member has a test address: this is a workspace the fake may send (the query, against the real tables).
    expect(await withTenant(f.tenantId, { type: "system" }, (tx) => isThrowawayWorkspace(tx, f.tenantId))).toBe(true);
  });
});

describe("a night", () => {
  it("makes the file as SYSTEM, books every voucher in order with its PDF, records Fortnox's numbers — and closes", async () => {
    const a = await issued("1000");
    const b = await issued("2000");
    await openNight();
    const conn = await connection();
    const run = await night();
    expect(run).toMatchObject({ skipped: null, booked: 2, attached: 2, files: 1, stopped: null });

    const file = await f.platform.invoiceExport.findFirstOrThrow({ where: { tenantId: f.tenantId }, orderBy: { number: "desc" } });
    expect(file).toMatchObject({ destination: "FORTNOX", connectionId: conn.id, createdByMemberId: null, yearEnd: null });
    const deliveries = await deliveriesOf(file.id);
    expect(deliveries.map((d) => d.entry.invoiceId)).toEqual([a, b]);
    expect(deliveries.map((d) => [d.state, d.fortnoxSeries, d.fortnoxNumber])).toEqual([
      ["DONE", "F", 1],
      ["DONE", "F", 2],
    ]);
    expect(deliveries.every((d) => (d.files as { connected: boolean }[]).length === 1 && (d.files as { connected: boolean }[])[0]!.connected)).toBe(true);

    // In Fortnox: each voucher once, our marker, the file's own rows; each PDF connected to its voucher.
    const books = readFakeCompany(companyTenantId)!;
    expect(books.vouchers?.map((v) => [v.series, v.number, v.comments])).toEqual(deliveries.map((d) => ["F", d.fortnoxNumber, `Fortleva ${d.entryId}`]));
    const entries = await f.platform.invoiceExportEntry.findMany({ where: { exportId: file.id }, orderBy: { position: "asc" } });
    expect(books.vouchers?.[0]?.rows.map((r) => [String(r.account), r.debit, r.credit])).toEqual(
      ((entries[0]!.voucher as { rows: { account: string; amount: string }[] }).rows).map((r) =>
        r.amount.startsWith("-") ? [r.account, "0", r.amount.slice(1)] : [r.account, r.amount, "0"],
      ),
    );
    expect(books.fileConnections?.map((c) => c.number)).toEqual([1, 2]);
    expect(books.inbox).toHaveLength(2);

    // Audited as SYSTEM: the file made, then sent — once.
    const created = (await f.audits("invoice_export.created")).filter((r) => r.targetId === file.id);
    expect(created.map((r) => [r.actorType, (r.metadata as { destination?: string }).destination])).toEqual([["SYSTEM", "FORTNOX"]]);
    const sent = (await f.audits("invoice_export.sent")).filter((r) => r.targetId === file.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.metadata).toMatchObject({ number: file.number, vouchers: 2, byHand: 0, fortnoxSeries: "F", fortnoxFrom: 1, fortnoxTo: 2 });

    // The night is over, the connection says when it last reached Fortnox, its lease released.
    const after = await connection();
    expect(after).toMatchObject({ status: "ACTIVE", sendLeaseUntil: null, sendRunId: null });
    expect(after.lastOkAt).not.toBeNull();
    // Closed: its night is today's now (it was two days back).
    expect(after.lastNight!.getTime()).toBeGreaterThan(conn.lastNight!.getTime());
    expect(await night()).toMatchObject({ skipped: null, booked: 0, files: 0 });

    // Its SIE is never handed over (it would book twice); its list is.
    expect(await outcome(exportFile(admin(), file.id, "sie", WORDS))).toBe("NOT_FOUND");
    expect((await exportFile(admin(), file.id, "xlsx", WORDS)).bytes.byteLength).toBeGreaterThan(0);
  });

  it("the Bookkeeping page: what goes tonight, what is on its way, and each Fortnox file's numbers", async () => {
    await issued("300");
    const page = await readBookkeeping(admin());
    expect(page.fortnox).toMatchObject({ status: "ACTIVE", companyName: "Fnxs Konsult AB", broken: null, tonight: 1, waiting: 0 });
    // Make file has nothing of another company's to offer.
    expect(page.next?.count).toBe(0);
    const sent = page.files.find((x) => x.fortnox !== null);
    expect(sent).toMatchObject({ byNight: true, madeBy: null, fortnox: { vouchers: 2, booked: 2, done: 2, pdfsOwed: 0, waiting: 0, series: "F", from: 1, to: 2 } });
    await openNight();
    expect(await night()).toMatchObject({ booked: 1, files: 1 });
  });
});

describe("each company's sales only into its own books (§10.3)", () => {
  it("Make file takes another seller's entries only; the database refuses the connected company's in a download file", async () => {
    const ours = await issued("400");
    // The company card changes: a later invoice is ANOTHER company's (a sole trader turned company, say).
    await updateCompanyDetails(owner(), { orgNr: OTHER_ORG, vatNumber: "SE559100000401" });
    let theirs: string;
    try {
      theirs = await issued("500");
    } finally {
      await updateCompanyDetails(owner(), { orgNr: ORG, vatNumber: "SE556016068001" });
    }
    const page = await readBookkeeping(admin());
    expect(page.fortnox?.tonight).toBe(1);
    expect(page.next?.count).toBe(1);
    const made = await createExport(admin());
    const entries = await f.platform.invoiceExportEntry.findMany({ where: { exportId: made.id } });
    expect(entries.map((e) => e.invoiceId)).toEqual([theirs]);
    expect(await f.platform.invoiceExport.findUniqueOrThrow({ where: { id: made.id } })).toMatchObject({ destination: "DOWNLOAD", connectionId: null });
    expect(await outcome(createExport(admin()))).toBe("INVOICE_EXPORT_EMPTY");

    // The connected company's entry in a member's download file: refused by the database.
    const doc = await f.platform.invoice.findUniqueOrThrow({ where: { id: ours } });
    expect(
      await refusal(
        withTenant(f.tenantId, { type: "member", id: f.seats.admin.memberId }, async (tx) => {
          await tx.$executeRaw`SELECT invoice_export_lock(${f.tenantId})`;
          const file = await tx.invoiceExport.create({
            data: { tenantId: f.tenantId, number: 0, method: "INVOICE", series: "F", madeOn: new Date(), createdByMemberId: f.seats.admin.memberId },
            select: { id: true },
          });
          await tx.invoiceExportEntry.create({
            data: {
              tenantId: f.tenantId,
              exportId: file.id,
              invoiceId: ours,
              position: 1,
              event: "ISSUE",
              bookedOn: doc.issueDate!,
              voucher: { text: "Faktura", rows: [{ account: "1510", amount: "500.00" }, { account: "3001", amount: "-500.00" }] },
              detail: { amounts: {} },
            },
          });
        }),
      ),
    ).toBe("INVOICE_EXPORT_ENTRY_GUARD");

    // The night sends ours, and leaves theirs (already in its download file) alone.
    await openNight();
    expect(await night()).toMatchObject({ booked: 1, files: 1, stopped: null });
  });
});

describe("the database's rules for the night", () => {
  it("the night's file and its lock only behind the sender's GUC; never a year end; a member's Fortnox file only a year end", async () => {
    const conn = await connection();
    const file = (who: { memberId?: string | null; destination?: "DOWNLOAD" | "FORTNOX"; yearEnd?: Date }) => ({
      tenantId: f.tenantId,
      number: 0,
      method: "INVOICE" as const,
      series: "F",
      madeOn: new Date(),
      createdByMemberId: who.memberId ?? null,
      destination: who.destination ?? "FORTNOX",
      ...((who.destination ?? "FORTNOX") === "FORTNOX" ? { connectionId: conn.id } : {}),
      ...(who.yearEnd ? { yearEnd: who.yearEnd } : {}),
    });
    // SYSTEM without the GUC: the lock refuses it, and so does the guard.
    expect(await refusal(withTenant(f.tenantId, { type: "system" }, (tx) => tx.$executeRaw`SELECT invoice_export_lock(${f.tenantId})`))).toBe("INVOICE_EXPORT_LOCK");
    expect(await refusal(withTenant(f.tenantId, { type: "system" }, (tx) => tx.invoiceExport.create({ data: file({}) })))).toBe("INVOICE_EXPORT_GUARD");
    // With it: never a download file, a member's, or a year end.
    expect(await refusal(asSender((tx) => tx.invoiceExport.create({ data: file({ destination: "DOWNLOAD" }) })))).toBe("INVOICE_EXPORT_GUARD");
    expect(await refusal(asSender((tx) => tx.invoiceExport.create({ data: file({ memberId: f.seats.admin.memberId }) })))).toBe("INVOICE_EXPORT_GUARD");
    expect(await refusal(asSender((tx) => tx.invoiceExport.create({ data: file({ yearEnd: new Date("2025-12-31T00:00:00Z") }) })))).toMatch(
      /INVOICE_EXPORT_GUARD|invoice_export_night_file/,
    );
    // A member's Fortnox file that is not a year end.
    expect(
      await refusal(
        withTenant(f.tenantId, { type: "member", id: f.seats.admin.memberId }, (tx) => tx.invoiceExport.create({ data: file({ memberId: f.seats.admin.memberId }) })),
      ),
    ).toBe("invoice_export_member_fortnox_year_end");
  });

  it("a Fortnox file's voucher is owed a delivery, made with it — the commit refuses one without", async () => {
    const id = await issued("600", { pdf: false });
    const conn = await connection();
    const doc = await f.platform.invoice.findUniqueOrThrow({ where: { id } });
    // The night's file only under its own live lease (the pre-apply review's nit).
    expect(await refusal(asSender((tx) => makeFortnoxFile(tx, f.tenantId, { id: conn.id, org: orgDigitsOf(ORG)! }, new Date())))).toBe("INVOICE_EXPORT_GUARD");
    const run = randomUUID();
    expect(
      await refusal(
        withLease(run, () => asSender(async (tx) => {
          await tx.$executeRaw`SELECT invoice_export_lock(${f.tenantId})`;
          const file = await tx.invoiceExport.create({
            data: { tenantId: f.tenantId, number: 0, method: "INVOICE", series: "F", madeOn: new Date(), destination: "FORTNOX", connectionId: conn.id },
            select: { id: true },
          });
          await tx.invoiceExportEntry.create({
            data: {
              tenantId: f.tenantId,
              exportId: file.id,
              invoiceId: id,
              position: 1,
              event: "ISSUE",
              bookedOn: doc.issueDate!,
              voucher: { text: "Faktura", rows: [{ account: "1510", amount: "750.00" }, { account: "3001", amount: "-600.00" }, { account: "2611", amount: "-150.00" }] },
              detail: { amounts: {} },
            },
          });
          // The check is DEFERRED to the commit; asked now, so its refusal is
          // this statement's (a commit's error reaches the caller wrapped).
          await tx.$executeRaw`SET CONSTRAINTS invoice_export_entry_owed IMMEDIATE`;
        }, run)),
      ),
    ).toBe("INVOICE_EXPORT_ENTRY_OWED");
    // Nothing of it stayed.
    expect(await f.platform.invoiceExportEntry.count({ where: { tenantId: f.tenantId, invoiceId: id } })).toBe(0);
  });

  it("a delivery moves only under this run's live lease, forward only; a person's acts never while it is live", async () => {
    // A night's file with its deliveries QUEUED, made as the sender would — under its lease — and not sent.
    const conn = await connection();
    const run = randomUUID();
    const made = await withLease(run, () => asSender((tx) => makeFortnoxFile(tx, f.tenantId, { id: conn.id, org: orgDigitsOf(ORG)! }, new Date()), run));
    expect(made).not.toBeNull();
    const [d] = await deliveriesOf(made!.id);
    expect(d).toMatchObject({ state: "QUEUED", fortnoxNumber: null });
    const move = (data: Record<string, unknown>, by?: string) =>
      refusal(asSender((tx) => tx.invoiceExportDelivery.update({ where: { id: d!.id }, data, select: { id: true } }), by));
    const asPerson = (memberId: string, data: Record<string, unknown>) =>
      refusal(withTenant(f.tenantId, { type: "member", id: memberId }, (tx) => tx.invoiceExportDelivery.update({ where: { id: d!.id }, data, select: { id: true } })));
    const byHand = (memberId: string) => asPerson(memberId, { state: "BY_HAND", handledByMemberId: memberId });

    // No run, or a run that holds no lease.
    expect(await move({ state: "SENDING", fortnoxNextBefore: 9 })).toBe("INVOICE_EXPORT_DELIVERY_GUARD");
    expect(await move({ state: "SENDING", fortnoxNextBefore: 9 }, run)).toBe("INVOICE_EXPORT_DELIVERY_GUARD");
    await withLease(run, async () => {
      // A person, while the lease is live: "Fortleva is sending right now".
      expect(await byHand(f.seats.admin.memberId)).toBe("INVOICE_EXPORT_DELIVERY_GUARD");
      // Asked of Fortnox, with where a reconcile would look.
      expect(await move({ state: "SENDING", fortnoxNextBefore: 9 }, run)).toBe("ok");
    });
    // An unanswered voucher, the lease gone: while connected it is the sender's
    // to reconcile — a person decides it only after a disconnect (the pre-apply
    // review's medium: "not in Fortnox" would have it asked twice).
    expect(await asPerson(f.seats.admin.memberId, { state: "QUEUED", fortnoxNextBefore: null })).toBe("INVOICE_EXPORT_DELIVERY_GUARD");
    expect(await asPerson(f.seats.admin.memberId, { state: "BY_HAND", handledByMemberId: f.seats.admin.memberId, fortnoxNextBefore: null })).toBe(
      "INVOICE_EXPORT_DELIVERY_GUARD",
    );
    await withLease(run, async () => {
      // Forward: BOOKED — in the file's own series only — and never back.
      expect(await move({ state: "BOOKED", fortnoxYear: 1, fortnoxSeries: "A", fortnoxNumber: 9, fortnoxNextBefore: null }, run)).toBe("INVOICE_EXPORT_DELIVERY_GUARD");
      expect(await move({ state: "BOOKED", fortnoxYear: 1, fortnoxSeries: "F", fortnoxNumber: 99, fortnoxNextBefore: null }, run)).toBe("ok");
      expect(await move({ state: "QUEUED" }, run)).toBe("INVOICE_EXPORT_DELIVERY_GUARD");
      expect(await move({ fortnoxNumber: 98 }, run)).toBe("INVOICE_EXPORT_DELIVERY_GUARD");
      // DONE only with every PDF it owes connected.
      expect(await move({ state: "DONE" }, run)).toBe("INVOICE_EXPORT_DELIVERY_GUARD");
    });
    // The lease gone: a person who may export marks it booked by hand — an employee may not.
    expect(
      await refusal(
        withTenant(f.tenantId, { type: "member", id: f.seats.employee.memberId }, (tx) =>
          tx.invoiceExportDelivery.update({ where: { id: d!.id }, data: { state: "BY_HAND", handledByMemberId: f.seats.employee.memberId }, select: { id: true } }),
        ),
      ),
    ).toBe("INVOICE_EXPORT_DELIVERY_GUARD");
    expect(
      await refusal(
        withTenant(f.tenantId, { type: "member", id: f.seats.admin.memberId }, (tx) =>
          tx.invoiceExportDelivery.update({ where: { id: d!.id }, data: { state: "BY_HAND", handledByMemberId: f.seats.admin.memberId }, select: { id: true } }),
        ),
      ),
    ).toBe("ok");
    // History: never changed again, never deleted by the app.
    expect(await move({ state: "DONE" }, run)).toBe("INVOICE_EXPORT_DELIVERY_GUARD");
    expect(
      await refusal(withTenant(f.tenantId, { type: "member", id: f.seats.admin.memberId }, (tx) => tx.invoiceExportDelivery.delete({ where: { id: d!.id } }))),
    ).toBe("permission denied");
    // Its file's other vouchers (if any) go with the next run.
    await night();
  });
});

describe("when Fortnox does not answer as hoped", () => {
  it("an UNKNOWN answer is reconciled by number: one voucher in Fortnox, booked with its number, never two", async () => {
    const id = await issued("700");
    await openNight();
    fake({ loseNextVoucherAnswer: true });
    expect(await night()).toMatchObject({ booked: 0, files: 1, stopped: null });
    const [d] = await f.platform.invoiceExportDelivery.findMany({ where: { tenantId: f.tenantId, entry: { invoiceId: id } } });
    expect(d).toMatchObject({ state: "SENDING", fortnoxNumber: null });
    expect(d!.fortnoxNextBefore).not.toBeNull();
    const marker = `Fortleva ${d!.entryId}`;
    expect(readFakeCompany(companyTenantId)!.vouchers!.filter((v) => v.comments === marker)).toHaveLength(1);
    // Too young to reconcile: the line waits.
    expect(await night()).toMatchObject({ booked: 0 });
    expect((await f.platform.invoiceExportDelivery.findUniqueOrThrow({ where: { id: d!.id } })).state).toBe("SENDING");
    // Three minutes on: found by its number, booked, its PDF attached — and still one voucher.
    expect(await night(new Date(Date.now() + 3 * 60_000))).toMatchObject({ booked: 1, stopped: null });
    const after = await f.platform.invoiceExportDelivery.findUniqueOrThrow({ where: { id: d!.id } });
    const voucher = readFakeCompany(companyTenantId)!.vouchers!.filter((v) => v.comments === marker);
    expect(voucher).toHaveLength(1);
    expect(after).toMatchObject({ state: "DONE", fortnoxSeries: "F", fortnoxNumber: voucher[0]!.number, fortnoxNextBefore: null });
  });

  it("a refusal stops the line IN ORDER, BROKEN once with the reason; later runs keep quiet; it is restored when it goes", async () => {
    const x = await issued("800");
    const y = await issued("900");
    await openNight();
    const conn = await connection();
    const brokenBefore = (await f.audits("integration.broken")).length;
    const restoredBefore = (await f.audits("integration.restored")).length;
    fake({ lockedThrough: "2999-12-31" });
    const first = await night();
    expect(first).toMatchObject({ booked: 0, files: 1 });
    expect(first.stopped).toMatchObject({ kind: "REFUSED", code: "2000106", message: "Perioden är låst" });
    const dx = await f.platform.invoiceExportDelivery.findFirstOrThrow({ where: { tenantId: f.tenantId, entry: { invoiceId: x } } });
    const dy = await f.platform.invoiceExportDelivery.findFirstOrThrow({ where: { tenantId: f.tenantId, entry: { invoiceId: y } } });
    // The first back in the queue (refused for certain); the second never asked.
    expect([dx.state, dy.state, dy.attemptedAt]).toEqual(["QUEUED", "QUEUED", null]);
    const broken = await connection();
    expect(broken).toMatchObject({ status: "BROKEN" });
    expect(broken.brokenReason).toMatchObject({ kind: "REFUSED", code: "2000106", message: "Perioden är låst", entryId: dx.entryId });
    expect((await f.audits("integration.broken")).length).toBe(brokenBefore + 1);
    // Still refused: the reason stands, no second notice of breaking.
    expect((await night()).stopped).toMatchObject({ kind: "REFUSED" });
    expect((await f.audits("integration.broken")).length).toBe(brokenBefore + 1);
    expect((await connection()).brokenSince?.getTime()).toBe(broken.brokenSince?.getTime());
    // Fortnox opened again: both go, in order, and it is ACTIVE.
    fake({ lockedThrough: undefined });
    expect(await night()).toMatchObject({ booked: 2, stopped: null });
    const [nx, ny] = await Promise.all([
      f.platform.invoiceExportDelivery.findUniqueOrThrow({ where: { id: dx.id } }),
      f.platform.invoiceExportDelivery.findUniqueOrThrow({ where: { id: dy.id } }),
    ]);
    expect(nx.fortnoxNumber! < ny.fortnoxNumber!).toBe(true);
    expect(await connection()).toMatchObject({ id: conn.id, status: "ACTIVE", brokenSince: null, brokenReason: null });
    expect((await f.audits("integration.restored")).length).toBe(restoredBefore + 1);
  });

  it("no financial year for an entry's day stops the line until Fortnox has one", async () => {
    await issued("110");
    await openNight();
    const company = readFakeCompany(companyTenantId)!;
    fake({ years: [] });
    try {
      const r = await night();
      expect(r.stopped).toMatchObject({ kind: "NO_FINANCIAL_YEAR" });
      expect(r.stopped?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally {
      fake({ years: company.years });
    }
    expect(await night()).toMatchObject({ booked: 1, stopped: null });
    expect((await connection()).status).toBe("ACTIVE");
  });

  it("an answer Fortleva cannot read is a stop to see at once; Fortnox unreachable stays quiet — until no run has reached it for a day", async () => {
    // Unreadable: NOT_ANSWERING now (it would repeat every run — the code review's medium).
    fake({ unreadable: true });
    try {
      expect((await night()).stopped).toMatchObject({ kind: "NOT_ANSWERING" });
      expect(await connection()).toMatchObject({ status: "BROKEN", brokenReason: { kind: "NOT_ANSWERING" } });
    } finally {
      fake({ unreadable: undefined });
    }
    expect(await night()).toMatchObject({ stopped: null });
    expect((await connection()).status).toBe("ACTIVE");
    // Unreachable: quiet, the state left as it is…
    fake({ unreachable: true });
    try {
      expect(await night()).toMatchObject({ booked: 0, stopped: null });
      expect((await connection()).status).toBe("ACTIVE");
      // …until a day has passed with no run reaching Fortnox (the security review's 1).
      expect((await night(new Date(Date.now() + 25 * 3_600_000))).stopped).toMatchObject({ kind: "NOT_ANSWERING" });
      expect((await connection()).status).toBe("BROKEN");
    } finally {
      fake({ unreachable: undefined });
    }
    expect(await night()).toMatchObject({ stopped: null });
    expect((await connection()).status).toBe("ACTIVE");
  });

  it("a voucher booked before its PDF exists: attached on a later run; owed past a day, reported — and restored, not flapping", async () => {
    const id = await issued("120", { pdf: false });
    await openNight();
    expect(await night()).toMatchObject({ booked: 1, attached: 0, stopped: null });
    const d = await f.platform.invoiceExportDelivery.findFirstOrThrow({ where: { tenantId: f.tenantId, entry: { invoiceId: id } } });
    expect(d.state).toBe("BOOKED");
    // A day on, still no PDF: reported, BROKEN.
    const later = new Date(Date.now() + 25 * 3_600_000);
    expect((await night(later)).stopped).toMatchObject({ kind: "PDF_MISSING", entryId: d.entryId });
    expect((await connection()).status).toBe("BROKEN");
    // The PDF made: attached, DONE, and the connection taken back.
    await ensureInvoicePdf(admin(), id);
    expect(await night(later)).toMatchObject({ attached: 1, stopped: null });
    expect((await f.platform.invoiceExportDelivery.findUniqueOrThrow({ where: { id: d.id } })).state).toBe("DONE");
    expect((await connection()).status).toBe("ACTIVE");
  });
});

describe("what only a person mends", () => {
  it("a consent removed in Fortnox stops it for good: later runs never try; a disconnect sends nothing", async () => {
    await issued("130");
    await openNight();
    fake({ consentRevoked: true });
    expect((await night()).stopped).toMatchObject({ kind: "CONSENT_GONE" });
    expect(await connection()).toMatchObject({ status: "BROKEN", brokenReason: { kind: "CONSENT_GONE" } });
    // Even with the consent back (another workspace's, say), only a person's reconnect revives it.
    fake({ consentRevoked: false });
    expect(await night()).toMatchObject({ skipped: "stopped" });
    expect((await connection()).sendRunId).toBeNull();
    // Disconnected: nothing is sent at all.
    await disconnectFortnox(owner());
    expect(await night()).toMatchObject({ skipped: "none" });
  });
});
