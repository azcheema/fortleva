import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { withTenant, type TenantDb } from "@/db";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { setModuleEnabled } from "@/preferences/service";
import { moveRenewalDatesOn, type MoveFacts } from "@/services/renewals";
import { setAgreementRunning, updateService } from "@/services/service";

import { createDraft, LINE_TEXT_MAX, removeLine } from "./drafts";
import { readFixed } from "./money";
import { agreementHoldsDate } from "./renewal-plan";
import { draftRenewalInvoices } from "./renewals";

/**
 * RENEWALS THAT DRAFT AN INVOICE, against the real database and app_runtime
 * (Phase 4 slice 113b; founder decision C88; migration 20261018090000; the
 * design: docs/research/2026-10-12-slice-113-renewal-invoices-design.md §3,
 * §9.1):
 *   - THE DATABASE'S SYSTEM PATH: only under `app.renewal_drafting`, only a
 *     RENEWAL draft carrying nothing but its client's terms and period, only
 *     its period widened, never deleted, never issued; a line only naming a
 *     running agreement of the client at no more than its price, written in
 *     this transaction, once per period; a person never makes a renewal
 *     draft, never names an agreement on a line, never changes an origin;
 *   - THE JOB: 14 days before, not 15; one draft per client and currency;
 *     nothing for a paused, ended, switched-off, unpriced or archived
 *     client's agreement, nor for a period already started; an end inside
 *     the period prorated; a deleted line not drafted again; the people who
 *     may issue told in the inbox, no one else; nothing while invoicing is
 *     off; a second run changes nothing.
 *
 * It calls the per-tenant `draftRenewalInvoices` ONLY — never the job's
 * cross-tenant run (AGENTS.md). The clock is passed in: runs at 10:00 UTC.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
let gone: string;
/** The job's own client: the database tests above leave renewal drafts on Acme. */
let delta: string;

/** The EXCLUDE constraint: no day of one agreement on two lines (migration 20261018090000). */
const NO_DAY_TWICE = "invoice_line_no_day_twice";

const at = (day: string) => new Date(`${day}T10:00:00Z`);
const midnight = (day: string) => new Date(`${day}T00:00:00Z`);
const owner = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });
const manager = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.manager.memberId) });
const sys = <T,>(fn: (tx: TenantDb) => Promise<T>) => withTenant(f.tenantId, { type: "system" }, fn);
const drafting = <T,>(fn: (tx: TenantDb) => Promise<T>) =>
  sys(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.renewal_drafting', 'on', true)`;
    return fn(tx);
  });
const asMember = <T,>(memberId: string, fn: (tx: TenantDb) => Promise<T>) => withTenant(f.tenantId, { type: "member", id: memberId }, fn);

/** What the DATABASE said — its error meta, never the message (whose code frame quotes this file). */
const said = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    const meta = JSON.stringify((e as { meta?: unknown })?.meta ?? null);
    const guard = /(INVOICE_[A-Z_]+: [^"\\]+)/.exec(meta)?.[1];
    if (guard) return guard;
    if (meta.includes(NO_DAY_TWICE)) return NO_DAY_TWICE;
    return `unexpected: ${meta.slice(0, 300)}`;
  }
};

/** An agreement of `clientId`, written directly — its id. */
async function agreement(data: {
  clientId?: string;
  name?: string;
  price?: string | null;
  currency?: string | null;
  status?: "ACTIVE" | "PAUSED" | "ENDED";
  renews: string;
  ends?: string | null;
  interval?: "MONTHLY" | "QUARTERLY" | "YEARLY";
  invoiceRenewals?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await f.platform.service.create({
    data: {
      id,
      tenantId: f.tenantId,
      clientId: data.clientId ?? acme,
      name: data.name ?? `Agreement ${id.slice(0, 6)}`,
      kind: "RECURRING",
      billingInterval: data.interval ?? "MONTHLY",
      priceExVat: data.price === undefined ? "1000.00" : data.price,
      currency: data.currency === undefined ? "SEK" : data.currency,
      status: data.status ?? "ACTIVE",
      renewsAt: midnight(data.renews),
      endsAt: data.ends ? midnight(data.ends) : null,
      invoiceRenewals: data.invoiceRenewals ?? true,
    },
  });
  return id;
}

const linesOf = (serviceId: string) =>
  f.platform.invoiceLine.findMany({
    where: { tenantId: f.tenantId, serviceId },
    select: { invoiceId: true, description: true, quantity: true, unitPriceExVat: true, vatRatePct: true, servicePeriodStart: true, servicePeriodEnd: true },
    orderBy: { servicePeriodStart: "asc" },
  });
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

beforeAll(async () => {
  f = await setupTenant("rinv");
  [acme, beta, gone, delta] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme AB", countryCode: "SE" },
      { id: beta, tenantId: f.tenantId, name: "Beta AB", countryCode: "SE" },
      { id: gone, tenantId: f.tenantId, name: "Gone AB", countryCode: "SE", status: "ARCHIVED" },
      { id: delta, tenantId: f.tenantId, name: "Delta AB", countryCode: "SE" },
    ],
  });
  // The manager and the employee are Acme's and Delta's people; neither may issue invoices.
  await f.platform.memberClient.createMany({
    data: [acme, delta].flatMap((clientId) => [
      { tenantId: f.tenantId, memberId: f.seats.manager.memberId, clientId },
      { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId },
    ]),
  });
}, 120_000);

