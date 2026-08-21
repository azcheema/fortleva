import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { DomainError } from "@/lib/domain-error";
import { dateColumn } from "@/lib/duration";
import { setupTenant } from "@/members/dbtest-fixture";

import { acknowledgeNotice, createEntry, createRateCard, getNoticeStatus, listMyEntries, resetTimeDefaultsMemo, splitEntry, startTimer } from "./index";

/**
 * Split (UI.md rule 9 "edit own past, split") against the real database:
 * a finished, unlocked own entry becomes two — the first keeps its id, the
 * second is a new row with the SAME target, mode, source, billable choice
 * and rate snapshot (no re-home, no reprice — unless the second half lands
 * on another local date, where the module's "rates re-resolve on a change
 * of local date" rule applies); a positioned row splits at the clock
 * instant, an anchored DURATION row stays anchored; the summaries still
 * add up; both halves are audited; a provisional row's remainder stays
 * provisional while the member-shaped first half is confirmed; a running,
 * locked, too-short, unknown or archived-target split is refused; another
 * member's row needs time:edit_any.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acmeProject: string;
let acme: string;

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });
const at = (s: string) => new Date(`${s}:00Z`);
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

beforeAll(async () => {
  resetTimeDefaultsMemo();
  f = await setupTenant("split");
  acme = randomUUID();
  acmeProject = randomUUID();
  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: "Acme" } });
  await f.platform.project.create({
    data: { id: acmeProject, tenantId: f.tenantId, clientId: acme, key: "ACME", name: "Acme site", billingCurrency: "SEK" },
  });
  await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: acme } });
  for (const ctx of [ownerCtx(), employeeCtx()]) {
    const s = await getNoticeStatus(ctx);
    await acknowledgeNotice(ctx, s.notice!.id);
  }
  // 900 SEK/h through February, 1100 from 1 March (the cross-midnight/cross-month split below).
  await createRateCard(ownerCtx(), { kind: "BILL", scope: "PROJECT", projectId: acmeProject, amount: "900", currency: "SEK", effectiveFrom: "2026-01-01", closeOpen: true });
  await createRateCard(ownerCtx(), { kind: "BILL", scope: "PROJECT", projectId: acmeProject, amount: "1100", currency: "SEK", effectiveFrom: "2026-03-01", closeOpen: true });
}, 60_000);

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
  await db.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  resetTimeDefaultsMemo();
  await f.cleanup();
}, 60_000);

const summarySeconds = async (month: string) => {
  const s = await f.platform.projectTimeSummary.findUnique({
    where: { tenantId_projectId_periodMonth: { tenantId: f.tenantId, projectId: acmeProject, periodMonth: dateColumn(month) } },
  });
  return s ? s.billableSeconds + s.nonBillableSeconds : 0;
};

describe("splitEntry", () => {
  it("splits a positioned row at the clock instant: the first keeps its id, the second copies target + snapshot; the summary is unchanged; both audited with ids only", async () => {
    const original = await createEntry(ownerCtx(), { projectId: acmeProject, description: "Design", startedAt: at("2026-02-03T08:00"), stoppedAt: at("2026-02-03T10:00") });
    const before = await summarySeconds("2026-02-01");
    const updatedBefore = (await f.audits("time_entry.updated")).length;
    const createdBefore = (await f.audits("time_entry.created")).length;

    const { first, second } = await splitEntry(ownerCtx(), original.id, { first: "45m" });
    expect(first.id).toBe(original.id);
    expect([first.startedAt.toISOString(), first.stoppedAt!.toISOString(), first.durationSeconds]).toEqual([at("2026-02-03T08:00").toISOString(), at("2026-02-03T08:45").toISOString(), 2700]);
    expect([second.startedAt.toISOString(), second.stoppedAt!.toISOString(), second.durationSeconds]).toEqual([at("2026-02-03T08:45").toISOString(), at("2026-02-03T10:00").toISOString(), 4500]);
    expect(second.id).not.toBe(first.id);
    expect([second.projectId, second.description, second.billable, second.entryMode]).toEqual([acmeProject, "Design", true, "MANUAL"]);
    // The same snapshot on both halves (no reprice), visible to the owner (rate:view_bill).
    const rows = await listMyEntries(ownerCtx(), { from: "2026-02-03", to: "2026-02-03" });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(first.id)!.billRate).toBe("900");
    expect(byId.get(second.id)!.billRate).toBe("900");
    expect(byId.get(second.id)!.rateSource).toBe(byId.get(first.id)!.rateSource);
    expect(await summarySeconds("2026-02-01")).toBe(before);
    const updated = (await f.audits("time_entry.updated")).slice(updatedBefore);
    expect(updated).toHaveLength(1);
    expect((updated[0]!.metadata as Record<string, unknown>).secondId).toBe(second.id);
    const created = (await f.audits("time_entry.created")).slice(createdBefore);
    expect(created).toHaveLength(1);
    expect((created[0]!.metadata as Record<string, unknown>).splitFrom).toBe(first.id);
    expect(Object.keys(created[0]!.metadata as object)).not.toContain("description");
  });

  it("an anchored DURATION row stays anchored: both halves start at the day's 00:00 with their own lengths", async () => {
    const original = await createEntry(ownerCtx(), { projectId: acmeProject, description: "Typed", durationText: "3h", localDate: "2026-02-04" });
    const { first, second } = await splitEntry(ownerCtx(), original.id, { first: "1h" });
    expect(first.startedAt.getTime()).toBe(original.startedAt.getTime());
    expect(first.durationSeconds).toBe(3600);
    expect(second.startedAt.getTime()).toBe(original.startedAt.getTime());
    expect(second.durationSeconds).toBe(7200);
    expect(second.entryMode).toBe("DURATION");
    expect(second.localDate.toISOString().slice(0, 10)).toBe("2026-02-04");
  });

  it("a positioned half that starts past midnight belongs to that day, and — a new local date — re-resolves its rate, as an edit would", async () => {
    // 23:00 28 Feb – 01:00 1 Mar Stockholm (22:00–00:00Z) → split after 90 min: the second half starts 00:30 on 1 March.
    const original = await createEntry(ownerCtx(), { projectId: acmeProject, description: "Late", startedAt: at("2026-02-28T22:00"), stoppedAt: at("2026-03-01T00:00") });
    expect(original.localDate.toISOString().slice(0, 10)).toBe("2026-02-28");
    const { first, second } = await splitEntry(ownerCtx(), original.id, { first: "1h 30m" });
    expect(first.localDate.toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(second.localDate.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(second.durationSeconds).toBe(1800);
    const feb = await listMyEntries(ownerCtx(), { from: "2026-02-28", to: "2026-02-28" });
    const mar = await listMyEntries(ownerCtx(), { from: "2026-03-01", to: "2026-03-01" });
    expect(feb.find((r) => r.id === first.id)!.billRate).toBe("900");
    expect(mar.find((r) => r.id === second.id)!.billRate).toBe("1100");
    // Each month's summary carries its own half.
    expect(await summarySeconds("2026-03-01")).toBe(1800);
  });

  it("a provisional (auto-stopped) row: the member-shaped first half is confirmed, the remainder stays provisional", async () => {
    const row = await createEntry(ownerCtx(), { projectId: acmeProject, description: "Forgot", durationText: "9h", localDate: "2026-02-10" });
    await f.platform.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.time_maintenance', 'on', true)`;
      await tx.timeEntry.update({ where: { id: row.id }, data: { needsReview: true, reviewReason: "AUTO_STOPPED" } });
    });
    const { first, second } = await splitEntry(ownerCtx(), row.id, { first: "3h" });
    expect([first.needsReview, first.reviewReason]).toEqual([false, null]);
    expect([second.needsReview, second.reviewReason]).toEqual([true, "AUTO_STOPPED"]);
    const stored = await f.platform.timeEntry.findUnique({ where: { id: second.id }, select: { needsReview: true, reviewReason: true } });
    expect(stored).toEqual({ needsReview: true, reviewReason: "AUTO_STOPPED" });
  });

  it("two splits of the same row at once: exactly one wins, the member's seconds are conserved (the re-read under the lock)", async () => {
    const row = await createEntry(ownerCtx(), { projectId: acmeProject, description: "Raced", durationText: "1h", localDate: "2026-02-12" });
    const outcomes = await Promise.all([
      domainCode(splitEntry(ownerCtx(), row.id, { first: "20m" })),
      domainCode(splitEntry(ownerCtx(), row.id, { first: "30m" })),
    ]);
    expect(outcomes.filter((o) => o === "resolved")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "INVALID_INPUT")).toHaveLength(1);
    const rows = (await listMyEntries(ownerCtx(), { from: "2026-02-12", to: "2026-02-12" })).filter((r) => r.description === "Raced");
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + (r.durationSeconds ?? 0), 0)).toBe(3600);
  });

  it("refuses a running, locked, unknown, too-short or malformed split and an archived target; another member's row needs time:edit_any", async () => {
    const short = await createEntry(ownerCtx(), { projectId: acmeProject, description: "Short", durationText: "1m", localDate: "2026-02-07" });
    expect(await domainCode(splitEntry(ownerCtx(), short.id, { first: "1m" }))).toBe("SPLIT_TOO_SHORT");
    const two = await createEntry(ownerCtx(), { projectId: acmeProject, description: "Two", durationText: "2m", localDate: "2026-02-07" });
    expect(await domainCode(splitEntry(ownerCtx(), two.id, { first: "2m" }))).toBe("SPLIT_TOO_SHORT"); // nothing left for the second
    expect(await domainCode(splitEntry(ownerCtx(), two.id, { first: "0m" }))).toBe("INVALID_DURATION");
    expect(await domainCode(splitEntry(ownerCtx(), two.id, { first: "nonsense" }))).toBe("INVALID_DURATION");
    expect((await splitEntry(ownerCtx(), two.id, { first: "1m" })).second.durationSeconds).toBe(60); // the smallest legal split
    expect(await domainCode(splitEntry(ownerCtx(), randomUUID(), { first: "1m" }))).toBe("INVALID_INPUT");
    const running = await startTimer(ownerCtx(), { projectId: acmeProject, description: "Running" });
    expect(await domainCode(splitEntry(ownerCtx(), running.started.id, { first: "1m" }))).toBe("INVALID_INPUT");
    const locked = await createEntry(ownerCtx(), { projectId: acmeProject, description: "Locked", durationText: "2h", localDate: "2026-02-08" });
    await f.platform.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.time_lock_bypass', 'on', true)`;
      await tx.timeEntry.update({ where: { id: locked.id }, data: { lockedReason: "INVOICED", lockedAt: new Date() } });
    });
    expect(await domainCode(splitEntry(ownerCtx(), locked.id, { first: "1h" }))).toBe("ENTRY_LOCKED");
    // A row whose project has since been archived: a split mints a row, so it is refused like any new row would be.
    const onArchived = await createEntry(ownerCtx(), { projectId: acmeProject, description: "Before archive", durationText: "2h", localDate: "2026-02-11" });
    await f.platform.project.update({ where: { id: acmeProject }, data: { archivedAt: new Date() } });
    try {
      expect(await domainCode(splitEntry(ownerCtx(), onArchived.id, { first: "1h" }))).toBe("ARCHIVED");
    } finally {
      await f.platform.project.update({ where: { id: acmeProject }, data: { archivedAt: null } });
    }
    // The employee (time:track, no time:edit_any) may not split the owner's row; the owner (time:edit_any) may split the employee's.
    const owners = await createEntry(ownerCtx(), { projectId: acmeProject, description: "Owner's", durationText: "1h", localDate: "2026-02-09" });
    expect(await authzReason(splitEntry(employeeCtx(), owners.id, { first: "10m" }))).toBe("FORBIDDEN");
    const theirs = await createEntry(employeeCtx(), { projectId: acmeProject, description: "Employee's", durationText: "1h", localDate: "2026-02-09" });
    const editedBefore = (await f.audits("time_entry.edited_by_other")).length;
    const { second } = await splitEntry(ownerCtx(), theirs.id, { first: "10m" });
    const mine = await listMyEntries(employeeCtx(), { from: "2026-02-09", to: "2026-02-09" });
    expect(mine.map((r) => r.id)).toEqual(expect.arrayContaining([theirs.id, second.id])); // both halves stay the employee's
    const edited = (await f.audits("time_entry.edited_by_other")).slice(editedBefore);
    expect(edited.map((a) => a.targetId).sort()).toEqual([theirs.id, second.id].sort()); // both halves audited as edited_by_other
  });
});
