import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { DomainError } from "@/lib/domain-error";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";

import { moveRenewalDatesOn } from "./renewals";
import { endService, setAgreementRunning, updateService } from "./service";

/**
 * AN AGREEMENT'S RENEWAL DATE MOVES ON BY ITSELF, and agreements become
 * editable, against the real database and app_runtime (Phase 4 slice 113;
 * founder decision C88; migration 20261017090000; the design:
 * docs/research/2026-10-12-slice-113-renewal-invoices-design.md §2):
 *   - a running recurring agreement's PASSED renewal date moves to the first
 *     renewal after today, on its anchor day, with `service.renewed` as SYSTEM;
 *   - a date due today, or to come, stays; so do paused, ended and one-time
 *     agreements, and one whose end comes before its next renewal;
 *   - the 31st keeps its day through February; a person's new date resets it;
 *   - the kind's rules and the year range on an edit; pause and run again.
 *
 * It calls the per-tenant `moveRenewalDatesOn` ONLY — never the job's
 * cross-tenant run (AGENTS.md: never write outside a throwaway tenant). The
 * clock is passed in: runs at 10:00 UTC (12:00 in the tenant's Stockholm).
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;

const at = (day: string) => new Date(`${day}T10:00:00Z`);
const midnight = (day: string) => new Date(`${day}T00:00:00Z`);
const owner = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });
const employee = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.employee.memberId) });

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

/** An agreement of Acme's, written directly — its id. */
async function agreement(data: {
  name: string;
  kind?: "RECURRING" | "ONE_TIME";
  interval?: "MONTHLY" | "QUARTERLY" | "YEARLY" | null;
  status?: "ACTIVE" | "PAUSED" | "ENDED";
  renews?: string | null;
  ends?: string | null;
}): Promise<string> {
  const id = randomUUID();
  const kind = data.kind ?? "RECURRING";
  await f.platform.service.create({
    data: {
      id,
      tenantId: f.tenantId,
      clientId: acme,
      name: data.name,
      kind,
      billingInterval: kind === "RECURRING" ? (data.interval === undefined ? "MONTHLY" : data.interval) : null,
      priceExVat: "1000.00",
      currency: "SEK",
      status: data.status ?? "ACTIVE",
      renewsAt: data.renews ? midnight(data.renews) : null,
      endsAt: data.ends ? midnight(data.ends) : null,
    },
  });
  return id;
}

const read = (id: string) =>
  f.platform.service.findUniqueOrThrow({ where: { id }, select: { renewsAt: true, renewalDay: true, status: true, billingInterval: true } });
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const renewed = (id: string) =>
  f.platform.auditEvent.findMany({
    where: { tenantId: f.tenantId, action: "service.renewed", targetId: id },
    select: { actorType: true, actorId: true, metadata: true },
    orderBy: { createdAt: "asc" },
  });

beforeAll(async () => {
  f = await setupTenant("agren");
  acme = randomUUID();
  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: "Acme AB" } });
}, 120_000);

afterAll(async () => {
  if (!f) return;
  const where = { where: { tenantId: f.tenantId } };
  await f.platform.service.deleteMany(where);
  await f.platform.client.deleteMany(where);
  await f.cleanup();
}, 120_000);

