import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { DomainError } from "@/lib/domain-error";
import { dateColumn, localDateString } from "@/lib/duration";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { createRole, setRolePermissions } from "@/members/roles";
import { createItem } from "@/modules/work";
import { updatePreferences } from "@/preferences/service";

import {
  acknowledgeNotice,
  createEntry,
  createRateCard,
  entriesCsv,
  exportEntries,
  exportProjectRollup,
  exportStatement,
  getNoticeStatus,
  resetTimeDefaultsMemo,
  rollupCsv,
  statementCsv,
  workingTimeStatement,
} from "./index";

/**
 * The time module's exports against the real database and the real
 * app_runtime role (PLAN.md 2T "CSV exports" + D1 statement; SECURITY.md
 * §9.7.3 self-access, §9.7.4 "cost never in CSV by default"; AUTHZ.md
 * `time:export`): own rows need only time:track and carry no rates
 * without rate:view_bill; team rows need time:export + time:view_team and
 * respect scope (ad-hoc rows visible, another client's project not); the
 * rollup CSV gains cost columns ONLY through the ✦ reveal (permission +
 * cost layer + fresh factor, audited) and says so in its own audit row;
 * the statement reconciles shift − breaks = worked and tracked ≤ worked,
 * never selects an open shift, and carries no tracked column for another
 * member; every export writes one `time.exported` row with ids only.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
let acmeProject: string;
let betaProject: string;
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
const domainCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};
const at = (s: string) => new Date(`${s}:00Z`);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
const BOM = String.fromCharCode(0xfeff);
const header = (csv: string): string => (csv.startsWith(BOM) ? csv.slice(1) : csv).split("\r\n")[0]!;
const lastExportAudit = async () => {
  const rows = await f.audits("time.exported");
  return rows[rows.length - 1]!;
};

const AUGUST = { from: "2026-08-01", to: "2026-08-31" };
const BILL = 1000; // SEK/h, ACME PROJECT card
const COST_OWNER = 500; // SEK/h, the owner's COST card (the employee has none ⇒ uncosted)
const ZONE = "Europe/Stockholm";

beforeAll(async () => {
  resetTimeDefaultsMemo();
  f = await setupTenant("export");
  acme = randomUUID();
  beta = randomUUID();
  acmeProject = randomUUID();
  betaProject = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme" },
      { id: beta, tenantId: f.tenantId, name: "Beta" },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: acmeProject, tenantId: f.tenantId, clientId: acme, key: "ACME", name: "Acme site", billingCurrency: "SEK" },
      { id: betaProject, tenantId: f.tenantId, clientId: beta, key: "BETA", name: "Beta app", billingCurrency: "SEK" },
    ],
  });
  // The employee template has no client:view_all — assign Acme so its project is in scope for the entry.
  await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: acme } });
  task = (await createItem(ownerCtx(), { projectId: acmeProject, title: "Build the thing" })).id;
  for (const ctx of [ownerCtx(), managerCtx(), employeeCtx()]) {
    const s = await getNoticeStatus(ctx);
    await acknowledgeNotice(ctx, s.notice!.id);
  }
  await createRateCard(ownerCtx(), { kind: "BILL", scope: "PROJECT", projectId: acmeProject, amount: String(BILL), currency: "SEK", effectiveFrom: "2026-01-01" });
  await createRateCard(ownerCtx(), {
    kind: "COST",
    scope: "MEMBER",
    memberId: f.seats.owner.memberId,
    amount: String(COST_OWNER),
    currency: "SEK",
    effectiveFrom: "2026-01-01",
  });
  // August: owner 2 h on the task · employee 1 h project-level on Acme · manager 30 min ad-hoc · owner 1 h on Beta; July: owner 1 h (outside the range).
  await createEntry(ownerCtx(), { workItemId: task, startedAt: at("2026-08-03T08:00"), stoppedAt: at("2026-08-03T10:00") });
  await createEntry(employeeCtx(), { projectId: acmeProject, description: "Ops", startedAt: at("2026-08-04T07:00"), stoppedAt: at("2026-08-04T08:00") });
  await createEntry(managerCtx(), { description: "Admin =SUM(1)", startedAt: at("2026-08-04T09:00"), stoppedAt: at("2026-08-04T09:30") });
  await createEntry(ownerCtx(), { projectId: betaProject, description: "Beta work", startedAt: at("2026-08-05T08:00"), stoppedAt: at("2026-08-05T09:00") });
  await createEntry(ownerCtx(), { projectId: acmeProject, description: "July", startedAt: at("2026-07-20T08:00"), stoppedAt: at("2026-07-20T09:00") });
  // The employee's shifts: Mon 3 Aug 08:00–16:30 with a 30 min break (8 h worked); Tue 4 Aug 08:00–14:00 with no break (6 h — the >5 h warn);
  // and an OPEN shift right now, which no statement may select.
  const emp = f.seats.employee.memberId;
  const s1 = await f.platform.shift.create({
    data: {
      tenantId: f.tenantId,
      memberId: emp,
      startedAt: at("2026-08-03T06:00"),
      stoppedAt: at("2026-08-03T14:30"),
      workedSeconds: 8.5 * 3600 - 1800,
      timezone: ZONE,
      localDate: dateColumn("2026-08-03"),
      note: "WFH",
    },
  });
  await f.platform.shiftBreak.create({
    data: {
      tenantId: f.tenantId,
      shiftId: s1.id,
      memberId: emp,
      startedAt: at("2026-08-03T10:00"),
      stoppedAt: at("2026-08-03T10:30"),
      durationSeconds: 1800,
    },
  });
  await f.platform.shift.create({
    data: {
      tenantId: f.tenantId,
      memberId: emp,
      startedAt: at("2026-08-04T06:00"),
      stoppedAt: at("2026-08-04T12:00"),
      workedSeconds: 6 * 3600,
      timezone: ZONE,
      localDate: dateColumn("2026-08-04"),
    },
  });
  await f.platform.shift.create({
    data: {
      tenantId: f.tenantId,
      memberId: emp,
      startedAt: hoursAgo(1),
      stoppedAt: null,
      workedSeconds: null,
      timezone: ZONE,
      localDate: dateColumn(localDateString(hoursAgo(1), ZONE)),
    },
  });
}, 120_000);

afterAll(async () => {
  const db = f.platform;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.time_maintenance', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.time_lock_bypass', 'on', true)`;
    await tx.timeEntry.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.shiftBreak.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.shift.deleteMany({ where: { tenantId: f.tenantId } });
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
  await db.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  // The COST card's v2 encryption minted a tenant key; RESTRICT blocks the tenant delete until it is gone.
  await db.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  resetTimeDefaultsMemo();
  await f.cleanup();
}, 60_000);

describe("entries export — own under time:track, team under time:export + scope, rates only with rate:view_bill", () => {
  it("own (employee): only own closed rows, no rate columns, one audit row with ids and counts only", async () => {
    const e = await exportEntries(employeeCtx(), AUGUST, { scope: "own" });
    expect(e.scope).toBe("own");
    expect(e.includesRates).toBe(false);
    expect(e.rows).toHaveLength(1);
    const row = e.rows[0]!;
    expect(row.memberId).toBe(f.seats.employee.memberId);
    expect([row.clientName, row.projectKey, row.projectName, row.seconds, row.billable]).toEqual(["Acme", "ACME", "Acme site", 3600, true]);
    expect([row.rate, row.currency, row.amount]).toEqual([null, null, null]);
    const csv = entriesCsv(e);
    expect(header(csv)).toBe(
      "id,date,started_at,stopped_at,timezone,seconds,hours,member_id,member,client,project_key,project,task_key,task,agreement,work_type,billable,description,entry_mode,source,needs_review,locked_reason",
    );
    expect(csv).toContain(",Ops,");
    const audit = await lastExportAudit();
    expect(audit.metadata).toMatchObject({ kind: "entries", scope: "own", from: AUGUST.from, to: AUGUST.to, rows: 1, includesCost: false, includesRates: false });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/Acme|Ops/);
  });

  it("team (manager, client:view_all): every closed row of the month incl. ad-hoc; rates and amounts; member/project filters; employee FORBIDDEN", async () => {
    const e = await exportEntries(managerCtx(), AUGUST, { scope: "team" });
    expect(e.includesRates).toBe(true);
    expect(e.rows).toHaveLength(4);
    const ownerTask = e.rows.find((r) => r.taskTitle === "Build the thing")!;
    expect([ownerTask.taskKey, ownerTask.rate, ownerTask.currency, ownerTask.amount]).toEqual(["ACME-1", `${BILL}.00`, "SEK", `${2 * BILL}.00`]);
    const adhoc = e.rows.find((r) => r.projectKey === null)!;
    expect([adhoc.billable, adhoc.rate, adhoc.amount, adhoc.description]).toEqual([false, null, "0.00", "Admin =SUM(1)"]);
    const csv = entriesCsv(e);
    expect(header(csv).endsWith(",locked_reason,rate,currency,amount")).toBe(true);
    // A formula INSIDE a note is harmless and kept verbatim; only a leading `=`/`+`/`-`/`@` is neutralised (csv.test.ts).
    expect(csv).toContain("Admin =SUM(1)");

    const byMember = await exportEntries(managerCtx(), AUGUST, { scope: "team", memberId: f.seats.owner.memberId });
    expect(byMember.rows.map((r) => r.projectKey).sort()).toEqual(["ACME", "BETA"]);
    const byProject = await exportEntries(managerCtx(), AUGUST, { scope: "team", projectId: acmeProject });
    expect(byProject.rows).toHaveLength(2);
    expect(byProject.rows.every((r) => r.projectKey === "ACME")).toBe(true);
    expect((await lastExportAudit()).metadata).toMatchObject({ kind: "entries", scope: "team", projectId: acmeProject, rows: 2, includesRates: true });

    expect(await authzReason(exportEntries(employeeCtx(), AUGUST, { scope: "team" }))).toBe("FORBIDDEN");
  });

  it("team (a scoped custom role): another client's project rows are absent and its project filter is NOT_FOUND; ad-hoc rows stay", async () => {
    const run = randomUUID().slice(0, 8);
    const { roleId } = await createRole({ tenantId: f.tenantId, actor: f.seats.owner.actor, name: `Acme lead ${run}` });
    await setRolePermissions({ tenantId: f.tenantId, actor: f.seats.owner.actor, roleId, codes: ["time:track", "time:view_team", "time:export"] });
    const userId = randomUUID();
    const email = `lead-export-${run}@test.invalid`;
    await f.platform.user.create({ data: { id: userId, name: email, email } });
    const lead = await f.platform.member.create({ data: { tenantId: f.tenantId, userId } });
    await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: lead.id, roleId } });
    await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: lead.id, clientId: acme } });
    const leadCtx = { tenantId: f.tenantId, actor: actorFor(lead.id) };
    try {
      const e = await exportEntries(leadCtx, AUGUST, { scope: "team" });
      expect(e.rows.map((r) => r.projectKey ?? "adhoc").sort()).toEqual(["ACME", "ACME", "adhoc"]);
      expect(e.includesRates).toBe(false); // the role holds no rate:view_bill
      expect(await authzReason(exportEntries(leadCtx, AUGUST, { scope: "team", projectId: betaProject }))).toBe("NOT_FOUND");
      // A member filter can only narrow: the owner's Beta row stays outside the lead's scope.
      const ownerOnly = await exportEntries(leadCtx, AUGUST, { scope: "team", memberId: f.seats.owner.memberId });
      expect(ownerOnly.rows.map((r) => r.projectKey)).toEqual(["ACME"]);
    } finally {
      await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId, memberId: lead.id } });
      await f.platform.memberRole.deleteMany({ where: { tenantId: f.tenantId, memberId: lead.id } });
      await f.platform.member.delete({ where: { id: lead.id } });
      await f.platform.user.delete({ where: { id: userId } });
    }
  });

  it("range guards: reversed or > 366 days is INVALID_INPUT before any query", async () => {
    expect(await domainCode(exportEntries(ownerCtx(), { from: "2026-08-31", to: "2026-08-01" }, { scope: "own" }))).toBe("INVALID_INPUT");
    expect(await domainCode(exportEntries(ownerCtx(), { from: "2025-01-01", to: "2026-12-31" }, { scope: "own" }))).toBe("INVALID_INPUT");
  });
});

describe("project rollup export — amounts with rate:view_bill, cost ONLY through the audited ✦ reveal", () => {
  it("manager: rollup lines + total, amount/currency columns, no cost column; asking for cost without rate:view_cost is ignored and not audited as a reveal", async () => {
    const e = await exportProjectRollup(managerCtx(), acmeProject, AUGUST);
    expect([e.includesAmounts, e.includesCost, e.currency]).toEqual([true, false, "SEK"]);
    const total = e.lines.find((l) => l.dimension === "total")!;
    expect([total.seconds, total.billableSeconds, total.amount, total.cost, total.margin]).toEqual([3 * 3600, 3 * 3600, `${3 * BILL}.00`, null, null]);
    expect(e.lines.filter((l) => l.dimension === "member")).toHaveLength(2);
    expect(e.lines.some((l) => l.dimension === "task" && l.label === "ACME-1 Build the thing")).toBe(true);
    const csv = rollupCsv(e);
    expect(header(csv)).toBe("dimension,key,label,seconds,hours,billable_seconds,billable_hours,amount,currency");
    expect(csv).not.toMatch(/cost|margin/);
    expect((await lastExportAudit()).metadata).toMatchObject({ kind: "project_rollup", projectId: acmeProject, includesCost: false, includesRates: true });

    const asked = await exportProjectRollup(managerCtx(), acmeProject, AUGUST, { includeCost: true });
    expect(asked.includesCost).toBe(false);
    expect(await f.audits("rate_card.cost_revealed")).toHaveLength(0);
    expect((await lastExportAudit()).metadata).toMatchObject({ includesCost: false });
    expect(await authzReason(exportProjectRollup(employeeCtx(), acmeProject, AUGUST))).toBe("FORBIDDEN");
  });

  it("owner: no cost while the tenant's cost layer is off; with it on, cost + margin reconcile, the audit says includesCost=true with no amount; a stale factor is MFA_REQUIRED", async () => {
    const off = await exportProjectRollup(ownerCtx(), acmeProject, AUGUST, { includeCost: true });
    expect(off.includesCost).toBe(false);
    expect(await f.audits("rate_card.cost_revealed")).toHaveLength(0);

    await updatePreferences(ownerCtx(), { finance: { costRatesEnabled: true } });
    const on = await exportProjectRollup(ownerCtx(), acmeProject, AUGUST, { includeCost: true });
    expect(on.includesCost).toBe(true);
    const owner = on.lines.find((l) => l.dimension === "member" && l.key === f.seats.owner.memberId)!;
    expect([owner.amount, owner.cost, owner.margin]).toEqual([`${2 * BILL}.00`, `${2 * COST_OWNER}.00`, `${2 * BILL - 2 * COST_OWNER}.00`]);
    const total = on.lines.find((l) => l.dimension === "total")!;
    expect([total.amount, total.cost, total.margin]).toEqual([`${3 * BILL}.00`, `${2 * COST_OWNER}.00`, `${3 * BILL - 2 * COST_OWNER}.00`]);
    const csv = rollupCsv(on);
    expect(header(csv)).toBe("dimension,key,label,seconds,hours,billable_seconds,billable_hours,amount,currency,cost,margin,margin_percent");
    expect(await f.audits("rate_card.cost_revealed")).toHaveLength(1);
    const audit = await lastExportAudit();
    expect(audit.metadata).toMatchObject({ kind: "project_rollup", includesCost: true });
    expect(Object.keys(audit.metadata as object).sort()).toEqual(["from", "includesCost", "includesRates", "kind", "projectId", "rows", "to"]);
    expect(JSON.stringify(audit.metadata)).not.toMatch(new RegExp(String(COST_OWNER)));

    const stale = { tenantId: f.tenantId, actor: { memberId: f.seats.owner.memberId, mfa: { enrolled: true, verifiedAt: hoursAgo(2) } } };
    const exportsBefore = (await f.audits("time.exported")).length;
    expect(await authzReason(exportProjectRollup(stale, acmeProject, AUGUST, { includeCost: true }))).toBe("MFA_REQUIRED");
    // A refused reveal produces no file and no export audit row.
    expect((await f.audits("time.exported")).length).toBe(exportsBefore);
    // Without the ask the stale factor is irrelevant — the bill half still exports.
    expect((await exportProjectRollup(stale, acmeProject, AUGUST)).includesCost).toBe(false);
  });
});

describe("working-time statement — shift − breaks = worked, tracked ≤ worked, never an open shift, no tracked column for another member", () => {
  it("own (employee): every day of the month, the two closed shifts reconcile, the >5 h-no-break warn flags, the open shift is absent", async () => {
    const s = await workingTimeStatement(employeeCtx(), { month: "2026-08" });
    expect([s.own, s.month, s.from, s.to, s.days.length, s.weekdays]).toEqual([true, "2026-08", "2026-08-01", "2026-08-31", 31, 21]);
    const d3 = s.days.find((d) => d.date === "2026-08-03")!;
    expect([d3.shifts.length, d3.spanSeconds, d3.breakSeconds, d3.workedSeconds, d3.trackedSeconds, d3.unallocatedSeconds]).toEqual([1, 30600, 1800, 28800, 0, 28800]);
    expect([d3.shifts[0]!.noBreak, d3.shifts[0]!.provisional, d3.shifts[0]!.note]).toEqual([false, false, "WFH"]);
    const d4 = s.days.find((d) => d.date === "2026-08-04")!;
    expect([d4.workedSeconds, d4.breakSeconds, d4.trackedSeconds, d4.unallocatedSeconds, d4.shifts[0]!.noBreak]).toEqual([21600, 0, 3600, 18000, true]);
    expect(s.totals).toMatchObject({ shifts: 2, spanSeconds: 52200, breakSeconds: 1800, workedSeconds: 50400, trackedSeconds: 3600, unallocatedSeconds: 46800, provisional: 0, noBreak: 1 });
    expect(s.expectedSeconds).toBeNull(); // no hoursPerDay on the fixture member
    // Open shift: never selected — today's row (the shift started an hour ago) carries no shift.
    const todayRow = s.days.find((d) => d.date === localDateString(new Date(), ZONE));
    if (todayRow) expect(todayRow.shifts).toHaveLength(0);

    const csv = statementCsv(s);
    expect(header(csv)).toBe(
      "date,shift_start,shift_end,shift_start_utc,shift_end_utc,timezone,span_seconds,break_seconds,worked_seconds,worked_hours,provisional,no_break_over_5h,note,tracked_seconds,tracked_hours,unallocated_seconds",
    );
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[1]).toBe(`2026-08-03,08:00,16:30,2026-08-03T06:00:00.000Z,2026-08-03T14:30:00.000Z,${ZONE},30600,1800,28800,8,false,false,WFH,0,0,28800`);
    expect(lines[2]).toBe(`2026-08-04,08:00,14:00,2026-08-04T06:00:00.000Z,2026-08-04T12:00:00.000Z,${ZONE},21600,0,21600,6,false,true,,3600,1,18000`);
    // The TOTAL row leaves the boolean columns empty (counts live on the page); worked = tracked + unallocated.
    expect(lines[lines.length - 1]).toBe("TOTAL,,,,,,52200,1800,50400,14,,,,3600,1,46800");
  });

  it("another member's statement needs time:view_team + time:export, carries no tracked column, and is audited as an export; the employee cannot read the owner's", async () => {
    const s = await exportStatement(managerCtx(), { month: "2026-08", memberId: f.seats.employee.memberId });
    expect([s.own, s.memberId, s.totals.shifts, s.totals.workedSeconds, s.totals.trackedSeconds, s.totals.unallocatedSeconds]).toEqual([
      false,
      f.seats.employee.memberId,
      2,
      50400,
      null,
      null,
    ]);
    expect(s.days.every((d) => d.trackedSeconds === null)).toBe(true);
    // The member's free-text shift note stays on the OWN statement only.
    expect(s.days.flatMap((d) => d.shifts).every((r) => r.note === null)).toBe(true);
    const csv = statementCsv(s);
    expect(header(csv)).toBe("date,shift_start,shift_end,shift_start_utc,shift_end_utc,timezone,span_seconds,break_seconds,worked_seconds,worked_hours,provisional,no_break_over_5h,note");
    expect(csv).not.toMatch(/tracked|WFH/);
    const audit = await lastExportAudit();
    expect(audit.metadata).toMatchObject({ kind: "statement", scope: "team", memberId: f.seats.employee.memberId, month: "2026-08", rows: 2, includesCost: false });
    expect(audit.targetId).toBe(f.seats.employee.memberId);

    expect(await authzReason(workingTimeStatement(employeeCtx(), { month: "2026-08", memberId: f.seats.owner.memberId }))).toBe("FORBIDDEN");
    // The admin template holds time:export but not time:view_team — both are required for another member's statement.
    const adminCtx = { tenantId: f.tenantId, actor: f.seats.admin.actor };
    expect(await authzReason(workingTimeStatement(adminCtx, { month: "2026-08", memberId: f.seats.employee.memberId }))).toBe("FORBIDDEN");
    expect(await domainCode(workingTimeStatement(ownerCtx(), { month: "2026-13" }))).toBe("INVALID_INPUT");
    expect(await domainCode(workingTimeStatement(ownerCtx(), { month: "0099-12" }))).toBe("INVALID_INPUT");
  });
});

describe("rollup export — a COST card in another currency withholds cost and the file says so", () => {
  it("includesCost is false, no cost columns, the filename stem has no with-cost, the audit says includesCost=false — though the ✦ reveal itself was audited", async () => {
    // The employee gets a EUR COST card and a fresh August entry that snapshots it (resolution at write — older rows stay uncosted).
    await createRateCard(ownerCtx(), {
      kind: "COST",
      scope: "MEMBER",
      memberId: f.seats.employee.memberId,
      amount: "40",
      currency: "EUR",
      effectiveFrom: "2026-01-01",
    });
    await createEntry(employeeCtx(), { projectId: acmeProject, description: "Late ops", startedAt: at("2026-08-06T07:00"), stoppedAt: at("2026-08-06T08:00") });
    const revealsBefore = (await f.audits("rate_card.cost_revealed")).length;
    const e = await exportProjectRollup(ownerCtx(), acmeProject, AUGUST, { includeCost: true });
    expect(e.includesCost).toBe(false);
    expect(e.lines.every((l) => l.cost === null && l.margin === null)).toBe(true);
    expect(header(rollupCsv(e))).toBe("dimension,key,label,seconds,hours,billable_seconds,billable_hours,amount,currency");
    expect((await lastExportAudit()).metadata).toMatchObject({ kind: "project_rollup", includesCost: false });
    expect((await f.audits("rate_card.cost_revealed")).length).toBe(revealsBefore + 1);
  });
});