// Each test's agreements END with it: the tests never move dates on, and a
// drafted agreement whose date never moved is — rightly — caught up by the next
// run's drafting (`renewalsToDraft`), which would draft into later tests.
afterEach(async () => {
  if (!f) return;
  await f.platform.service.updateMany({ where: { tenantId: f.tenantId, status: { not: "ENDED" } }, data: { status: "ENDED" } });
});

afterAll(async () => {
  if (!f) return;
  const where = { where: { tenantId: f.tenantId } };
  await f.deleteInvoices();
  await f.platform.notification.deleteMany(where);
  await f.platform.service.deleteMany(where);
  await f.platform.memberClient.deleteMany(where);
  await f.platform.client.deleteMany(where);
  await f.platform.tenantPreference.deleteMany(where);
  await f.cleanup();
}, 120_000);

describe("the database's one system path for invoices", () => {
  const renewalDraft = (tx: TenantDb, over: Record<string, unknown> = {}) =>
    tx.invoice.create({
      data: { tenantId: f.tenantId, clientId: acme, origin: "RENEWAL", createdByMemberId: null, vatProfile: "SE_DOMESTIC", currency: "SEK", paymentTermsDays: 30, ...over },
      select: { id: true },
    });

  it("SYSTEM makes no draft without the renewal job's flag, nor a member's draft with it", async () => {
    expect(await said(sys((tx) => renewalDraft(tx)))).toContain("a member makes a draft");
    // With the flag, a member's draft is refused by the allow-list: it carries an origin and a maker.
    expect(await said(drafting((tx) => renewalDraft(tx, { origin: "MEMBER", createdByMemberId: f.seats.owner.memberId })))).toContain(
      "carries nothing but",
    );
  });

  it("a renewal draft carries nothing but its client's terms and its period — for an active client", async () => {
    expect(await said(drafting((tx) => renewalDraft(tx, { payLinkUrl: "https://buy.stripe.com/test_123" })))).toContain("carries nothing but");
    expect(await said(drafting((tx) => renewalDraft(tx, { note: "Pay to 123-4567" })))).toContain("carries nothing but");
    expect(await said(drafting((tx) => renewalDraft(tx, { ourReference: "Someone" })))).toContain("carries nothing but");
    expect(await said(drafting((tx) => renewalDraft(tx, { includeHours: true })))).toContain("carries nothing but");
    expect(await said(drafting((tx) => renewalDraft(tx, { clientId: gone })))).toContain("an active client");
    expect(await said(drafting((tx) => renewalDraft(tx, { periodStart: midnight("2031-01-01"), periodEnd: midnight("2031-01-31") })))).toBe("ok");
  });

  it("SYSTEM widens a renewal draft's period and nothing else, never a member's draft, never deletes, never issues", async () => {
    const { id } = await drafting((tx) => renewalDraft(tx));
    expect(await said(drafting((tx) => tx.$executeRaw`UPDATE invoice SET period_start = '2031-02-01', period_end = '2031-02-28' WHERE id = ${id}`))).toBe("ok");
    expect(await said(drafting((tx) => tx.$executeRaw`UPDATE invoice SET note = 'Pay elsewhere' WHERE id = ${id}`))).toContain("a member edits a draft");
    expect(await said(sys((tx) => tx.$executeRaw`UPDATE invoice SET period_end = '2031-03-31' WHERE id = ${id}`))).toContain("a member edits a draft");
    expect(await said(drafting((tx) => tx.$executeRaw`DELETE FROM invoice WHERE id = ${id}`))).toContain("deleted by a person");
    // Never issued: refused — by `invoice_guard` or a status guard that fires before it.
    expect(await said(drafting((tx) => tx.$executeRaw`UPDATE invoice SET status = 'ISSUED' WHERE id = ${id}`))).not.toBe("ok");
    expect((await f.platform.invoice.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("DRAFT");
    const mine = await createDraft(owner(), { clientId: acme });
    expect(await said(drafting((tx) => tx.$executeRaw`UPDATE invoice SET period_start = '2031-02-01' WHERE id = ${mine}`))).toContain(
      "a member edits a draft",
    );
    // A person deletes a renewal draft as any other.
    expect(await said(asMember(f.seats.owner.memberId, (tx) => tx.$executeRaw`DELETE FROM invoice WHERE id = ${id}`))).toBe("ok");
  });

  it("a person never makes a renewal draft, and an origin never changes", async () => {
    expect(
      await said(
        asMember(f.seats.owner.memberId, (tx) =>
          tx.invoice.create({
            data: { tenantId: f.tenantId, clientId: acme, origin: "RENEWAL", createdByMemberId: f.seats.owner.memberId, vatProfile: "SE_DOMESTIC", currency: "SEK", paymentTermsDays: 30 },
          }),
        ),
      ),
    ).not.toBe("ok");
    const mine = await createDraft(owner(), { clientId: acme });
    expect(await said(asMember(f.seats.owner.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET origin = 'RENEWAL' WHERE id = ${mine}`))).not.toBe("ok");
  });

  it("a renewal line names a running agreement of the client, at no more than its price, recorded as drafted in this transaction — once", async () => {
    const svc = await agreement({ name: "Svc", renews: "2032-01-01", price: "1000.00" });
    const other = await agreement({ name: "Svc", clientId: beta, renews: "2032-01-01" });
    const paused = await agreement({ name: "Svc", renews: "2032-01-01", status: "PAUSED" });
    const off = await agreement({ name: "Svc", renews: "2032-01-01", invoiceRenewals: false });
    /** A renewal line as the job writes it: the agreement's name and its days, exactly. */
    const line = (tx: TenantDb, invoiceId: string, serviceId: string, over: Record<string, unknown> = {}, days: [string, string] = ["2032-01-01", "2032-01-31"]) =>
      tx.invoiceLine.create({
        data: {
          tenantId: f.tenantId,
          clientId: acme,
          invoiceId,
          position: 1,
          description: `Svc, ${days[0]} – ${days[1]}`,
          quantity: "1.000",
          unitPriceExVat: "1000.00",
          vatRatePct: "25.00",
          amountExVat: "1000.00",
          serviceId,
          servicePeriodStart: midnight(days[0]),
          servicePeriodEnd: midnight(days[1]),
          ...over,
        },
        select: { id: true },
      });
    const mark = (tx: TenantDb, serviceId: string, through = "2032-01-31") =>
      tx.service.update({ where: { id: serviceId }, data: { invoicedThrough: midnight(through) }, select: { id: true } });
    const { id: draft } = await drafting((tx) => renewalDraft(tx));

    // Not recorded as drafted in this transaction.
    expect(await said(drafting((tx) => line(tx, draft, svc)))).toContain("just recorded as drafted");
    // Over its price; more than one period; another client's; paused; switched off.
    expect(await said(drafting(async (tx) => (await mark(tx, svc), line(tx, draft, svc, { unitPriceExVat: "1000.01", amountExVat: "1000.01" }))))).toContain(
      "no more than its agreement",
    );
    expect(await said(drafting(async (tx) => (await mark(tx, svc), line(tx, draft, svc, { quantity: "2.000", amountExVat: "2000.00" }))))).toContain(
      "no more than its agreement",
    );
    for (const bad of [other, paused, off]) {
      expect(await said(drafting(async (tx) => (await mark(tx, bad), line(tx, draft, bad))))).toContain("a running agreement of the invoice");
    }
    // No free text and no unit ride on a renewal line.
    expect(
      await said(drafting(async (tx) => (await mark(tx, svc), line(tx, draft, svc, { description: "Svc, 2032-01-01 – 2032-01-31. Pay to SE45 5000 0000 0583 9825 7466" })))),
    ).toContain("says its agreement and its days");
    expect(await said(drafting(async (tx) => (await mark(tx, svc), line(tx, draft, svc, { unit: "st" }))))).toContain("says its agreement and its days");
    // Right: recorded and added together.
    expect(await said(drafting(async (tx) => (await mark(tx, svc), line(tx, draft, svc))))).toBe("ok");
    // …once: no day of the agreement on two lines — the same period, or one overlapping it.
    expect(await said(drafting(async (tx) => (await mark(tx, svc), line(tx, draft, svc, { position: 2 }))))).toBe(NO_DAY_TWICE);
    expect(
      await said(drafting(async (tx) => (await mark(tx, svc, "2032-02-15"), line(tx, draft, svc, { position: 2 }, ["2032-01-15", "2032-02-15"])))),
    ).toBe(NO_DAY_TWICE);
    // SYSTEM never changes or removes a line.
    expect(await said(drafting((tx) => tx.$executeRaw`UPDATE invoice_line SET description = 'x' WHERE invoice_id = ${draft}`))).toContain(
      "only adds a renewal line",
    );
    expect(await said(drafting((tx) => tx.$executeRaw`DELETE FROM invoice_line WHERE invoice_id = ${draft}`))).toContain("only adds a renewal line");
    // Never onto a person's draft.
    const mine = await createDraft(owner(), { clientId: acme });
    expect(await said(drafting(async (tx) => (await mark(tx, svc, "2032-02-29"), line(tx, mine, svc, {}, ["2032-02-01", "2032-02-29"]))))).toContain(
      "only adds a renewal line",
    );
    // A person never names an agreement on a line, nor changes a renewal line's agreement or period.
    expect(await said(asMember(f.seats.owner.memberId, (tx) => line(tx, mine, svc, {}, ["2033-01-01", "2033-01-31"])))).toContain(
      "only when the renewal job drafted it",
    );
    expect(
      await said(asMember(f.seats.owner.memberId, (tx) => tx.$executeRaw`UPDATE invoice_line SET service_period_end = '2032-01-30' WHERE invoice_id = ${draft}`)),
    ).toContain("keeps its agreement and its period");
    // …but edits its text and price like any line of a draft.
    expect(
      await said(asMember(f.seats.owner.memberId, (tx) => tx.$executeRaw`UPDATE invoice_line SET description = 'Hosting, January' WHERE invoice_id = ${draft}`)),
    ).toBe("ok");
  });
});

describe("the renewal job", () => {
  it("drafts the coming period 14 days before — not 15 — onto ONE draft per client and currency, and tells the people who may issue it", async () => {
    const hosting = await agreement({ clientId: delta, name: "Hosting", renews: "2034-07-01", price: "1000.00" });
    const support = await agreement({ clientId: delta, name: "Support", renews: "2034-07-10", price: "2500.00" });
    const euro = await agreement({ clientId: delta, name: "Euro deal", renews: "2034-07-01", price: "100.00", currency: "EUR" });
    const betaDeal = await agreement({ clientId: beta, name: "Beta care", renews: "2034-07-01" });

    await draftRenewalInvoices(f.tenantId, at("2034-06-16"));
    expect(await linesOf(hosting)).toHaveLength(0); // 15 days before: not yet
    const first = await draftRenewalInvoices(f.tenantId, at("2034-06-17"));
    expect(first).toMatchObject({ drafted: 3, invoices: 3, failed: 0, closed: false });

    const [h] = await linesOf(hosting);
    expect(h).toMatchObject({ description: "Hosting, 2034-07-01 – 2034-07-31" });
    expect(h!.quantity.toString()).toBe("1");
    expect(h!.unitPriceExVat.toString()).toBe("1000");
    expect(h!.vatRatePct.toString()).toBe("25");
    expect([day(h!.servicePeriodStart), day(h!.servicePeriodEnd)]).toEqual(["2034-07-01", "2034-07-31"]);
    const invoice = await f.platform.invoice.findUniqueOrThrow({
      where: { id: h!.invoiceId },
      select: { origin: true, createdByMemberId: true, status: true, currency: true, periodStart: true, periodEnd: true, clientId: true },
    });
    expect(invoice).toMatchObject({ origin: "RENEWAL", createdByMemberId: null, status: "DRAFT", currency: "SEK", clientId: delta });
    expect((await f.platform.service.findUniqueOrThrow({ where: { id: hosting }, select: { invoicedThrough: true } })).invoicedThrough).toEqual(
      midnight("2034-07-31"),
    );
    // Support renews on the 10th: 14 days before is the 26th — not yet.
    expect(await linesOf(support)).toHaveLength(0);
    // Another currency, another client: their own drafts.
    const [e] = await linesOf(euro);
    const [b] = await linesOf(betaDeal);
    expect(new Set([h!.invoiceId, e!.invoiceId, b!.invoiceId]).size).toBe(3);

    // Support joins Delta's SEK draft, which widens its period.
    expect(await draftRenewalInvoices(f.tenantId, at("2034-06-26"))).toMatchObject({ drafted: 1, failed: 0 });
    const [s] = await linesOf(support);
    expect(s!.invoiceId).toBe(h!.invoiceId);
    const widened = await f.platform.invoice.findUniqueOrThrow({ where: { id: h!.invoiceId }, select: { periodStart: true, periodEnd: true } });
    expect([day(widened.periodStart), day(widened.periodEnd)]).toEqual(["2034-07-01", "2034-08-09"]);

    // Told: the owner and the admin (tenant-wide, may issue) — never Delta's manager or employee.
    const notes = await f.platform.notification.findMany({
      where: { tenantId: f.tenantId, kind: "invoice.renewal_drafted", entityId: h!.invoiceId },
      select: { receiverId: true, reason: true, params: true, class: true },
    });
    expect(notes.map((n) => n.receiverId).sort()).toEqual([f.seats.owner.memberId, f.seats.admin.memberId].sort());
    expect(new Set(notes.map((n) => n.reason))).toEqual(new Set(["INVOICE_ACCESS"]));
    expect(notes.every((n) => n.class === "COALESCED")).toBe(true);
    // One notice per draft while unread — the second renewal added no second row.
    expect(notes).toHaveLength(2);

    // Audited as SYSTEM, one row per line.
    const audits = await f.platform.auditEvent.findMany({
      where: { tenantId: f.tenantId, action: "invoice.renewal_drafted", targetId: h!.invoiceId },
      select: { actorType: true, metadata: true },
    });
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.actorType === "SYSTEM")).toBe(true);

    // A second run changes nothing.
    expect(await draftRenewalInvoices(f.tenantId, at("2034-06-26"))).toMatchObject({ drafted: 0 });
  });

  it("drafts nothing for a paused, ended, switched-off or unpriced agreement, an archived client's, or a period already started", async () => {
    const ids = [
      await agreement({ renews: "2035-03-01", status: "PAUSED" }),
      await agreement({ renews: "2035-03-01", status: "ENDED" }),
      await agreement({ renews: "2035-03-01", invoiceRenewals: false }),
      await agreement({ renews: "2035-03-01", price: null }),
      await agreement({ renews: "2035-03-01", clientId: gone }),
      // Started yesterday, never drafted (go-live): nothing.
      await agreement({ renews: "2035-02-20" }),
      // No currency of its own: it would bill in whatever the workspace's default became.
      await agreement({ renews: "2035-03-01", currency: null }),
    ];
    await draftRenewalInvoices(f.tenantId, at("2035-02-21"));
    for (const id of ids) expect(await linesOf(id)).toHaveLength(0);
  });

  it("bills only the days until an end inside the period, its last day included", async () => {
    const id = await agreement({ name: "Ending", renews: "2036-11-01", ends: "2036-11-15", price: "3000.00" });
    await draftRenewalInvoices(f.tenantId, at("2036-10-20"));
    const [l] = await linesOf(id);
    expect([day(l!.servicePeriodStart), day(l!.servicePeriodEnd)]).toEqual(["2036-11-01", "2036-11-15"]);
    expect(l!.unitPriceExVat.toString()).toBe("1500");
  });

  it("never drafts a deleted line's period again; the next period comes in its time", async () => {
    const id = await agreement({ name: "Deleted once", renews: "2037-05-01" });
    await draftRenewalInvoices(f.tenantId, at("2037-04-20"));
    const [l] = await f.platform.invoiceLine.findMany({ where: { tenantId: f.tenantId, serviceId: id }, select: { id: true, invoiceId: true } });
    await removeLine(owner(), l!.invoiceId, l!.id);
    expect(await draftRenewalInvoices(f.tenantId, at("2037-04-21"))).toMatchObject({ drafted: 0, failed: 0 });
    expect(await linesOf(id)).toHaveLength(0);
    // The date moves on (slice 113's job), and June is drafted in its time.
    await f.platform.service.update({ where: { id }, data: { renewsAt: midnight("2037-06-01") } });
    await draftRenewalInvoices(f.tenantId, at("2037-05-20"));
    expect((await linesOf(id)).map((x) => day(x.servicePeriodStart))).toEqual(["2037-06-01"]);
  });

  it("drafts only what is left after an interval change, and late when it was drafted without a gap", async () => {
    // Monthly, November drafted; then made quarterly from 1 November: December and January.
    const id = await agreement({ name: "Made quarterly", renews: "2038-11-01", price: "900.00" });
    await draftRenewalInvoices(f.tenantId, at("2038-10-20"));
    await updateService(owner(), id, { billingInterval: "QUARTERLY" });
    await draftRenewalInvoices(f.tenantId, at("2038-11-05"));
    const periods = (await linesOf(id)).map((x) => [day(x.servicePeriodStart), day(x.servicePeriodEnd)]);
    expect(periods).toEqual([
      ["2038-11-01", "2038-11-30"],
      ["2038-12-01", "2039-01-31"],
    ]);
  });

  it("running again forgets what was drafted up to a day already past, so paused time is never billed", async () => {
    const id = await agreement({ name: "Paused a while", renews: "2039-03-01" });
    await f.platform.service.update({ where: { id }, data: { invoicedThrough: midnight("2026-01-31"), status: "PAUSED" } });
    await setAgreementRunning(owner(), id, true);
    expect((await f.platform.service.findUniqueOrThrow({ where: { id }, select: { invoicedThrough: true } })).invoicedThrough).toBeNull();
    // Pausing again keeps nothing to forget; the manager (service:edit, Acme's) may.
    expect(await setAgreementRunning(manager(), id, false)).toEqual({ changed: true });
  });

  it("after an outage, drafts every period owed — each day once — and the date's move waits for what a failure left owed", async () => {
    // Drafted to 31 Jan, the date never moved from 1 Feb, the job down till 20 Mar.
    const id = await agreement({ name: "After an outage", renews: "2041-02-01", price: "1000.00" });
    await f.platform.service.update({ where: { id }, data: { invoicedThrough: midnight("2041-01-31") } });
    // The move first, as if the drafting had failed: February and March are owed and started — held.
    const holdLikeTheJob = (facts: MoveFacts, today: string) =>
      agreementHoldsDate({ ...facts, price: facts.price === null ? null : readFixed(facts.price, 2) }, today, LINE_TEXT_MAX.description);
    expect(await moveRenewalDatesOn(f.tenantId, at("2041-03-20"), { hold: holdLikeTheJob })).toMatchObject({ held: 1 });
    expect(day((await f.platform.service.findUniqueOrThrow({ where: { id }, select: { renewsAt: true } })).renewsAt)).toBe("2041-02-01");
    // The drafting catches up: February, March — and April, which starts within 14 days of the 20th.
    await draftRenewalInvoices(f.tenantId, at("2041-03-20"));
    expect((await linesOf(id)).map((x) => [day(x.servicePeriodStart), day(x.servicePeriodEnd)])).toEqual([
      ["2041-02-01", "2041-02-28"],
      ["2041-03-01", "2041-03-31"],
      ["2041-04-01", "2041-04-30"],
    ]);
    // Now it moves, past nothing owed.
    expect(await moveRenewalDatesOn(f.tenantId, at("2041-03-20"), { hold: holdLikeTheJob })).toMatchObject({ held: 0 });
    expect(day((await f.platform.service.findUniqueOrThrow({ where: { id }, select: { renewsAt: true } })).renewsAt)).toBe("2041-04-01");
  });

  it("drafts nothing while the invoicing module is off", async () => {
    const id = await agreement({ name: "Invoicing off", renews: "2040-01-01" });
    await setModuleEnabled(owner(), "invoicing", false);
    try {
      expect(await draftRenewalInvoices(f.tenantId, at("2039-12-20"))).toMatchObject({ closed: true, drafted: 0 });
      expect(await linesOf(id)).toHaveLength(0);
    } finally {
      await setModuleEnabled(owner(), "invoicing", true);
    }
    expect(await draftRenewalInvoices(f.tenantId, at("2039-12-20"))).toMatchObject({ closed: false, drafted: 1 });
  });
});
