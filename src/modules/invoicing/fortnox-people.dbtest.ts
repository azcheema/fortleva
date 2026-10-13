import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { fakeCompanyTenantIdFor, fakeConsent, readFakeCompany, removeFakeCompany, setFakeCompany } from "@/integrations/fortnox/fake";
import { DomainError } from "@/lib/domain-error";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { listInbox } from "@/notify/inbox";
import { dueAt } from "@/notify/weekly-reminder";
import { readPreferences } from "@/preferences/service";
import { resetLocalLimiter } from "@/ratelimit";
import { LocalDiskTransport, setStorage } from "@/storage";

import { exportFile, makeFortnoxFile, readBookkeeping, updateBookkeepingSettings } from "./bookkeeping";
import { addLine, createDraft, updateLine } from "./drafts";
import { beginFortnoxConnect, completeFortnoxConnect, disconnectFortnox, readFortnoxCard } from "./fortnox-connection";
import { handOverUnsent, markFortnoxDelivery, readFortnoxNeeds } from "./fortnox-people";
import { sendToFortnox, tellOwners } from "./fortnox-send";
import { LIST_COLUMNS, LIST_EVENTS, type ListWords } from "./invoice-list";
import { issueInvoice } from "./issue";
import { orgDigitsOf } from "./org-digits";
import { ensureInvoicePdf } from "./pdf-store";
import { updateCompanyDetails, updatePaymentDetails } from "./seller";
import { setFirstInvoiceNumber } from "./series";
import { VAT_PROFILES } from "./vat";

/**
 * THE NIGHTLY SEND'S PEOPLE'S SIDE — against the real database, the real
 * `app_runtime` role and the FAKE Fortnox (Phase 4 slice 114c; founder
 * decisions C89 (c), (e) and C90; migration 20261021090000_fortnox_people;
 * the design's §14):
 *   - a stop is told to the OWNERS once — inbox, and mail as their level
 *     allows — then every Monday while it lasts, once a week; a stop only a
 *     reconnect mends is still told and reminded; when it works again the
 *     owners who were told get a note, no mail; the inbox names the company
 *     and links to the Bookkeeping page under the reader's own codes;
 *   - the database stamps `stop_told_at` itself, never lets it go back to
 *     NULL, and lets only the sender write it;
 *   - Booked by hand: only the entry the line stopped at while connected,
 *     moving the line on; never under a live lease; never by a non-exporter;
 *     a PDF a day overdue attached by hand;
 *   - after a disconnect: Not in Fortnox, Booked by hand, and the hand-over —
 *     refused while an entry may be in Fortnox, while an older file waits,
 *     or when the count changed — then the SIE of just those, the same bytes
 *     every time; a later connection never sends them (C90 (c)).
 *
 * Tenant slug prefix `fnxp-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

vi.setConfig({ testTimeout: 240_000 });

type Fixture = Awaited<ReturnType<typeof setupTenant>>;

const ORG = "556016-0680";

let f: Fixture;
let clientId: string;
let companyTenantId: string;
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-fortnox-people-"));

const ctxOf = (memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });
const owner = () => ctxOf(f.seats.owner.memberId);
const admin = () => ctxOf(f.seats.admin.memberId);
const manager = () => ctxOf(f.seats.manager.memberId);
const employee = () => ctxOf(f.seats.employee.memberId);

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

/** A raw write's refusal by its guard's token — read from the error's META, never its message (memory `prisma-code-frame-trap`). */
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    const meta = JSON.stringify((e as { meta?: unknown })?.meta ?? {});
    const found = ["INTEGRATION_CONNECTION_GUARD", "INVOICE_EXPORT_DELIVERY_GUARD"].find((t) => meta.includes(t));
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

const night = (now?: Date) => sendToFortnox(f.tenantId, { deadline: Date.now() + 120_000, ...(now ? { now } : {}) });

/** The workspace's live connection, as the database holds it. */
const connection = () => f.platform.integrationConnection.findFirstOrThrow({ where: { tenantId: f.tenantId, status: { not: "DISCONNECTED" } } });

