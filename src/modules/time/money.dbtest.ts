import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { setupTenant } from "@/members/dbtest-fixture";
import { createItem } from "@/modules/work";
import { updatePreferences } from "@/preferences/service";

import {
  acknowledgeNotice,
  createEntry,
  createRateCard,
  getNoticeStatus,
  projectMoney,
  resetTimeDefaultsMemo,
} from "./index";

/**
 * The project money page's service against the real database and the
 * real app_runtime role (PLAN.md 2T DoD: "the project money page
 * reconciles with a hand calculation"; DATA_MODEL.md §6.15 "Who sees
 * money"): value = Σ billable hours × the bill-rate snapshot; the ✦ half
 * (cost, margin) appears only for a holder of rate:view_cost with the
 * tenant's cost layer on, only when asked for, only with a fresh
 * factor, and is audited once per reveal with ids only; uncosted hours
 * are counted, never silently dropped; a cost card in another currency
 * withholds the numbers rather than summing two currencies.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let project: string;
let task: string;

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const managerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.manager.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

const authzReason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    throw e;
  }
};
const at = (s: string) => new Date(`${s}:00Z`);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

const AUGUST = { from: "2026-08-01", to: "2026-08-31" };
const JULY = { from: "2026-07-01", to: "2026-07-31" };

/** The hand calculation the page must reconcile with. */
const BILL = 1200; // SEK/h, PROJECT card
const COST_OWNER = 612.34; // SEK/h, the owner's COST card — two decimals, not a substring of any id
// August: e1 owner 2 h billable on the task · e2 manager 1 h billable at project level (no COST card)
//         · e3 owner 1 h NON-billable at project level
const VALUE = 3 * BILL; // 3600.00 — billable hours only
const COST = 3 * COST_OWNER; // 1837.02 — the owner's 3 h (billable AND non-billable); the manager's hour is uncosted
const MARGIN = VALUE - COST; // 1762.98
const MARGIN_PCT = Math.round((MARGIN / VALUE) * 1000) / 10; // 49.0

beforeAll(async () => {
  resetTimeDefaultsMemo();
  f = await setupTenant("money");
  acme = randomUUID();
  project = randomUUID();
  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: "Acme" } });
  await f.platform.project.create({
    data: { id: project, tenantId: f.tenantId, clientId: acme, key: "ACME", name: "Acme site", billingCurrency: "SEK" },
  });
  task = (await createItem(ownerCtx(), { projectId: project, title: "Build the thing" })).id;
  for (const ctx of [ownerCtx(), managerCtx(), employeeCtx()]) {
    const s = await getNoticeStatus(ctx);
    await acknowledgeNotice(ctx, s.notice!.id);
  }
  await createRateCard(ownerCtx(), { kind: "BILL", scope: "PROJECT", projectId: project, amount: String(BILL), currency: "SEK", effectiveFrom: "2026-01-01" });
  await createRateCard(ownerCtx(), {
    kind: "COST",
    scope: "MEMBER",
    memberId: f.seats.owner.memberId,
    amount: String(COST_OWNER),
    currency: "SEK",
    effectiveFrom: "2026-01-01",
  });
  await createEntry(ownerCtx(), { workItemId: task, startedAt: at("2026-08-03T08:00"), stoppedAt: at("2026-08-03T10:00") });
  await createEntry(managerCtx(), { projectId: project, description: "Review", startedAt: at("2026-08-04T08:00"), stoppedAt: at("2026-08-04T09:00") });
  await createEntry(ownerCtx(), { projectId: project, description: "Internal sync", billable: false, startedAt: at("2026-08-05T08:00"), stoppedAt: at("2026-08-05T09:00") });
}, 90_000);

