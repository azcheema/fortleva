import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { DomainError } from "@/lib/domain-error";
import { dateColumn, startOfLocalDay } from "@/lib/duration";
import { setupTenant } from "@/members/dbtest-fixture";
import { createItem } from "@/modules/work";
import { updatePreferences } from "@/preferences/service";

import {
  acknowledgeNotice,
  copyWeek,
  createEntry,
  createRateCard,
  getNoticeStatus,
  hasFinishedEntries,
  listMyEntries,
  resetTimeDefaultsMemo,
  updateEntry,
} from "./index";

/**
 * Copy-last-week against the real database and the real app_runtime
 * role (UI.md rule 9, D6 "copy-last-week copies rows, never hours"):
 * the member's own finished rows of the seven days before the viewed
 * grid week become one DURATION row per (weekday, target) in that week
 * — EMPTY by default, summed only on the explicit `withDurations`; the
 * service snaps `weekFrom` to the tenant's week start; the copy is
 * idempotent, resolves rates for the target date, recomputes the touched
 * summaries in the same transaction, audits ids only, skips a row whose
 * target no longer resolves, never promotes provisional hours, and is
 * gated like every own write (time:track, the staff notice). The empty
 * row it creates is a full citizen: its other fields stay editable, it
 * can be emptied back to 0, and an anchored row given a clock position
 * becomes MANUAL. Plus the overlap rule the copy depends on: DURATION
 * rows — anchored at midnight, no clock — neither flag nor block an
 * overlap; timer/manual rows still do.
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
const iso = (d: Date) => d.toISOString().slice(0, 10);
const ZONE = "Europe/Stockholm"; // the tenant default — every row is written in it

beforeAll(async () => {
  resetTimeDefaultsMemo();
  f = await setupTenant("copy");
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
  await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: acme } });
  task = (await createItem(ownerCtx(), { projectId: acmeProject, title: "Build the thing" })).id;
  // The owner and the employee acknowledge; the manager deliberately does NOT (the gate test below).
  for (const ctx of [ownerCtx(), employeeCtx()]) {
    const s = await getNoticeStatus(ctx);
    await acknowledgeNotice(ctx, s.notice!.id);
  }
  await createRateCard(ownerCtx(), { kind: "BILL", scope: "PROJECT", projectId: acmeProject, amount: "1000", currency: "SEK", effectiveFrom: "2026-01-01" });
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
  resetTimeDefaultsMemo();
  await f.cleanup();
}, 60_000);

// Week 1: Mon 4 May – Sun 10 May 2026 → copied into Mon 11 May – Sun 17 May.
const W1 = { from: "2026-05-04", to: "2026-05-10" };
const W1_NEXT = { from: "2026-05-11", to: "2026-05-17" };
// Week 2: Mon 6 Apr – Sun 12 Apr 2026 → copied into Mon 13 Apr – Sun 19 Apr (the "with durations" week).
const W2_NEXT = { from: "2026-04-13", to: "2026-04-19" };

describe("copy last week — rows, never hours", () => {
  let sourceIds: string[] = [];

  it("copies one EMPTY DURATION row per (weekday, target) onto the same weekday of the next week; rates re-resolve for the target date; audited with ids only", async () => {
    expect(await hasFinishedEntries(ownerCtx(), W1)).toBe(false);
    // Mon: the task twice (two timer-style starts ⇒ ONE row), project-level "Design"; Wed: an ad-hoc note; Thu: Beta.
    const a = await createEntry(ownerCtx(), { workItemId: task, startedAt: at("2026-05-04T08:00"), stoppedAt: at("2026-05-04T09:00") });
    const b = await createEntry(ownerCtx(), { workItemId: task, startedAt: at("2026-05-04T10:00"), stoppedAt: at("2026-05-04T10:30") });
    const c = await createEntry(ownerCtx(), { projectId: acmeProject, description: "Design", billable: false, durationText: "45m", localDate: "2026-05-04" });
    const d = await createEntry(ownerCtx(), { description: "Admin", durationText: "20m", localDate: "2026-05-06" });
    const e = await createEntry(ownerCtx(), { projectId: betaProject, description: "Beta work", durationText: "1h", localDate: "2026-05-07" });
    sourceIds = [a.id, b.id, c.id, d.id, e.id];
    expect(await hasFinishedEntries(ownerCtx(), W1)).toBe(true);
    expect(await hasFinishedEntries(employeeCtx(), W1)).toBe(false); // own rows only
    const before = (await f.audits("time_entry.created")).length;

    // The service snaps to the grid week: a Wednesday names the same week as its Monday.
    const r = await copyWeek(ownerCtx(), { weekFrom: "2026-05-13", withDurations: false });
    expect(r).toEqual({ created: 4, alreadyPresent: 0, unusable: 0 });

    const rows = await listMyEntries(ownerCtx(), W1_NEXT);
    expect(rows).toHaveLength(4);
    expect(rows.every((x) => x.entryMode === "DURATION" && x.durationSeconds === 0 && x.stoppedAt !== null)).toBe(true);
    expect(rows.map((x) => iso(x.localDate))).toEqual(["2026-05-11", "2026-05-11", "2026-05-13", "2026-05-14"]);
    // Anchored at the member's local day start, like a typed duration.
    expect(rows[0]!.startedAt.getTime()).toBe(startOfLocalDay("2026-05-11", ZONE).getTime());
    const taskRow = rows.find((x) => x.workItemId === task)!;
    expect(taskRow.projectId).toBe(acmeProject);
    expect(taskRow.billable).toBe(true);
    // The BILL card resolves for 11 May (the owner holds rate:view_bill, so the snapshot is visible).
    expect(taskRow.billRate).toBe("1000");
    const design = rows.find((x) => x.description === "Design")!;
    expect(design.billable).toBe(false); // the source's explicit choice, not the project default
    expect(design.workItemId).toBeNull();
    const adhoc = rows.find((x) => x.description === "Admin")!;
    expect(adhoc.projectId).toBeNull();
    expect(adhoc.billable).toBe(false);
    expect(rows.find((x) => x.projectId === betaProject)!.description).toBe("Beta work");
    // Neither overlap-flagged (two anchored rows on 11 May) nor needing review.
    expect(rows.every((x) => !x.overlaps && !x.needsReview)).toBe(true);

    const audits = (await f.audits("time_entry.created")).slice(before);
    expect(audits).toHaveLength(4);
    for (const row of audits) {
      const meta = row.metadata as Record<string, unknown>;
      expect(meta.mode).toBe("DURATION");
      expect(meta.withDurations).toBe(false);
      expect(sourceIds).toContain(meta.copiedFrom);
      expect(meta.durationSeconds).toBe(0);
      expect(Object.keys(meta)).not.toContain("description");
    }
    // The source week is untouched.
    expect((await listMyEntries(ownerCtx(), W1)).map((x) => x.id).sort()).toEqual([...sourceIds].sort());
  });

  it("is idempotent: copying again — rows or durations — adds nothing and says why; the member's own rows only", async () => {
    expect(await copyWeek(ownerCtx(), { weekFrom: W1_NEXT.from, withDurations: false })).toEqual({ created: 0, alreadyPresent: 4, unusable: 0 });
    expect(await copyWeek(ownerCtx(), { weekFrom: W1_NEXT.from, withDurations: true })).toEqual({ created: 0, alreadyPresent: 4, unusable: 0 });
    expect((await listMyEntries(ownerCtx(), W1_NEXT)).every((x) => x.durationSeconds === 0)).toBe(true);
    // The employee has no rows in that week: nothing of the owner's is copied for them.
    expect(await copyWeek(employeeCtx(), { weekFrom: W1_NEXT.from, withDurations: false })).toEqual({ created: 0, alreadyPresent: 0, unusable: 0 });
    expect(await listMyEntries(employeeCtx(), W1_NEXT)).toHaveLength(0);
  });

  it("an empty copied row is a full citizen: its other fields are editable, it can be emptied back to 0, and a clock position turns it MANUAL", async () => {
    const rows = await listMyEntries(ownerCtx(), W1_NEXT);
    const design = rows.find((x) => x.description === "Design")!;
    // Billable flips on the 0 s row without touching the interval.
    const flipped = await updateEntry(ownerCtx(), design.id, { billable: true });
    expect(flipped.billable).toBe(true);
    expect(flipped.durationSeconds).toBe(0);
    // Fill the hours in, then empty it again ("0m" — a typed zero is allowed on an anchored row only).
    expect((await updateEntry(ownerCtx(), design.id, { durationText: "1h 15m" })).durationSeconds).toBe(4500);
    expect((await updateEntry(ownerCtx(), design.id, { durationText: "0m" })).durationSeconds).toBe(0);
    expect((await updateEntry(ownerCtx(), design.id, { durationText: "0" })).durationSeconds).toBe(0);
    expect(await domainCode(updateEntry(ownerCtx(), design.id, { durationText: "nonsense" }))).toBe("INVALID_DURATION");
    // A positioned row cannot be zeroed …
    const manual = await createEntry(ownerCtx(), { projectId: acmeProject, description: "Manual", startedAt: at("2026-05-12T08:00"), stoppedAt: at("2026-05-12T09:00") });
    expect(await domainCode(updateEntry(ownerCtx(), manual.id, { durationText: "0m" }))).toBe("INVALID_DURATION");
    // … and an anchored row given a clock position is MANUAL from then on (the overlap rules follow the data, not a stale mode).
    const positioned = await updateEntry(ownerCtx(), design.id, { startedAt: at("2026-05-11T07:00"), stoppedAt: at("2026-05-11T08:00") });
    expect(positioned.entryMode).toBe("MANUAL");
    expect(positioned.durationSeconds).toBe(3600);
    expect(await domainCode(updateEntry(ownerCtx(), design.id, { durationText: "0m" }))).toBe("INVALID_DURATION");
  });

  it("'copy with durations' writes the group's SUM of confirmed seconds; the touched month's summary is recomputed in the same transaction; an archived project's row is skipped, not a reason to refuse", async () => {
    await createEntry(ownerCtx(), { workItemId: task, startedAt: at("2026-04-06T08:00"), stoppedAt: at("2026-04-06T09:00") });
    await createEntry(ownerCtx(), { workItemId: task, startedAt: at("2026-04-06T10:00"), stoppedAt: at("2026-04-06T10:30") });
    await createEntry(ownerCtx(), { projectId: acmeProject, description: "Design", durationText: "2h", localDate: "2026-04-07" });
    await createEntry(ownerCtx(), { projectId: betaProject, description: "Beta work", durationText: "1h", localDate: "2026-04-08" });
    // A provisional (auto-stopped, unconfirmed) row: its hours must not become clean copied hours.
    const provisional = await createEntry(ownerCtx(), { projectId: acmeProject, description: "Forgot the timer", durationText: "9h", localDate: "2026-04-09" });
    await f.platform.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.time_maintenance', 'on', true)`;
      await tx.timeEntry.update({ where: { id: provisional.id }, data: { needsReview: true, reviewReason: "AUTO_STOPPED" } });
    });
    await f.platform.project.update({ where: { id: betaProject }, data: { archivedAt: new Date() } });
    try {
      const r = await copyWeek(ownerCtx(), { weekFrom: W2_NEXT.from, withDurations: true });
      expect(r).toEqual({ created: 3, alreadyPresent: 0, unusable: 1 });
      const rows = await listMyEntries(ownerCtx(), W2_NEXT);
      expect(rows.map((x) => [iso(x.localDate), x.description ?? "task", x.durationSeconds, x.needsReview])).toEqual([
        ["2026-04-13", "task", 5400, false],
        ["2026-04-14", "Design", 7200, false],
        ["2026-04-16", "Forgot the timer", 0, false], // the row copies, its unconfirmed 9 h do not
      ]);
      expect(rows.every((x) => x.projectId === acmeProject)).toBe(true);
      // summary == SUM for (Acme, April): the four source rows + the three copies.
      const april = await f.platform.timeEntry.aggregate({
        where: { tenantId: f.tenantId, projectId: acmeProject, deletedAt: null, localDate: { gte: dateColumn("2026-04-01"), lte: dateColumn("2026-04-30") } },
        _sum: { durationSeconds: true },
      });
      const summary = await f.platform.projectTimeSummary.findUnique({
        where: { tenantId_projectId_periodMonth: { tenantId: f.tenantId, projectId: acmeProject, periodMonth: dateColumn("2026-04-01") } },
      });
      expect(summary).not.toBeNull();
      expect(summary!.billableSeconds + summary!.nonBillableSeconds).toBe(april._sum.durationSeconds);
      expect(april._sum.durationSeconds).toBe(3600 + 1800 + 7200 + 9 * 3600 + 5400 + 7200 + 0);
    } finally {
      await f.platform.project.update({ where: { id: betaProject }, data: { archivedAt: null } });
    }
  });

  it("is gated like every own write: the staff notice must be acknowledged; a bad week is INVALID_INPUT", async () => {
    expect(await domainCode(copyWeek(managerCtx(), { weekFrom: W1_NEXT.from, withDurations: false }))).toBe("NOTICE_UNACKNOWLEDGED");
    expect(await domainCode(copyWeek(ownerCtx(), { weekFrom: "2026-13-01", withDurations: false }))).toBe("INVALID_INPUT");
    expect(await domainCode(copyWeek(ownerCtx(), { weekFrom: "9999-12-31", withDurations: false }))).toBe("INVALID_INPUT");
    // Scope: the employee is assigned to Acme only. A Beta row written FOR them (owner, time:edit_any) is theirs,
    // but Beta is outside their scope now — the copy counts it unusable and writes nothing, instead of refusing or leaking.
    await createEntry(ownerCtx(), {
      memberId: f.seats.employee.memberId,
      projectId: betaProject,
      description: "Beta for the employee",
      durationText: "1h",
      localDate: "2026-04-08",
    });
    expect(await authzReason(copyWeek(employeeCtx(), { weekFrom: W2_NEXT.from, withDurations: false }))).toBe("resolved");
    expect(await copyWeek(employeeCtx(), { weekFrom: W2_NEXT.from, withDurations: false })).toEqual({ created: 0, alreadyPresent: 0, unusable: 1 });
    expect(await listMyEntries(employeeCtx(), W2_NEXT)).toHaveLength(0);
  });
});

describe("overlaps: DURATION rows are anchored, not positioned", () => {
  it("two typed durations on one day neither flag nor block each other — even with the tenant's strict setting; timer/manual rows still do", async () => {
    const day = "2026-03-02";
    const a = await createEntry(ownerCtx(), { projectId: acmeProject, description: "A", durationText: "1h", localDate: day });
    const b = await createEntry(ownerCtx(), { projectId: acmeProject, description: "B", durationText: "2h", localDate: day });
    const flagged = (await listMyEntries(ownerCtx(), { from: day, to: day })).filter((x) => x.overlaps).map((x) => x.id);
    expect(flagged).toEqual([]);

    await updatePreferences(ownerCtx(), { time: { allowOverlap: false } });
    try {
      // A third anchored row on the same day is fine; a manual row inside the anchored span is fine too…
      expect(await domainCode(createEntry(ownerCtx(), { projectId: acmeProject, description: "C", durationText: "3h", localDate: day }))).toBe("resolved");
      const m1 = await createEntry(ownerCtx(), { projectId: acmeProject, description: "M1", startedAt: at("2026-03-02T00:30"), stoppedAt: at("2026-03-02T01:00") });
      // …but two MANUAL rows that really intersect are blocked by the strict setting.
      expect(
        await domainCode(createEntry(ownerCtx(), { projectId: acmeProject, description: "M2", startedAt: at("2026-03-02T00:45"), stoppedAt: at("2026-03-02T01:15") })),
      ).toBe("OVERLAP_BLOCKED");
      // An anchored row that is GIVEN a clock position becomes positioned (MANUAL) and is blocked like one.
      expect(
        await domainCode(updateEntry(ownerCtx(), a.id, { startedAt: at("2026-03-02T00:45"), stoppedAt: at("2026-03-02T01:15") })),
      ).toBe("OVERLAP_BLOCKED");
      const rows = await listMyEntries(ownerCtx(), { from: day, to: day });
      expect(rows.filter((x) => x.overlaps)).toEqual([]); // m1 is alone among positioned rows
      expect(rows.map((x) => x.id)).toEqual(expect.arrayContaining([a.id, b.id, m1.id]));
    } finally {
      await updatePreferences(ownerCtx(), { time: { allowOverlap: true } });
    }
  });
});