async function openNight(): Promise<void> {
  const c = await connection();
  await f.platform.integrationConnection.update({ where: { id: c.id }, data: { lastNight: new Date(Date.now() - 2 * 86_400_000) } });
}

const fake = (patch: Record<string, unknown>) => setFakeCompany({ ...readFakeCompany(companyTenantId)!, ...patch });

/** A SYSTEM transaction with the sender's GUC (and, when given, a run id). */
const asSender = <T>(fn: (tx: TenantDb) => Promise<T>, run?: string) =>
  withTenant(f.tenantId, { type: "system" }, async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.fortnox_sending', 'on', true)`;
    if (run) await tx.$executeRaw`SELECT set_config('app.fortnox_run', ${run}, true)`;
    return fn(tx);
  });

async function withLease<T>(run: string, fn: () => Promise<T>): Promise<T> {
  const conn = await connection();
  await asSender((tx) => tx.$executeRaw`UPDATE integration_connection SET send_lease_until = now() + interval '5 minutes', send_run_id = ${run} WHERE id = ${conn.id}`);
  try {
    return await fn();
  } finally {
    await asSender((tx) => tx.$executeRaw`UPDATE integration_connection SET send_lease_until = NULL, send_run_id = NULL WHERE id = ${conn.id} AND status <> 'DISCONNECTED'`);
  }
}

const deliveryOf = (invoiceId: string) => f.platform.invoiceExportDelivery.findFirstOrThrow({ where: { tenantId: f.tenantId, entry: { invoiceId } } });

/** The inbox rows of one kind, oldest first. */
const notes = (kind: string) => f.platform.notification.findMany({ where: { tenantId: f.tenantId, kind }, orderBy: { id: "asc" } });
/** The mails of one kind. */
const mails = (kind: string) => f.platform.emailOutbox.findMany({ where: { tenantId: f.tenantId, kind } });

/** A member's email level (C90 (a): the owners are mailed as their level allows). */
async function setLevel(memberId: string, emailLevel: "MENTIONS" | "PARTICIPATING"): Promise<void> {
  await f.platform.notificationPreference.upsert({
    where: { tenantId_receiverType_receiverId: { tenantId: f.tenantId, receiverType: "MEMBER", receiverId: memberId } },
    create: { tenantId: f.tenantId, receiverType: "MEMBER", receiverId: memberId, emailLevel },
    update: { emailLevel },
  });
}

/** Last week's Monday 08:00 in the workspace's zone — always in the past. */
async function lastMonday(): Promise<Date> {
  const zone = (await withTenant(f.tenantId, { type: "system" }, (tx) => readPreferences(tx, f.tenantId))).timezone;
  return dueAt(new Date(Date.now() - 7 * 86_400_000), zone, 1, 8)!.at;
}

const DAY = 86_400_000;

async function connect(): Promise<void> {
  resetLocalLimiter();
  const { url } = await beginFortnoxConnect(owner());
  const q = new URL(url).searchParams;
  const answer = fakeConsent({ companyTenantId: q.get("company")!, name: q.get("name")!, orgNr: q.get("org")!, codeChallenge: q.get("code_challenge")! });
  if (!("code" in answer)) throw new Error("the fake consent refused");
  const done = await completeFortnoxConnect(owner(), { state: q.get("state")!, code: answer.code, error: null });
  if (done.outcome !== "CONNECTED" && done.outcome !== "RECONNECTED") throw new Error(`connect: ${done.outcome}`);
}

let years: unknown;