afterAll(async () => {
  const db = f.platform;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.time_maintenance', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.time_lock_bypass', 'on', true)`;
    await tx.timeEntry.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.rateCard.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.projectTimeSummary.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.staffNoticeAcknowledgment.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.staffNotice.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.workType.deleteMany({ where: { tenantId: f.tenantId } });
  });
  await db.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await db.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  // The COST card's v2 encryption minted a tenant key; RESTRICT blocks the tenant delete until it is gone.
  await db.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  resetTimeDefaultsMemo();
  await f.cleanup();
}, 60_000);

describe("project money — the ladder: value (rate:view_bill) → cost + margin (rate:view_cost ✦, audited)", () => {
  it("value reconciles with the hand calculation for a manager; cost is never offered or computed without rate:view_cost", async () => {
    const m = await projectMoney(managerCtx(), project, AUGUST);
    expect(m.currency).toBe("SEK");
    expect(m.totals.seconds).toBe(4 * 3600);
    expect(m.totals.billableSeconds).toBe(3 * 3600);
    expect(m.totals.value).toBe(VALUE.toFixed(2));
    expect(m.totals.effectiveRate).toBe(BILL.toFixed(2));
    expect(m.canRevealCost).toBe(false);
    expect(m.costRevealed).toBe(false);
    expect(m.totals.cost).toBeNull();
    expect(m.totals.margin).toBeNull();
    expect(m.totals.uncostedSeconds).toBe(0);
    // Per member: the owner's 2 h billable + 1 h non-billable, the manager's 1 h.
    const owner = m.byMember.find((l) => l.key === f.seats.owner.memberId)!;
    const manager = m.byMember.find((l) => l.key === f.seats.manager.memberId)!;
    expect([owner.seconds, owner.billableSeconds, owner.value]).toEqual([3 * 3600, 2 * 3600, (2 * BILL).toFixed(2)]);
    expect([manager.seconds, manager.billableSeconds, manager.value]).toEqual([3600, 3600, BILL.toFixed(2)]);
    expect(m.byItem.find((l) => l.label === "ACME-1 Build the thing")?.value).toBe((2 * BILL).toFixed(2));
    expect(m.byItem.find((l) => l.key === "__project")?.value).toBe(BILL.toFixed(2));
    // Asking for the ✦ half without the permission is ignored — nothing leaks, nothing errors, nothing is audited.
    const asked = await projectMoney(managerCtx(), project, AUGUST, { revealCost: true });
    expect(asked.costRevealed).toBe(false);
    expect(asked.byMember.every((l) => l.cost === null && l.margin === null)).toBe(true);
    expect(await f.audits("rate_card.cost_revealed")).toHaveLength(0);
  });

  it("the employee (no time:view_team / rate:view_bill) is refused outright", async () => {
    expect(await authzReason(projectMoney(employeeCtx(), project, AUGUST))).toBe("FORBIDDEN");
  });

  it("the tenant's cost layer gates the offer: off by default, even for the owner", async () => {
    const off = await projectMoney(ownerCtx(), project, AUGUST, { revealCost: true });
    expect(off.canRevealCost).toBe(false);
    expect(off.costRevealed).toBe(false);
    expect(off.totals.cost).toBeNull();
    expect(await f.audits("rate_card.cost_revealed")).toHaveLength(0);
    await updatePreferences(ownerCtx(), { finance: { costRatesEnabled: true } });
    const on = await projectMoney(ownerCtx(), project, AUGUST);
    expect(on.canRevealCost).toBe(true);
    // Offered is not revealed: without the explicit ask, no decrypt, no audit row.
    expect(on.costRevealed).toBe(false);
    expect(on.totals.cost).toBeNull();
    expect(await f.audits("rate_card.cost_revealed")).toHaveLength(0);
  });

  it("reveal: cost counts every hour, value only billable ones, uncosted hours are counted, margin reconciles, audited once with ids only", async () => {
    const m = await projectMoney(ownerCtx(), project, AUGUST, { revealCost: true });
    expect(m.costRevealed).toBe(true);
    expect(m.currencyMismatch).toBe(false);
    expect(m.totals.value).toBe(VALUE.toFixed(2));
    expect(m.totals.cost).toBe(COST.toFixed(2));
    expect(m.totals.margin).toBe(MARGIN.toFixed(2));
    expect(m.totals.marginPercent).toBe(MARGIN_PCT);
    expect(m.totals.uncostedSeconds).toBe(3600); // the manager's hour has no COST card behind it
    const owner = m.byMember.find((l) => l.key === f.seats.owner.memberId)!;
    const manager = m.byMember.find((l) => l.key === f.seats.manager.memberId)!;
    expect(owner.cost).toBe(COST.toFixed(2));
    expect(owner.margin).toBe((2 * BILL - COST).toFixed(2));
    expect(owner.uncostedSeconds).toBe(0);
    expect(manager.cost).toBe("0.00");
    expect(manager.uncostedSeconds).toBe(3600);
    expect(manager.margin).toBe(BILL.toFixed(2));
    expect(manager.marginPercent).toBe(100);
    // Σ lines == totals on every axis (the rollup-equality property, in money).
    const sum = (lines: { value: string; cost: string | null }[]) => ({
      value: lines.reduce((s, l) => s + Number(l.value), 0).toFixed(2),
      cost: lines.reduce((s, l) => s + Number(l.cost ?? 0), 0).toFixed(2),
    });
    for (const axis of [m.byMember, m.byEpic, m.byItem, m.byAgreement]) {
      expect(sum(axis)).toEqual({ value: m.totals.value, cost: m.totals.cost });
    }
    const revealed = await f.audits("rate_card.cost_revealed");
    expect(revealed).toHaveLength(1);
    expect(JSON.stringify(revealed[0]?.metadata)).not.toContain(String(COST_OWNER));
    expect(Object.keys(revealed[0]?.metadata as object).sort()).toEqual(["count", "ids"]);
  });

  it("a stale factor refuses the ✦ half (MFA_REQUIRED) but still answers the bill half", async () => {
    const stale = { tenantId: f.tenantId, actor: { memberId: f.seats.owner.memberId, mfa: { enrolled: true, verifiedAt: hoursAgo(2) } } };
    expect(await authzReason(projectMoney(stale, project, AUGUST, { revealCost: true }))).toBe("MFA_REQUIRED");
    const bill = await projectMoney(stale, project, AUGUST);
    expect(bill.totals.value).toBe(VALUE.toFixed(2));
    expect(bill.canRevealCost).toBe(true);
    expect(bill.costRevealed).toBe(false);
    expect(await f.audits("rate_card.cost_revealed")).toHaveLength(1);
  });

  it("a COST card in another currency than the project withholds cost and margin instead of summing two currencies", async () => {
    await createRateCard(ownerCtx(), {
      kind: "COST",
      scope: "MEMBER",
      memberId: f.seats.manager.memberId,
      amount: "55",
      currency: "EUR",
      effectiveFrom: "2026-07-01",
    });
    // Written AFTER the EUR card exists, so this July entry snapshots it; the August entries above keep their
    // resolution-at-write (no card for the manager then) and are untouched.
    await createEntry(managerCtx(), { projectId: project, description: "July review", startedAt: at("2026-07-02T08:00"), stoppedAt: at("2026-07-02T09:00") });
    const m = await projectMoney(ownerCtx(), project, JULY, { revealCost: true });
    expect(m.costRevealed).toBe(true);
    expect(m.currencyMismatch).toBe(true);
    expect(m.totals.value).toBe(BILL.toFixed(2));
    expect(m.totals.cost).toBeNull();
    expect(m.totals.margin).toBeNull();
    expect(m.byMember.every((l) => l.cost === null && l.margin === null)).toBe(true);
    // August is unaffected: the owner's SEK card still reconciles.
    const aug = await projectMoney(ownerCtx(), project, AUGUST, { revealCost: true });
    expect(aug.currencyMismatch).toBe(false);
    expect(aug.totals.cost).toBe(COST.toFixed(2));
  });
});