describe("a passed renewal date moves on", () => {
  it("moves a monthly date that passed yesterday to the next renewal, as SYSTEM", async () => {
    const id = await agreement({ name: "Hosting", renews: "2031-11-01" });
    expect(await moveRenewalDatesOn(f.tenantId, at("2031-11-02"))).toEqual({ moved: 1, failed: 0 });
    const s = await read(id);
    expect(dayOf(s.renewsAt)).toBe("2031-12-01");
    expect(s.renewsAt!.toISOString()).toBe("2031-12-01T00:00:00.000Z");
    expect(s.renewalDay).toBe(1);
    const rows = await renewed(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorType).toBe("SYSTEM");
    expect(rows[0]!.metadata).toEqual({ clientId: acme, from: "2031-11-01", to: "2031-12-01", steps: 1 });
    // A second run the same day has nothing to move.
    expect(await moveRenewalDatesOn(f.tenantId, at("2031-11-02"))).toEqual({ moved: 0, failed: 0 });
    expect(await renewed(id)).toHaveLength(1);
  });

  it("leaves a date due today, and one still to come", async () => {
    const today = await agreement({ name: "Due today", renews: "2032-03-10" });
    const later = await agreement({ name: "Later", renews: "2032-03-20" });
    await moveRenewalDatesOn(f.tenantId, at("2032-03-10"));
    expect(dayOf((await read(today)).renewsAt)).toBe("2032-03-10");
    expect(dayOf((await read(later)).renewsAt)).toBe("2032-03-20");
    expect(await renewed(today)).toHaveLength(0);
  });

  it("catches up several intervals at once — quarterly and yearly too", async () => {
    const monthly = await agreement({ name: "Stale monthly", renews: "2032-01-05" });
    const quarterly = await agreement({ name: "Quarterly", interval: "QUARTERLY", renews: "2031-07-01" });
    const yearly = await agreement({ name: "Yearly", interval: "YEARLY", renews: "2030-05-15" });
    await moveRenewalDatesOn(f.tenantId, at("2032-04-20"));
    expect(dayOf((await read(monthly)).renewsAt)).toBe("2032-05-05");
    expect(dayOf((await read(quarterly)).renewsAt)).toBe("2032-07-01");
    expect(dayOf((await read(yearly)).renewsAt)).toBe("2032-05-15");
    expect((await renewed(monthly))[0]!.metadata).toMatchObject({ from: "2032-01-05", to: "2032-05-05", steps: 4 });
  });

  it("keeps the 31st through February and back", async () => {
    const id = await agreement({ name: "Month end", renews: "2033-01-31" });
    await moveRenewalDatesOn(f.tenantId, at("2033-02-01"));
    let s = await read(id);
    expect(dayOf(s.renewsAt)).toBe("2033-02-28");
    expect(s.renewalDay).toBe(31);
    await moveRenewalDatesOn(f.tenantId, at("2033-03-01"));
    s = await read(id);
    expect(dayOf(s.renewsAt)).toBe("2033-03-31");
    expect(s.renewalDay).toBe(31);
  });

  it("leaves paused, ended, one-time and interval-less agreements, and one that ends before it would renew", async () => {
    const paused = await agreement({ name: "Paused", status: "PAUSED", renews: "2034-01-01" });
    const ended = await agreement({ name: "Ended", status: "ENDED", renews: "2034-01-01" });
    const oneTime = await agreement({ name: "One-off", kind: "ONE_TIME", renews: "2034-01-01" });
    const endsFirst = await agreement({ name: "Ends first", renews: "2034-01-01", ends: "2034-01-31" });
    const endsOnRenewal = await agreement({ name: "Ends on its renewal", renews: "2034-01-01", ends: "2034-02-01" });
    const noInterval = await agreement({ name: "No interval", interval: null, renews: "2034-01-01" });
    await moveRenewalDatesOn(f.tenantId, at("2034-01-05"));
    for (const id of [paused, ended, oneTime, endsFirst, noInterval]) {
      expect(dayOf((await read(id)).renewsAt)).toBe("2034-01-01");
      expect(await renewed(id)).toHaveLength(0);
    }
    // An end ON the next renewal day is inside it: the date moves.
    expect(dayOf((await read(endsOnRenewal)).renewsAt)).toBe("2034-02-01");
  });

  it("moves a paused agreement's passed date once it runs again — never before", async () => {
    const id = await agreement({ name: "Paused then running", status: "PAUSED", renews: "2035-02-01" });
    await moveRenewalDatesOn(f.tenantId, at("2035-03-10"));
    expect(dayOf((await read(id)).renewsAt)).toBe("2035-02-01");
    expect(await setAgreementRunning(owner(), id, true)).toEqual({ changed: true });
    await moveRenewalDatesOn(f.tenantId, at("2035-03-10"));
    expect(dayOf((await read(id)).renewsAt)).toBe("2035-04-01");
  });
});