beforeAll(async () => {
  setStorage(new LocalDiskTransport(storageDir));
  f = await setupTenant("fnxp");
  clientId = randomUUID();
  await f.platform.client.create({
    data: { id: clientId, tenantId: f.tenantId, name: "Fnxp Kund AB", orgNr: "556677-8899", addressLine1: "Gatan 1", postalCode: "111 22", city: "Stockholm", countryCode: "SE" },
  });
  await updateCompanyDetails(owner(), {
    legalName: "Fnxp Konsult AB",
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
  await setFirstInvoiceNumber(owner(), "7001");
  await updateBookkeepingSettings(owner(), { method: "INVOICE" });
  companyTenantId = fakeCompanyTenantIdFor(f.tenantId);
  removeFakeCompany(companyTenantId);
  await connect();
  years = readFakeCompany(companyTenantId)!.years;
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
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notificationPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 240_000);

// The two entries the first stop holds: `first` (where the line stops) and `second` (behind it).
let first: string;
let second: string;

describe("the owners told (C89 (c), (e); C90 (a), (b))", () => {
  it("a stop is told ONCE — an inbox row to each owner, a mail as their level allows; later runs keep quiet", async () => {
    first = await issued("100");
    second = await issued("200");
    await openNight();
    // Fortnox has no financial year: the line stops at the first entry, every run.
    fake({ years: [] });
    expect((await night()).stopped).toMatchObject({ kind: "NO_FINANCIAL_YEAR" });
    const c = await connection();
    expect(c.status).toBe("BROKEN");
    expect(c.stopToldAt).not.toBeNull();
    expect(c.stopToldAt!.getTime()).toBeGreaterThanOrEqual(c.brokenSince!.getTime());

    const told = await notes("integration.fortnox_stopped");
    expect(told.map((n) => [n.receiverId, n.reason, n.entityType, n.entityId, n.class])).toEqual([
      [f.seats.owner.memberId, "OWNER", "IntegrationConnection", c.id, "INSTANT"],
    ]);
    expect((await mails("integration.fortnox_stopped")).map((m) => m.receiverId)).toEqual([f.seats.owner.memberId]);

    // Later runs: still stopped — told no more.
    expect((await night()).stopped).toMatchObject({ kind: "NO_FINANCIAL_YEAR" });
    expect(await tellOwners(f.tenantId, c.id, randomUUID(), new Date())).toBeNull();
    expect(await notes("integration.fortnox_stopped")).toHaveLength(1);
    expect(await notes("integration.fortnox_still_stopped")).toHaveLength(0);

    // The owner's inbox names the company and opens the Bookkeeping page.
    const inbox = await listInbox(owner(), { filter: "unread" });
    const row = inbox.rows.find((r) => r.kind === "integration.fortnox_stopped");
    expect(row?.subject).toEqual({ title: c.companyName, href: "/invoices/bookkeeping" });
  });

  it("a reader without the invoices' codes is told something happened — no company, no link", async () => {
    const c = await connection();
    // A row of the same kind for the employee (the owners are the only receivers; planted to read it back).
    await f.platform.notification.create({
      data: {
        id: randomUUID(),
        tenantId: f.tenantId,
        receiverType: "MEMBER",
        receiverId: f.seats.employee.memberId,
        kind: "integration.fortnox_stopped",
        class: "INSTANT",
        entityType: "IntegrationConnection",
        entityId: c.id,
        reason: "OWNER",
      },
    });
    const row = (await listInbox(employee(), { filter: "unread" })).rows.find((r) => r.kind === "integration.fortnox_stopped");
    expect(row).toBeDefined();
    expect(row?.subject).toBeNull();
    // One who may see the invoices and the settings but not export them: the company, linked to the Settings card
    // (the Bookkeeping page would refuse them — the code review's L4).
    await f.platform.notification.create({
      data: {
        id: randomUUID(),
        tenantId: f.tenantId,
        receiverType: "MEMBER",
        receiverId: f.seats.manager.memberId,
        kind: "integration.fortnox_stopped",
        class: "INSTANT",
        entityType: "IntegrationConnection",
        entityId: c.id,
        reason: "OWNER",
      },
    });
    const managers = (await listInbox(manager(), { filter: "unread" })).rows.find((r) => r.kind === "integration.fortnox_stopped");
    expect(managers?.subject).toEqual({ title: c.companyName, href: "/settings/invoicing#fortnox" });
    await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId, receiverId: { in: [f.seats.employee.memberId, f.seats.manager.memberId] } } });
  });

  it("every Monday while it is still stopped — once a week, mailed as each owner's level allows", async () => {
    const c = await connection();
    const monday = await lastMonday();
    // Told well before that Monday — planted through the platform role (the guard does not judge it, so it does not stamp).
    await f.platform.integrationConnection.update({
      where: { id: c.id },
      data: { brokenSince: new Date(monday.getTime() - 4 * DAY), stopToldAt: new Date(monday.getTime() - 3 * DAY) },
    });
    // Before Monday 08:00: nothing.
    expect(await tellOwners(f.tenantId, c.id, randomUUID(), new Date(monday.getTime() - 60_000))).toBeNull();
    // An owner who turned email down to MENTIONS: the inbox row, no mail (C90 (a)).
    await setLevel(f.seats.owner.memberId, "MENTIONS");
    expect(await tellOwners(f.tenantId, c.id, randomUUID(), new Date(monday.getTime() + 3_600_000))).toBe("reminded");
    expect(await notes("integration.fortnox_still_stopped")).toHaveLength(1);
    expect(await mails("integration.fortnox_still_stopped")).toHaveLength(0);
    // Stamped by the DATABASE — told now — so the same week asks again for nothing.
    const after = await connection();
    expect(after.stopToldAt!.getTime()).toBeGreaterThan(Date.now() - 5 * 60_000);
    expect(await tellOwners(f.tenantId, c.id, randomUUID(), new Date(monday.getTime() + 2 * 3_600_000))).toBeNull();
    // A week on, the level back: a RUN reminds again (the run's own telling, after it settles — the code
    // review's L4) — a new row even over the unread one, and mailed.
    await setLevel(f.seats.owner.memberId, "PARTICIPATING");
    await f.platform.integrationConnection.update({ where: { id: c.id }, data: { stopToldAt: new Date(monday.getTime() + 3_600_000) } });
    expect((await night(new Date(monday.getTime() + 7 * DAY + 3_600_000))).stopped).toMatchObject({ kind: "NO_FINANCIAL_YEAR" });
    expect(await notes("integration.fortnox_still_stopped")).toHaveLength(2);
    expect((await mails("integration.fortnox_still_stopped")).map((m) => m.receiverId)).toEqual([f.seats.owner.memberId]);
    // Never the first notice again for the same breakage.
    expect(await notes("integration.fortnox_stopped")).toHaveLength(1);
  });

  it("the database stamps when the owners were told, never lets it go back, and lets only the sender write it", async () => {
    const c = await connection();
    // The sender's write is stamped with the database's own clock, whatever it says.
    await asSender((tx) => tx.$executeRaw`UPDATE integration_connection SET stop_told_at = '2001-01-01T00:00:00Z' WHERE id = ${c.id}`);
    expect((await connection()).stopToldAt!.getTime()).toBeGreaterThan(Date.now() - 5 * 60_000);
    // Never back to NULL (the pre-apply review's low 1).
    expect(await refusal(asSender((tx) => tx.$executeRaw`UPDATE integration_connection SET stop_told_at = NULL WHERE id = ${c.id}`))).toBe("INTEGRATION_CONNECTION_GUARD");
    // SYSTEM without the sender's GUC, and a member — even one who may connect — never write it.
    expect(
      await refusal(withTenant(f.tenantId, { type: "system" }, (tx) => tx.$executeRaw`UPDATE integration_connection SET stop_told_at = now() WHERE id = ${c.id}`)),
    ).toBe("INTEGRATION_CONNECTION_GUARD");
    expect(
      await refusal(
        withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, (tx) => tx.$executeRaw`UPDATE integration_connection SET stop_told_at = now() WHERE id = ${c.id}`),
      ),
    ).toBe("INTEGRATION_CONNECTION_GUARD");
  });
});

