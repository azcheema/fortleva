import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { DomainError } from "@/lib/domain-error";
import { localDateString } from "@/lib/duration";
import { setupTenant } from "@/members/dbtest-fixture";
import { createRole, setRolePermissions } from "@/members/roles";

import { acknowledgeNotice, canTrackTime, createEntry, getNoticeStatus, myTimeTotals, resetTimeDefaultsMemo, startTimer } from "./index";

/**
 * The /home strip's numbers (UI.md rule 8 "this-week hours (own)"):
 * `myTimeTotals` sums the member's OWN finished seconds for a week range
 * and for one day — never another member's, never the running entry
 * (the client adds that live), never a deleted row — and is gated by
 * time:track like every own read.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acmeProject: string;

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
  f = await setupTenant("totals");
  const acme = randomUUID();
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
}, 60_000);

afterAll(async () => {
  const db = f.platform;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.time_maintenance', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.time_lock_bypass', 'on', true)`;
    await tx.timeEntry.deleteMany({ where: { tenantId: f.tenantId } });
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

// Mon 2 Mar – Sun 8 Mar 2026; "today" = Wed 4 Mar.
const WEEK = { from: "2026-03-02", to: "2026-03-08", today: "2026-03-04" };

describe("myTimeTotals — the /home strip", () => {
  it("sums the member's OWN finished seconds for the week and for today; the running entry and a colleague's rows are not in it", async () => {
    expect(await myTimeTotals(ownerCtx(), WEEK)).toEqual({ weekSeconds: 0, todaySeconds: 0 });
    await createEntry(ownerCtx(), { projectId: acmeProject, description: "Mon", durationText: "2h", localDate: "2026-03-02" });
    await createEntry(ownerCtx(), { projectId: acmeProject, description: "Wed a", startedAt: at("2026-03-04T08:00"), stoppedAt: at("2026-03-04T09:30") });
    await createEntry(ownerCtx(), { projectId: acmeProject, description: "Wed b", durationText: "45m", localDate: "2026-03-04" });
    await createEntry(ownerCtx(), { projectId: acmeProject, description: "Sun", durationText: "1h", localDate: "2026-03-08" });
    await createEntry(ownerCtx(), { projectId: acmeProject, description: "Next Mon", durationText: "3h", localDate: "2026-03-09" }); // outside the week
    await createEntry(employeeCtx(), { projectId: acmeProject, description: "Colleague", durationText: "5h", localDate: "2026-03-04" });
    // A running timer (now — outside the March week anyway, and running): never summed here.
    await startTimer(ownerCtx(), { projectId: acmeProject, description: "Running" });

    expect(await myTimeTotals(ownerCtx(), WEEK)).toEqual({ weekSeconds: 7200 + 5400 + 2700 + 3600, todaySeconds: 5400 + 2700 });
    expect(await myTimeTotals(employeeCtx(), WEEK)).toEqual({ weekSeconds: 5 * 3600, todaySeconds: 5 * 3600 });
    // Today's own window — in the MEMBER's zone (Europe/Stockholm, where the running row's localDate lives; a UTC
    // "today" would miss the row by date for two hours a day and prove nothing): the running timer is excluded (stoppedAt null).
    const now = localDateString(new Date(), "Europe/Stockholm");
    const todayTotals = await myTimeTotals(ownerCtx(), { from: now, to: now, today: now });
    expect(todayTotals.weekSeconds).toBe(0);
    expect(todayTotals.todaySeconds).toBe(0);
  });

  it("is gated by time:track and refuses a malformed or inconsistent range", async () => {
    expect(await domainCode(myTimeTotals(ownerCtx(), { from: "2026-03-02", to: "2026-03-08", today: "2026-13-04" }))).toBe("INVALID_INPUT");
    expect(await domainCode(myTimeTotals(ownerCtx(), { from: "2026-03-08", to: "2026-03-02", today: "2026-03-04" }))).toBe("INVALID_INPUT");
    expect(await domainCode(myTimeTotals(ownerCtx(), { from: "2026-03-02", to: "2026-03-08", today: "2026-03-09" }))).toBe("INVALID_INPUT");
    // The strip's gate: a permitted member may, a member without time:track may not — decided before any service runs.
    expect(await canTrackTime(ownerCtx())).toBe(true);
    // A role without time:track (the fixture's seats all have it): a fresh member on a permission-less role.
    // Every row the seat needs is created INSIDE the try, so a failure half-way still tears it down (the User row is
    // not tenant-scoped and is not among the fixture's own four).
    const { roleId } = await createRole({ tenantId: f.tenantId, actor: f.seats.owner.actor, name: "Viewer only" });
    const userId = randomUUID();
    let memberId: string | null = null;
    try {
      await setRolePermissions({ tenantId: f.tenantId, actor: f.seats.owner.actor, roleId, codes: [] });
      await f.platform.user.create({ data: { id: userId, name: "Viewer", email: `viewer-${f.tenantId.slice(0, 8)}@test.invalid` } });
      memberId = (await f.platform.member.create({ data: { tenantId: f.tenantId, userId } })).id;
      await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId, roleId } });
      const viewer = { tenantId: f.tenantId, actor: { memberId } };
      expect(await canTrackTime(viewer)).toBe(false);
      expect(await authzReason(myTimeTotals(viewer, WEEK))).toBe("FORBIDDEN");
    } finally {
      if (memberId) await f.platform.memberRole.deleteMany({ where: { tenantId: f.tenantId, memberId } });
      if (memberId) await f.platform.member.delete({ where: { id: memberId } });
      await f.platform.user.deleteMany({ where: { id: userId } });
      await f.platform.rolePermission.deleteMany({ where: { tenantId: f.tenantId, roleId } });
      await f.platform.role.delete({ where: { id: roleId } });
    }
  });
});
