import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { setupTenant } from "@/members/dbtest-fixture";
import { changeItemVisibility, createItem } from "@/modules/work";

import {
  acknowledgeNotice,
  agreementConsumption,
  archiveReport,
  checkBudgetAlerts,
  createBudget,
  createEntry,
  createRateCard,
  deleteReport,
  generateReport,
  getNoticeStatus,
  getProjectBudget,
  listReports,
  projectRollup,
  publishReport,
  regenerateReport,
  repriceRateCard,
  resetTimeDefaultsMemo,
  teamRollup,
  unpublishReport,
} from "./index";

/**
 * D3 published reports, budgets + alerts, rollups and the reprice command
 * against the real database and the real app_runtime role: snapshots are
 * member-free and INTERNAL-name-folded by construction, publish is one
 * audited tx and the 4-term gate shows a contact exactly the published
 * reports of its enabled project, published rows are immutable/archive-
 * only, budget thresholds alert once per (period, threshold) through
 * notify.emit, rollups reconcile with the rows, and reprice touches only
 * unlocked entries pointing at the card.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let project: string;
let visibleTask: string;
let internalTask: string;
let maintenance: string; // CLIENT_VISIBLE agreement
let secret: string; // INTERNAL agreement
let projectCard: string;
const contact = { id: randomUUID() };

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const managerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.manager.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

const domainCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};
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

beforeAll(async () => {
  resetTimeDefaultsMemo();
  f = await setupTenant("reports");
  acme = randomUUID();
  project = randomUUID();
  maintenance = randomUUID();
  secret = randomUUID();
  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: "Acme" } });
  await f.platform.project.create({
    data: { id: project, tenantId: f.tenantId, clientId: acme, key: "ACME", name: "Acme site", billingCurrency: "SEK", portalEnabled: true },
  });
  await f.platform.service.createMany({
    data: [
      { id: maintenance, tenantId: f.tenantId, clientId: acme, name: "Maintenance", kind: "RECURRING", billingInterval: "MONTHLY", visibility: "CLIENT_VISIBLE" },
      { id: secret, tenantId: f.tenantId, clientId: acme, name: "Secret retainer", kind: "RECURRING", billingInterval: "MONTHLY", visibility: "INTERNAL" },
    ],
  });
  await f.platform.contact.create({
    data: { id: contact.id, tenantId: f.tenantId, clientId: acme, name: "Carol", email: `carol-${randomUUID().slice(0, 8)}@test.invalid`, portalStatus: "ACTIVE" },
  });
  visibleTask = (await createItem(ownerCtx(), { projectId: project, title: "Visible task" })).id;
  await changeItemVisibility(ownerCtx(), visibleTask, "CLIENT_VISIBLE");
  internalTask = (await createItem(ownerCtx(), { projectId: project, title: "Internal task" })).id;

  for (const ctx of [ownerCtx(), managerCtx(), employeeCtx()]) {
    const s = await getNoticeStatus(ctx);
    await acknowledgeNotice(ctx, s.notice!.id);
  }
  projectCard = (
    await createRateCard(ownerCtx(), { kind: "BILL", scope: "PROJECT", projectId: project, amount: "1000", currency: "SEK", effectiveFrom: "2026-01-01" })
  ).id;
  // Entries: e1 visible task 2 h · e2 internal task 1 h (both 08-03);
  // e3 Maintenance 1.5 h · e4 Secret retainer 0.5 h by the manager (08-04);
  // e5 non-billable 1 h (08-05).
  await createEntry(ownerCtx(), { workItemId: visibleTask, startedAt: at("2026-08-03T08:00"), stoppedAt: at("2026-08-03T10:00") });
  await createEntry(ownerCtx(), { workItemId: internalTask, startedAt: at("2026-08-03T10:00"), stoppedAt: at("2026-08-03T11:00") });
  await createEntry(ownerCtx(), { projectId: project, serviceId: maintenance, description: "Patching", startedAt: at("2026-08-04T08:00"), stoppedAt: at("2026-08-04T09:30") });
  await createEntry(managerCtx(), { projectId: project, serviceId: secret, description: "Retainer work", startedAt: at("2026-08-04T10:00"), stoppedAt: at("2026-08-04T10:30") });
  await createEntry(ownerCtx(), { projectId: project, description: "Internal sync", billable: false, startedAt: at("2026-08-05T08:00"), stoppedAt: at("2026-08-05T09:00") });
}, 90_000);

afterAll(async () => {
  const db = f.platform;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.time_maintenance', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.time_lock_bypass', 'on', true)`;
    await tx.timeReport.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.budgetAlert.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.projectBudget.deleteMany({ where: { tenantId: f.tenantId } });
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
  await db.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await db.service.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  resetTimeDefaultsMemo();
  await f.cleanup();
}, 60_000);

describe("TimeReport (D3) — member-free, INTERNAL names folded, publish = one tx, 4-term gate, immutable", () => {
  let byItem: string;
  let byService: string;

  it("folds INTERNAL tasks and agreements into one 'other' line; totals reconcile; no member key anywhere", async () => {
    const r = await generateReport(ownerCtx(), {
      projectId: project,
      title: "August by task",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      groupBy: "WORK_ITEM",
      includeAmounts: true,
    });
    byItem = r.id;
    const json = JSON.stringify(r.snapshot);
    expect(json).not.toContain("Internal task");
    expect(json).not.toContain("Secret retainer");
    expect(json).not.toContain("member");
    const visible = r.snapshot.lines.find((l) => l.kind === "work_item");
    expect(visible && visible.kind === "work_item" ? visible.ref : null).toBe("ACME-1");
    expect(visible?.seconds).toBe(7200);
    const other = r.snapshot.lines.find((l) => l.kind === "other");
    expect(other?.seconds).toBe(3600 + 5400 + 1800);
    expect(r.totalSeconds).toBe(18000); // billable only (includeNonBillable false)
    expect(r.billableAmount).toBe("5000.00"); // 5 h × 1000
    expect(r.status).toBe("DRAFT");

    const s = await generateReport(ownerCtx(), {
      projectId: project,
      title: "August by agreement",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      groupBy: "SERVICE",
    });
    byService = s.id;
    const svc = s.snapshot.lines.find((l) => l.kind === "service");
    expect(svc && svc.kind === "service" ? svc.label : null).toBe("Maintenance");
    expect(svc?.seconds).toBe(5400);
    expect(s.snapshot.lines.find((l) => l.kind === "other")?.seconds).toBe(7200 + 3600 + 1800);
    expect(JSON.stringify(s.snapshot)).not.toContain("Secret retainer");
    expect(s.billableAmount).toBeNull(); // includeAmounts false
    expect(s.snapshot.totals).toEqual({ seconds: 18000, billableSeconds: 18000 });

    const d = await generateReport(ownerCtx(), {
      projectId: project,
      title: "August by day",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      groupBy: "DAY",
      includeNonBillable: true,
    });
    expect(d.snapshot.lines.map((l) => (l.kind === "day" ? l.date : "?"))).toEqual(["2026-08-03", "2026-08-04", "2026-08-05"]);
    expect(d.totalSeconds).toBe(21600);
    await deleteReport(ownerCtx(), d.id);

    expect(await authzReason(generateReport(employeeCtx(), { projectId: project, title: "x", periodStart: "2026-08-01", periodEnd: "2026-08-31" }))).toBe("FORBIDDEN");
  });

  it("publish flips status + visibility in one audited tx; the contact sees exactly the published report; unpublish/republish/archive", async () => {
    const published = await publishReport(ownerCtx(), byItem);
    expect(published.status).toBe("PUBLISHED");
    expect(published.visibility).toBe("CLIENT_VISIBLE");
    expect(published.publishedAt).not.toBeNull();
    expect(await f.audits("time_report.published")).toHaveLength(1);

    const seenBy = () =>
      withTenant(f.tenantId, { type: "contact", id: contact.id, clientId: acme }, async (tx) => {
        const rows = await tx.timeReport.findMany({ select: { id: true, snapshot: true } });
        for (const r of rows) expect(JSON.stringify(r.snapshot)).not.toContain("member");
        return rows.map((r) => r.id);
      });
    expect(await seenBy()).toEqual([byItem]); // the draft byService is not visible

    await unpublishReport(ownerCtx(), byItem);
    expect(await seenBy()).toEqual([]);
    await publishReport(ownerCtx(), byItem); // republish
    expect(await seenBy()).toEqual([byItem]);

    // Immutable once published: app and database agree.
    expect(await domainCode(regenerateReport(ownerCtx(), byItem, { title: "changed" }))).toBe("REPORT_IMMUTABLE");
    expect(await domainCode(deleteReport(ownerCtx(), byItem))).toBe("REPORT_IMMUTABLE");
    await expect(f.platform.timeReport.update({ where: { id: byItem }, data: { title: "tamper" } })).rejects.toThrow(/REPORT_IMMUTABLE/);
    await expect(f.platform.timeReport.delete({ where: { id: byItem } })).rejects.toThrow(/REPORT_IMMUTABLE/);

    await archiveReport(ownerCtx(), byItem);
    const archived = (await listReports(ownerCtx(), project)).find((r) => r.id === byItem);
    expect(archived?.status).toBe("ARCHIVED");
    expect(archived?.visibility).toBe("INTERNAL");
    expect(await seenBy()).toEqual([]);

    // A draft archive is an honest delete; a draft can be regenerated first.
    const regenerated = await regenerateReport(ownerCtx(), byService, { title: "August by agreement (v2)", includeAmounts: true });
    expect(regenerated.title).toBe("August by agreement (v2)");
    expect(regenerated.billableAmount).toBe("5000.00");
    await archiveReport(ownerCtx(), byService);
    expect((await listReports(ownerCtx(), project)).map((r) => r.id)).not.toContain(byService);
  });
});

describe("budgets + alerts", () => {
  it("HOURS budget: burn reconciles; thresholds alert once per period through notify.emit; a new budget archives the old", async () => {
    const hours = await createBudget(ownerCtx(), { projectId: project, kind: "HOURS", amount: "10", thresholds: [50, 100], notifyMemberIds: [f.seats.owner.memberId] });
    expect(hours.status).toBe("ACTIVE");
    const view = await getProjectBudget(ownerCtx(), project);
    expect(view?.burn.seconds).toBe(18000); // billable only
    expect(view?.burn.percent).toBe(50);
    expect(view?.burn.periodKey).toBe("ALL");

    const first = await checkBudgetAlerts(f.tenantId);
    expect(first.alerts).toBe(1); // 50 %
    expect((await checkBudgetAlerts(f.tenantId)).alerts).toBe(0); // dedupe
    const notifications = await f.platform.notification.findMany({ where: { tenantId: f.tenantId, kind: "budget.threshold_reached" } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.receiverId).toBe(f.seats.owner.memberId);
    expect(await f.audits("budget.alert_sent")).toHaveLength(1);

    const money = await createBudget(ownerCtx(), { projectId: project, kind: "MONEY", amount: "4000", thresholds: [50, 100], notifyMemberIds: [f.seats.owner.memberId] });
    expect(money.currency).toBe("SEK");
    const old = await f.platform.projectBudget.findFirst({ where: { id: hours.id } });
    expect(old?.status).toBe("ARCHIVED");
    const burn = (await getProjectBudget(ownerCtx(), project))?.burn;
    expect(burn?.amount).toBe("5000.00");
    expect(burn?.percent).toBe(125);
    expect((await checkBudgetAlerts(f.tenantId)).alerts).toBe(2); // 50 and 100 for the new budget
    expect(await authzReason(createBudget(employeeCtx(), { projectId: project, kind: "HOURS", amount: "1" }))).toBe("FORBIDDEN");
  });
});

describe("rollups", () => {
  it("project rollup reconciles with the rows and masks money for non-holders; team + agreement sums", async () => {
    const r = await projectRollup(ownerCtx(), project, { from: "2026-08-01", to: "2026-08-31" });
    expect(r.totals.seconds).toBe(21600);
    expect(r.totals.billableSeconds).toBe(18000);
    expect(r.totals.amount).toBe("5000.00");
    expect(r.byMember).toHaveLength(2);
    expect(r.byMember.reduce((s, l) => s + l.seconds, 0)).toBe(21600);
    expect(r.byAgreement.find((l) => l.label === "Maintenance")?.seconds).toBe(5400);
    expect(r.byAgreement.find((l) => l.label === "Secret retainer")?.seconds).toBe(1800);
    expect(r.byItem.find((l) => l.label.startsWith("ACME-1"))?.seconds).toBe(7200);
    expect(r.costBuckets.reduce((s, b) => s + b.seconds, 0)).toBe(21600);
    expect(await authzReason(projectRollup(employeeCtx(), project, { from: "2026-08-01", to: "2026-08-31" }))).toBe("FORBIDDEN");

    const team = await teamRollup(managerCtx(), { from: "2026-08-01", to: "2026-08-31" });
    expect(team.reduce((s, l) => s + l.seconds, 0)).toBe(21600);
    expect(team.some((l) => l.memberId === f.seats.manager.memberId && l.seconds === 1800)).toBe(true);

    const c = await agreementConsumption(ownerCtx(), maintenance, { from: "2026-08-01", to: "2026-08-31" });
    expect(c.seconds).toBe(5400);
    expect(c.hours).toBe(1.5);
    expect(c.amount).toBe("1500.00");
  });
});

describe("reprice", () => {
  it("re-resolves only unlocked entries pointing at the card in scope; locked ones are skipped and counted", async () => {
    await createRateCard(ownerCtx(), { kind: "BILL", scope: "PROJECT", projectId: project, amount: "1500", currency: "SEK", effectiveFrom: "2026-08-04", closeOpen: true });
    const before = await f.platform.timeEntry.findMany({ where: { tenantId: f.tenantId, billRateCardId: projectCard }, select: { id: true, localDate: true } });
    expect(before).toHaveLength(4); // e1..e4 (e5 is non-billable, no bill card)

    const fromDate = await repriceRateCard(ownerCtx(), { rateCardId: projectCard, mode: "FROM_DATE", fromDate: "2026-08-04" });
    expect(fromDate).toEqual({ repriced: 2, skippedLocked: 0 }); // e3, e4
    const after = await f.platform.timeEntry.findMany({ where: { tenantId: f.tenantId, projectId: project, billable: true }, select: { localDate: true, billRate: true } });
    for (const e of after) {
      const day = e.localDate.toISOString().slice(0, 10);
      expect(Number(e.billRate), day).toBe(day >= "2026-08-04" ? 1500 : 1000);
    }

    // Lock e1, then reprice ALL_UNBILLED on the old card: e2 repriced (stays 1000 —
    // the 08-03 resolution is still the old card), e1 skipped and counted.
    const e1 = before.find((e) => e.localDate.toISOString().startsWith("2026-08-03"))!;
    await f.platform.timeEntry.update({ where: { id: e1.id }, data: { lockedReason: "INVOICED", lockedAt: new Date() } });
    const all = await repriceRateCard(ownerCtx(), { rateCardId: projectCard, mode: "ALL_UNBILLED" });
    expect(all.skippedLocked).toBe(1);
    expect(all.repriced).toBe(1);
    const audit = await f.audits("time_entry.repriced");
    expect(audit).toHaveLength(2);
    expect(await authzReason(repriceRateCard(managerCtx(), { rateCardId: projectCard, mode: "ALL_UNBILLED" }))).toBe("FORBIDDEN"); // CA only
  });
});