describe("booked by hand while connected", () => {
  it("only the entry the line stopped at — never under a live lease, never by a non-exporter — and the line moves on", async () => {
    const head = await deliveryOf(first);
    const behind = await deliveryOf(second);
    expect([head.state, behind.state]).toEqual(["QUEUED", "QUEUED"]);

    // The page offers exactly the stopped entry.
    const needs = await readFortnoxNeeds(admin());
    expect(needs.rows.map((n) => [n.deliveryId, n.state, n.disconnected, n.acts])).toEqual([[head.id, "QUEUED", false, ["BY_HAND"]]]);
    expect(needs.unsent).toEqual([]);

    // Not the entry behind it: Fortleva still sends that by itself.
    expect(await outcome(markFortnoxDelivery(admin(), behind.id, "BY_HAND"))).toBe("FORTNOX_ENTRY_NOT_STUCK");
    // Not "not in Fortnox": that is for an unanswered voucher after a disconnect.
    expect(await outcome(markFortnoxDelivery(admin(), head.id, "NOT_IN_FORTNOX"))).toBe("FORTNOX_ENTRY_NOT_STUCK");
    // Not by someone who may not export invoices; not under impersonation; not an act that is neither.
    expect(await outcome(markFortnoxDelivery(employee(), head.id, "BY_HAND"))).toBe("FORBIDDEN");
    expect(await outcome(markFortnoxDelivery({ tenantId: f.tenantId, actor: { ...actorFor(f.seats.admin.memberId), impersonated: true } }, head.id, "BY_HAND"))).toBe(
      "FORBIDDEN",
    );
    expect(await outcome(markFortnoxDelivery(admin(), head.id, "DOWNLOADED"))).toBe("NOT_FOUND");
    // Not while the nightly send holds the connection — and the database says so too.
    const run = randomUUID();
    await withLease(run, async () => {
      expect(await outcome(markFortnoxDelivery(admin(), head.id, "BY_HAND"))).toBe("FORTNOX_BUSY");
      expect(
        await refusal(
          withTenant(f.tenantId, { type: "member", id: f.seats.admin.memberId }, (tx) =>
            tx.invoiceExportDelivery.update({ where: { id: head.id }, data: { state: "BY_HAND", handledByMemberId: f.seats.admin.memberId }, select: { id: true } }),
          ),
        ),
      ).toBe("INVOICE_EXPORT_DELIVERY_GUARD");
    });
    expect((await deliveryOf(first)).state).toBe("QUEUED");

    // Booked by hand: theirs, dated, audited.
    await markFortnoxDelivery(admin(), head.id, "BY_HAND");
    const marked = await deliveryOf(first);
    expect(marked).toMatchObject({ state: "BY_HAND", handledByMemberId: f.seats.admin.memberId, fortnoxNumber: null });
    expect(marked.handledAt).not.toBeNull();
    const audited = (await f.audits("invoice_export.entry_booked_by_hand")).at(-1)!;
    expect(audited).toMatchObject({ actorType: "MEMBER", actorId: f.seats.admin.memberId, targetId: head.exportId });
    expect(audited.metadata).toMatchObject({ entryId: head.entryId, event: "ISSUE", was: "QUEUED" });
    // Decided: never again.
    expect(await outcome(markFortnoxDelivery(admin(), head.id, "BY_HAND"))).toBe("FORTNOX_ENTRY_DECIDED");

    // The line moves on: the next run stops at the entry behind it (still no year)…
    expect((await night()).stopped).toMatchObject({ kind: "NO_FINANCIAL_YEAR", entryId: behind.entryId });
    // …and once Fortnox has its year, books it and is restored — the owners, who were told, get a note, no mail (C90 (b)).
    fake({ years });
    const r = await night();
    expect(r).toMatchObject({ booked: 1, stopped: null });
    expect((await connection()).status).toBe("ACTIVE");
    expect((await deliveryOf(second)).state).toBe("DONE");
    const restored = await notes("integration.fortnox_restored");
    expect(restored.map((n) => [n.receiverId, n.reason, n.class])).toEqual([[f.seats.owner.memberId, "OWNER", "COALESCED"]]);
    expect(await mails("integration.fortnox_restored")).toHaveLength(0);
    // The file's line counts the one booked by hand.
    const page = await readBookkeeping(admin());
    const file = page.files.find((x) => x.id === head.exportId)!;
    expect(file.fortnox).toMatchObject({ vouchers: 2, byHand: 1, waiting: 0, live: true });
  });

  it("a voucher in Fortnox whose PDF never attached: a person's a day on, not before", async () => {
    const id = await issued("300", { pdf: false });
    await openNight();
    expect(await night()).toMatchObject({ booked: 1, attached: 0 });
    const d = await deliveryOf(id);
    expect(d.state).toBe("BOOKED");
    expect((await readFortnoxNeeds(admin())).rows.map((n) => n.deliveryId)).not.toContain(d.id);
    expect(await outcome(markFortnoxDelivery(admin(), d.id, "BY_HAND"))).toBe("FORTNOX_ENTRY_NOT_STUCK");
    const later = new Date(Date.now() + 25 * 3_600_000);
    const need = (await readFortnoxNeeds(admin(), { now: later })).rows.find((n) => n.deliveryId === d.id);
    expect(need).toMatchObject({ state: "BOOKED", acts: ["BY_HAND"], voucher: { series: "F", number: d.fortnoxNumber } });
    await markFortnoxDelivery(admin(), d.id, "BY_HAND", { now: later });
    // Fortnox's voucher kept: it is in its books, its PDF attached there.
    expect(await deliveryOf(id)).toMatchObject({ state: "BY_HAND", fortnoxNumber: d.fortnoxNumber, fortnoxSeries: "F" });
    expect((await f.audits("invoice_export.entry_booked_by_hand")).at(-1)!.metadata).toMatchObject({ entryId: d.entryId, was: "BOOKED" });
    // The night booked it: its file says "In Fortnox: F n" — never "booked by hand" (the code review's L3).
    const file = (await readBookkeeping(admin())).files.find((x) => x.id === d.exportId)!;
    expect(file.fortnox).toMatchObject({ byHand: 0, from: d.fortnoxNumber, to: d.fortnoxNumber, pdfsOwed: 0 });
  });

  it("a stop only a reconnect mends is still told and reminded, though nothing is tried; one never told and gone by itself says nothing", async () => {
    const c = await connection();
    const monday = await lastMonday();
    const stoppedBefore = (await notes("integration.fortnox_stopped")).length;
    const stillBefore = (await notes("integration.fortnox_still_stopped")).length;
    const restoredBefore = (await notes("integration.fortnox_restored")).length;
    // A breakage of its own (the Monday test's began four days before that Monday: a reminder is per breakage and week).
    await f.platform.$executeRaw`
      UPDATE integration_connection
         SET status = 'BROKEN', broken_since = ${new Date(monday.getTime() - 6 * DAY)}, broken_reason = '{"kind":"CONSENT_GONE"}'::jsonb
       WHERE id = ${c.id}`;
    // Never told of THIS breakage: the last telling came before it began.
    await f.platform.$executeRaw`UPDATE integration_connection SET stop_told_at = ${new Date(monday.getTime() - 7 * DAY)} WHERE id = ${c.id}`;
    expect(await night()).toMatchObject({ skipped: "stopped" });
    expect(await notes("integration.fortnox_stopped")).toHaveLength(stoppedBefore + 1);
    // A Monday on: reminded — still nothing tried.
    await f.platform.$executeRaw`UPDATE integration_connection SET stop_told_at = ${new Date(monday.getTime() - 5 * DAY)} WHERE id = ${c.id}`;
    expect(await sendToFortnox(f.tenantId, { deadline: Date.now() + 60_000, now: new Date(monday.getTime() + 3_600_000) })).toMatchObject({ skipped: "stopped" });
    expect(await notes("integration.fortnox_still_stopped")).toHaveLength(stillBefore + 1);

    // A retryable stop nobody was told of that a run clears by itself: no note either way.
    await f.platform.$executeRaw`
      UPDATE integration_connection
         SET broken_since = now() - interval '1 hour', broken_reason = '{"kind":"REFUSED"}'::jsonb, stop_told_at = now() - interval '2 hours'
       WHERE id = ${c.id}`;
    expect(await night()).toMatchObject({ stopped: null });
    expect((await connection()).status).toBe("ACTIVE");
    expect(await notes("integration.fortnox_restored")).toHaveLength(restoredBefore);
    expect(await notes("integration.fortnox_stopped")).toHaveLength(stoppedBefore + 1);
  });
});