describe("editing an agreement", () => {
  it("a person's new renewal date is the new anchor: the kept day goes", async () => {
    const id = await agreement({ name: "Re-dated", renews: "2036-01-31" });
    await moveRenewalDatesOn(f.tenantId, at("2036-02-01"));
    expect((await read(id)).renewalDay).toBe(31);
    const { changed } = await updateService(owner(), id, { renewsAt: midnight("2036-03-15") });
    expect(changed).toEqual(["renewsAt"]);
    const s = await read(id);
    expect(dayOf(s.renewsAt)).toBe("2036-03-15");
    expect(s.renewalDay).toBeNull();
    // An edit that leaves the date alone keeps whatever day is kept.
    await moveRenewalDatesOn(f.tenantId, at("2036-03-16"));
    expect((await read(id)).renewalDay).toBe(15);
    await updateService(owner(), id, { name: "Re-dated, renamed" });
    expect((await read(id)).renewalDay).toBe(15);
  });

  it("holds the kind's rules: one-time clears the interval and the date, recurring takes an interval", async () => {
    const id = await agreement({ name: "Switches", renews: "2036-06-01" });
    const { changed } = await updateService(owner(), id, { kind: "ONE_TIME" });
    expect(changed.sort()).toEqual(["billingInterval", "kind", "renewsAt"]);
    let s = await read(id);
    expect(s.billingInterval).toBeNull();
    expect(s.renewsAt).toBeNull();
    await updateService(owner(), id, { kind: "RECURRING" });
    s = await read(id);
    expect(s.billingInterval).toBe("MONTHLY");
    // A one-time agreement's date is not taken, whatever the patch says.
    await updateService(owner(), id, { kind: "ONE_TIME", renewsAt: midnight("2036-07-01"), billingInterval: "YEARLY" });
    s = await read(id);
    expect(s.billingInterval).toBeNull();
    expect(s.renewsAt).toBeNull();
  });

  it("keeps the old and new values of what an agreement bills in the trail — never its notes", async () => {
    const id = await agreement({ name: "Traced", renews: "2036-06-01" });
    await updateService(owner(), id, { priceExVat: "1250,50", renewsAt: midnight("2036-06-15"), internalNotes: "margin thin" });
    const rows = await f.platform.auditEvent.findMany({
      where: { tenantId: f.tenantId, action: "service.updated", targetId: id },
      select: { metadata: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      fields: ["renewsAt", "priceExVat", "internalNotes"],
      values: { priceExVat: { from: "1000", to: "1250.50" }, renewsAt: { from: "2036-06-01", to: "2036-06-15" } },
    });
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain("margin");
  });

  it("refuses a name longer than 200 characters", async () => {
    const id = await agreement({ name: "Short", renews: "2036-06-01" });
    expect(await outcome(updateService(owner(), id, { name: "x".repeat(201) }))).toBe("INVALID_INPUT");
    expect(await outcome(updateService(owner(), id, { name: "x".repeat(200) }))).toBe("ok");
  });

  it("refuses a year outside 2000–2199", async () => {
    const id = await agreement({ name: "Typo", renews: "2036-06-01" });
    expect(await outcome(updateService(owner(), id, { renewsAt: new Date("1999-12-31T00:00:00Z") }))).toBe("INVALID_INPUT");
    expect(await outcome(updateService(owner(), id, { endsAt: new Date("2200-01-01T00:00:00Z") }))).toBe("INVALID_INPUT");
    expect(await outcome(updateService(owner(), id, { endsAt: new Date("2199-12-31T00:00:00Z") }))).toBe("ok");
  });

  it("ending sets its end to today — or keeps an earlier end, never a later one", async () => {
    const later = await agreement({ name: "Ends later", renews: "2036-09-01", ends: "2099-01-01" });
    const earlier = await agreement({ name: "Ended earlier", renews: "2036-09-01", ends: "2020-05-01" });
    const none = await agreement({ name: "No end", renews: "2036-09-01" });
    for (const id of [later, earlier, none]) await endService(owner(), id);
    // The end ending wrote over is kept in the trail (the security review's low).
    const endedRows = await f.platform.auditEvent.findMany({
      where: { tenantId: f.tenantId, action: "service.ended", targetId: { in: [later, earlier] } },
      select: { targetId: true, metadata: true },
    });
    const meta = new Map(endedRows.map((r) => [r.targetId, r.metadata as Record<string, unknown>]));
    expect(meta.get(later)?.["endsAt"]).toMatchObject({ from: "2099-01-01" });
    expect(meta.get(earlier)?.["endsAt"]).toBeUndefined();
    // An ended agreement's end is never moved or cleared afterwards; its name still can be.
    expect(await outcome(updateService(owner(), earlier, { endsAt: midnight("2030-01-01") }))).toBe("AGREEMENT_ENDED");
    expect(await outcome(updateService(owner(), earlier, { endsAt: null }))).toBe("AGREEMENT_ENDED");
    expect(await outcome(updateService(owner(), earlier, { name: "Ended earlier, renamed" }))).toBe("ok");
    const ends = async (id: string) => (await f.platform.service.findUniqueOrThrow({ where: { id }, select: { endsAt: true, status: true } }));
    expect(await ends(earlier)).toEqual({ endsAt: midnight("2020-05-01"), status: "ENDED" });
    for (const id of [later, none]) {
      const e = await ends(id);
      expect(e.status).toBe("ENDED");
      // Today in the workspace's zone, as a date: UTC midnight within a day of now.
      expect(e.endsAt!.toISOString()).toMatch(/T00:00:00\.000Z$/);
      expect(Math.abs(e.endsAt!.getTime() - Date.now())).toBeLessThan(2 * 86_400_000);
    }
  });

  it("pauses and runs again; an ended agreement stays ended; an employee may not", async () => {
    const id = await agreement({ name: "Pausable", renews: "2036-09-01" });
    expect(await setAgreementRunning(owner(), id, false)).toEqual({ changed: true });
    expect((await read(id)).status).toBe("PAUSED");
    expect(await setAgreementRunning(owner(), id, false)).toEqual({ changed: false });
    expect(await setAgreementRunning(owner(), id, true)).toEqual({ changed: true });
    expect((await read(id)).status).toBe("ACTIVE");
    const ended = await agreement({ name: "Over", status: "ENDED" });
    expect(await outcome(setAgreementRunning(owner(), ended, true))).toBe("AGREEMENT_ENDED");
    expect(await outcome(setAgreementRunning(employee(), id, false))).toBe("FORBIDDEN");
    const audits = await f.platform.auditEvent.findMany({
      where: { tenantId: f.tenantId, action: "service.updated", targetId: id },
      select: { metadata: true },
    });
    expect(audits.map((a) => a.metadata)).toEqual(
      expect.arrayContaining([
        { clientId: acme, from: "ACTIVE", to: "PAUSED" },
        { clientId: acme, from: "PAUSED", to: "ACTIVE" },
      ]),
    );
  });
});