describe("after a disconnect (C90 (c), (d))", () => {
  it("what was owed is a person's: Not in Fortnox, Booked by hand, and the hand-over — oldest first, the unsure decided first — then the SIE of just those, again and again", async () => {
    const a = await issued("410");
    const b = await issued("420");
    const c3 = await issued("430");
    await openNight();
    fake({ years: [] });
    expect((await night()).stopped).toMatchObject({ kind: "NO_FINANCIAL_YEAR" });
    const da = await deliveryOf(a);
    const fileOne = await f.platform.invoiceExport.findUniqueOrThrow({ where: { id: da.exportId } });
    // A second Fortnox file of the same connection while the first still owes (as a year end's would be),
    // and the first entry asked of Fortnox with no answer — both as the sender would, under its lease.
    const d4 = await issued("440");
    const conn = await connection();
    const run = randomUUID();
    await withLease(run, async () => {
      await asSender((tx) => makeFortnoxFile(tx, f.tenantId, { id: conn.id, org: orgDigitsOf(ORG)! }, new Date()), run);
      await asSender((tx) => tx.invoiceExportDelivery.update({ where: { id: da.id }, data: { state: "SENDING", fortnoxNextBefore: 5 }, select: { id: true } }), run);
    });
    const dd = await deliveryOf(d4);
    const fileTwo = await f.platform.invoiceExport.findUniqueOrThrow({ where: { id: dd.exportId } });
    expect(fileTwo.number).toBeGreaterThan(fileOne.number);

    // While connected, the unanswered one is the sender's — never a person's (114b's pre-apply medium).
    expect(await outcome(markFortnoxDelivery(admin(), da.id, "NOT_IN_FORTNOX"))).toBe("FORTNOX_ENTRY_NOT_STUCK");
    await disconnectFortnox(owner());

    const db = await deliveryOf(b);
    const dc = await deliveryOf(c3);
    const needs = await readFortnoxNeeds(admin());
    expect(needs.rows.map((n) => [n.deliveryId, n.state, n.disconnected, n.acts])).toEqual([
      [da.id, "SENDING", true, ["BY_HAND", "NOT_IN_FORTNOX"]],
      [db.id, "QUEUED", true, ["BY_HAND"]],
      [dc.id, "QUEUED", true, ["BY_HAND"]],
      [dd.id, "QUEUED", true, ["BY_HAND"]],
    ]);
    expect(needs.rows[0]!.lookIn).toEqual({ series: "F", from: 5, marker: `Fortleva ${da.entryId}` });
    expect(needs.unsent).toEqual([
      { exportId: fileOne.id, number: fileOne.number, queued: 2, unsure: 1, waitsFor: { kind: "UNSURE" } },
      // File one holds entries to DOWNLOAD (two queued), not only one to decide.
      { exportId: fileTwo.id, number: fileTwo.number, queued: 1, unsure: 0, waitsFor: { kind: "OLDER", number: fileOne.number, decide: false } },
    ]);
    // The Settings card says how many a disconnect left.
    expect((await readFortnoxCard(owner())).unsent).toBe(4);

    // Oldest first; the unsure one decided first.
    expect(await outcome(handOverUnsent(admin(), fileTwo.id, 1))).toBe("FORTNOX_OLDER_FIRST");
    expect(await outcome(handOverUnsent(admin(), fileOne.id, 2))).toBe("FORTNOX_UNSURE_FIRST");
    // Not in Fortnox: back with the entries never sent.
    await markFortnoxDelivery(admin(), da.id, "NOT_IN_FORTNOX");
    expect(await deliveryOf(a)).toMatchObject({ state: "QUEUED", fortnoxNextBefore: null });
    expect((await f.audits("invoice_export.entry_not_in_fortnox")).at(-1)!.metadata).toMatchObject({ entryId: da.entryId, was: "SENDING" });
    // The count shown no longer holds: three wait now.
    expect(await outcome(handOverUnsent(admin(), fileOne.id, 2))).toBe("FORTNOX_UNSENT_CHANGED");
    // One of them was booked by hand in Fortnox already.
    await markFortnoxDelivery(admin(), db.id, "BY_HAND");
    // Not by someone who may not export.
    expect(await outcome(handOverUnsent(employee(), fileOne.id, 2))).toBe("FORBIDDEN");

    expect(await handOverUnsent(admin(), fileOne.id, 2)).toEqual({ exportId: fileOne.id, number: fileOne.number, count: 2 });
    for (const id of [da.id, dc.id]) {
      expect(await f.platform.invoiceExportDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: "DOWNLOADED", handledByMemberId: f.seats.admin.memberId });
    }
    expect((await f.audits("invoice_export.unsent_downloaded")).at(-1)!.metadata).toMatchObject({ number: fileOne.number, entries: 2 });
    // Once only: nothing left to hand over in that file.
    expect(await outcome(handOverUnsent(admin(), fileOne.id, 2))).toBe("FORTNOX_UNSENT_CHANGED");

    // The SIE of just those two, the same bytes every time (C90 (d)); the file's own SIE never.
    const once = await exportFile(admin(), fileOne.id, "unsent", WORDS);
    const twice = await exportFile(admin(), fileOne.id, "unsent", WORDS);
    expect(createHash("sha256").update(twice.bytes).digest("hex")).toBe(createHash("sha256").update(once.bytes).digest("hex"));
    expect(Buffer.from(once.bytes).toString("latin1").match(/#VER /g)).toHaveLength(2);
    expect(once.fileName).toBe(`fortleva-fakt-${fileOne.number}-ej-skickade.si`);
    const downloads = (await f.audits("invoice_export.downloaded")).filter((r) => r.targetId === fileOne.id);
    expect(downloads.map((r) => (r.metadata as { format?: string }).format)).toEqual(["unsent", "unsent"]);
    expect(await outcome(exportFile(admin(), fileOne.id, "sie", WORDS))).toBe("NOT_FOUND");
    expect(await outcome(exportFile(admin(), fileTwo.id, "unsent", WORDS))).toBe("NOT_FOUND");

    // The files' lines say where each stands.
    const page = await readBookkeeping(admin());
    expect(page.files.find((x) => x.id === fileOne.id)!.fortnox).toMatchObject({ downloaded: 2, byHand: 1, waiting: 0, live: false });
    expect(page.files.find((x) => x.id === fileTwo.id)!.fortnox).toMatchObject({ waiting: 1, live: false });

    // Now the second file's turn.
    expect(await handOverUnsent(admin(), fileTwo.id, 1)).toMatchObject({ count: 1 });
    expect((await readFortnoxCard(owner())).unsent).toBe(0);

    // C90 (c): connected again — to the same company — nothing the disconnect left is ever sent.
    fake({ years });
    const before = readFakeCompany(companyTenantId)!.vouchers?.length ?? 0;
    await connect();
    await openNight();
    expect(await night()).toMatchObject({ booked: 0, files: 0, stopped: null });
    expect(readFakeCompany(companyTenantId)!.vouchers?.length ?? 0).toBe(before);
    for (const id of [da.id, db.id, dc.id, dd.id]) {
      expect((await f.platform.invoiceExportDelivery.findUniqueOrThrow({ where: { id } })).connectionId).toBe(conn.id);
    }
    expect((await connection()).id).not.toBe(conn.id);
  });
});

describe("who is told (C89 (c)) — LAST: it changes roles", () => {
  it("every ACTIVE owner — a second owner too; never a suspended owner, an admin or a manager", async () => {
    // The admin made an owner as well; the employee made an owner and then suspended.
    await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: f.seats.admin.memberId, roleId: f.roleId("owner") } });
    await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, roleId: f.roleId("owner") } });
    await f.platform.member.update({ where: { id: f.seats.employee.memberId }, data: { status: "SUSPENDED" } });
    const c = await connection();
    await f.platform.$executeRaw`
      UPDATE integration_connection
         SET status = 'BROKEN', broken_since = now() - interval '1 minute', broken_reason = '{"kind":"REFUSED"}'::jsonb, stop_told_at = NULL
       WHERE id = ${c.id}`;
    expect(await tellOwners(f.tenantId, c.id, randomUUID(), new Date())).toBe("stopped");
    const broke = await connection();
    const told = (await notes("integration.fortnox_stopped")).filter((n) => n.dedupeKey === `integration.fortnox_stopped:${c.id}:${broke.brokenSince!.toISOString()}`);
    expect(told.map((n) => n.receiverId).sort()).toEqual([f.seats.owner.memberId, f.seats.admin.memberId].sort());
    expect(told.every((n) => n.reason === "OWNER")).toBe(true);
  });
});
