import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { todayIn } from "@/lib/due-date";
import { localHourInstant } from "@/lib/duration";
import { addDays } from "@/lib/week";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";

import { guarded } from "./db-errors";
import { createItem } from "./items";
import { publishScheduledUpdates } from "./scheduled-updates";
import { readUpdateSchedule } from "./update-reminders";
import {
  createUpdateDraft,
  discardUpdateDraft,
  listUpdates,
  publishUpdate,
  scheduleUpdate,
  unscheduleUpdate,
  updateUpdateDraft,
} from "./updates";

/**
 * SCHEDULED PROGRESS UPDATES against the real database and app_runtime
 * (slice 135; founder decision C112): scheduling (the publish code, the
 * hour's bounds, the audience), the LOCK (the service's refusals and the
 * trigger's belt), unscheduling, the CHECKs, and the job's per-workspace body
 * — a due post published as its scheduler to the audience they chose, the
 * schedule cleared, audited as SYSTEM; each refusal (no longer allowed, late,
 * archived) cleared, recorded and told; a suspended scheduler told nothing;
 * and the reminders' schedule badge going quiet for a post that will count.
 *
 * It calls the per-workspace `publishScheduledUpdates` ONLY — never the job's
 * cross-tenant `runScheduledUpdates`, which would publish every workspace's
 * due posts on the shared dev database (AGENTS.md). THE JOB'S CLOCK IS PASSED
 * IN: a schedule must lie in the future when it is made, so the run is told
 * it is ten minutes past the hour (or a day and more).
 *
 * Tenant slug prefix `updsched-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

const ZONE = "Europe/Stockholm";
const run = randomUUID().slice(0, 8);

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let pOn: string;
let pArc: string;
let pRem: string;
let managerName: string;
/** Members this file creates beyond the fixture's seats. */
const extras: { userId: string; memberId: string | null }[] = [];

type Seat = "owner" | "admin" | "manager" | "employee";
const ctxOf = (seat: Seat) => ({ tenantId: f.tenantId, actor: f.seats[seat].actor });
const ctxFor = (memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const fields = (text: string) => ({
  health: "ON_TRACK" as const,
  title: `Update ${run}`,
  periodStart: null,
  periodEnd: null,
  body: { sections: [{ key: "SUMMARY", body: doc(text) }] },
});

const domainCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};
const refused = async (p: Promise<unknown>): Promise<boolean> => {
  try {
    await p;
    return false;
  } catch (e) {
    if (e instanceof AuthzError) return true;
    throw e;
  }
};

/** Tomorrow on the workspace's clock — any hour of it lies after now. */
const tomorrow = () => addDays(todayIn(ZONE), 1);
/**
 * The day every schedule here names, taken ONCE (the code review's NIT): a
 * file re-reading the clock in its assertions fails when it runs across
 * midnight; taken once, its 08:00–11:00 still lie ahead after midnight
 * unless the file runs for hours.
 */
let DAY: string;
const hourOn = (date: string, hour: number) => localHourInstant(date, hour, ZONE);
const minutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);

const draftBy = async (ctx: { tenantId: string; actor: ReturnType<typeof actorFor> }, projectId: string, text: string) =>
  (await createUpdateDraft(ctx, projectId, fields(text))).id;

const scheduleBy = (
  ctx: { tenantId: string; actor: ReturnType<typeof actorFor> },
  id: string,
  over: { visibility?: "INTERNAL" | "CLIENT_VISIBLE"; date?: string; hour?: number } = {},
) =>
  scheduleUpdate(ctx, id, {
    visibility: over.visibility ?? "CLIENT_VISIBLE",
    date: over.date ?? DAY,
    hour: over.hour ?? 9,
    timeZone: ZONE,
  });

const rowOf = (id: string) =>
  f.platform.projectUpdate.findFirstOrThrow({
    where: { tenantId: f.tenantId, id },
    include: { internalSnapshot: true },
  });

const auditsOf = (targetId: string) =>
  f.platform.auditEvent.findMany({
    where: { tenantId: f.tenantId, targetType: "ProjectUpdate", targetId },
    select: { action: true, actorType: true, actorId: true, metadata: true },
    orderBy: { createdAt: "asc" },
  });

const failedNotes = (receiverId: string) =>
  f.platform.notification.findMany({
    where: { tenantId: f.tenantId, kind: "project_update.schedule_failed", receiverId },
    select: { entityType: true, entityId: true, reason: true, params: true },
  });

async function extraMember(roleId: string, label: string): Promise<string> {
  const userId = randomUUID();
  await f.platform.user.create({ data: { id: userId, name: `${label} ${run}`, email: `${label}-updsched-${userId.slice(0, 8)}@test.invalid` } });
  const entry: { userId: string; memberId: string | null } = { userId, memberId: null };
  extras.push(entry);
  const member = await f.platform.member.create({ data: { tenantId: f.tenantId, userId }, select: { id: true } });
  entry.memberId = member.id;
  await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: member.id, roleId } });
  return member.id;
}

beforeAll(async () => {
  DAY = tomorrow();
  f = await setupTenant("updsched");
  acme = randomUUID();
  pOn = randomUUID();
  pArc = randomUUID();
  pRem = randomUUID();
  const up = run.slice(0, 3).toUpperCase();
  managerName = (await f.platform.user.findFirstOrThrow({ where: { id: f.seats.manager.userId }, select: { name: true } })).name;
  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: `Acme ${run}` } });
  await f.platform.project.createMany({
    data: [
      { id: pOn, tenantId: f.tenantId, clientId: acme, key: `USA${up}`, name: `Site ${run}`, portalEnabled: true },
      { id: pArc, tenantId: f.tenantId, clientId: acme, key: `USB${up}`, name: `Old ${run}`, portalEnabled: true },
      {
        id: pRem,
        tenantId: f.tenantId,
        clientId: acme,
        key: `USC${up}`,
        name: `Weekly ${run}`,
        portalEnabled: true,
        status: "ACTIVE",
        updateCadence: "WEEKLY",
        updateWeekday: 5,
      },
    ],
  });
  // An employee reaches only what they are assigned to (a manager, the whole workspace).
  await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: pOn } });
}, 120_000);

afterAll(async () => {
  if (!f) return;
  const where = { where: { tenantId: f.tenantId } };
  await f.platform.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.work_maintenance', 'on', true)`;
    await tx.projectUpdate.deleteMany(where);
  });
  await f.platform.emailOutbox.deleteMany(where);
  await f.platform.notification.deleteMany(where);
  await f.platform.projectUpdateReminderSent.deleteMany(where);
  await f.platform.tenantCounter.deleteMany(where);
  await f.platform.memberProject.deleteMany(where);
  await f.platform.tenantPreference.deleteMany(where);
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.workItemActivity.deleteMany(where);
  await f.platform.workItem.deleteMany(where);
  await f.platform.workflowState.deleteMany(where);
  await f.platform.project.deleteMany(where);
  await f.platform.client.deleteMany(where);
  for (const e of extras) {
    if (e.memberId) {
      await f.platform.memberRole.deleteMany({ where: { tenantId: f.tenantId, memberId: e.memberId } });
      await f.platform.member.deleteMany({ where: { tenantId: f.tenantId, id: e.memberId } });
    }
    await f.platform.user.deleteMany({ where: { id: e.userId } });
  }
  await f.cleanup();
}, 120_000);

describe("scheduling a draft (C112)", () => {
  let id: string;

  it("a manager schedules it: the row, the list and the trail say when, to whom and by whom", async () => {
    id = await draftBy(ctxOf("manager"), pOn, `Week one ${run}`);
    const { scheduledFor } = await scheduleBy(ctxOf("manager"), id);
    expect(scheduledFor.toISOString()).toBe(hourOn(DAY, 9).toISOString());

    const row = await rowOf(id);
    expect(row.status).toBe("DRAFT");
    // A draft never holds an audience: the chosen one waits beside it.
    expect(row.visibility).toBe("INTERNAL");
    expect(row.scheduledVisibility).toBe("CLIENT_VISIBLE");
    expect(row.scheduledByMemberId).toBe(f.seats.manager.memberId);

    // Everyone who reads the list sees it, the employee included.
    const entry = (await listUpdates(ctxOf("employee"), pOn)).updates.find((u) => u.id === id)!;
    expect(entry.scheduled).toEqual({ at: scheduledFor, visibility: "CLIENT_VISIBLE", byName: managerName });

    const trail = await auditsOf(id);
    expect(trail.map((a) => a.action)).toEqual(["project_update.drafted", "project_update.scheduled"]);
    expect(trail[1]!.metadata).toMatchObject({ projectId: pOn, scheduledFor: scheduledFor.toISOString(), visibility: "CLIENT_VISIBLE" });
  });

  it("is the publish code's: an employee may draft but not schedule", async () => {
    const mine = await draftBy(ctxOf("employee"), pOn, `Employee's ${run}`);
    expect(await refused(scheduleBy(ctxOf("employee"), mine))).toBe(true);
    expect((await rowOf(mine)).scheduledFor).toBeNull();
  });

  it("refuses an hour already past, one more than 90 days ahead, and an empty draft", async () => {
    const other = await draftBy(ctxOf("manager"), pOn, `Bounds ${run}`);
    expect(await domainCode(scheduleBy(ctxOf("manager"), other, { date: todayIn(ZONE), hour: 0 }))).toBe("UPDATE_SCHEDULE_TIME");
    expect(await domainCode(scheduleBy(ctxOf("manager"), other, { date: addDays(todayIn(ZONE), 91) }))).toBe("UPDATE_SCHEDULE_TIME");
    expect(await domainCode(scheduleBy(ctxOf("manager"), other, { hour: 24 }))).toBe("INVALID_INPUT");
    const empty = await draftBy(ctxOf("manager"), pOn, "   ");
    expect(await domainCode(scheduleBy(ctxOf("manager"), empty))).toBe("UPDATE_EMPTY");
  });

  it("is LOCKED: edit, discard and Publish now are refused — and the database refuses an edit", async () => {
    expect(await domainCode(updateUpdateDraft(ctxOf("manager"), id, fields(`Changed ${run}`)))).toBe("UPDATE_SCHEDULED");
    expect(await domainCode(discardUpdateDraft(ctxOf("manager"), id))).toBe("UPDATE_SCHEDULED");
    expect(await domainCode(publishUpdate(ctxOf("manager"), id, { visibility: "INTERNAL" }))).toBe("UPDATE_SCHEDULED");
    // The belt: an edit that read the draft before it was scheduled. Through
    // the module's own mapper, which matches the RAISE's text — never a regex
    // over `e.message`, which outside production carries this file's source
    // lines (the re-check's L3).
    expect(
      await domainCode(
        withTenant(f.tenantId, { type: "member", id: f.seats.employee.memberId }, (tx) =>
          guarded(() => tx.projectUpdate.update({ where: { id }, data: { title: `Sneaky ${run}` }, select: { id: true } })),
        ),
      ),
    ).toBe("UPDATE_SCHEDULED");
    expect((await rowOf(id)).title).toBe(`Update ${run}`);
  });

  it("can be MOVED to another hour, which the trail records", async () => {
    const before = (await rowOf(id)).scheduledFor!;
    const { scheduledFor } = await scheduleBy(ctxOf("manager"), id, { hour: 10 });
    expect(scheduledFor.toISOString()).toBe(hourOn(DAY, 10).toISOString());
    const moved = (await auditsOf(id)).filter((a) => a.action === "project_update.scheduled").at(-1)!;
    expect(moved.metadata).toMatchObject({ movedFrom: before.toISOString() });
  });

  it("Unschedule makes it a plain draft again — editable, discardable", async () => {
    await unscheduleUpdate(ctxOf("manager"), id);
    const row = await rowOf(id);
    expect([row.scheduledFor, row.scheduledByMemberId, row.scheduledVisibility]).toEqual([null, null, null]);
    expect((await auditsOf(id)).at(-1)!.action).toBe("project_update.unscheduled");
    await updateUpdateDraft(ctxOf("employee"), id, fields(`Edited again ${run}`));
    // Already unscheduled is a quiet no-op.
    await unscheduleUpdate(ctxOf("manager"), id);
    expect((await auditsOf(id)).filter((a) => a.action === "project_update.unscheduled")).toHaveLength(1);
  });

  it("Schedule and Publish now bind to the version the composer's save returned", async () => {
    const other = await draftBy(ctxOf("manager"), pOn, `Versioned ${run}`);
    const saved = await updateUpdateDraft(ctxOf("manager"), other, fields(`Versioned, saved ${run}`));
    // Somebody else saves in between — only `create` needed for that.
    await updateUpdateDraft(ctxOf("employee"), other, fields(`Changed by the employee ${run}`));
    const stale = { expectedUpdatedAt: saved.updatedAt };
    expect(
      await domainCode(
        scheduleUpdate(ctxOf("manager"), other, { visibility: "CLIENT_VISIBLE", date: DAY, hour: 9, timeZone: ZONE, ...stale }),
      ),
    ).toBe("UPDATE_CHANGED");
    expect(await domainCode(publishUpdate(ctxOf("manager"), other, { visibility: "CLIENT_VISIBLE", ...stale }))).toBe(
      "UPDATE_CHANGED",
    );
    const row = await rowOf(other);
    expect([row.status, row.scheduledFor]).toEqual(["DRAFT", null]);
    // The version the latest write returned passes.
    const fresh = await updateUpdateDraft(ctxOf("manager"), other, fields(`Versioned, final ${run}`));
    await scheduleUpdate(ctxOf("manager"), other, {
      visibility: "CLIENT_VISIBLE",
      date: DAY,
      hour: 9,
      timeZone: ZONE,
      expectedUpdatedAt: fresh.updatedAt,
    });
    expect((await rowOf(other)).scheduledFor).not.toBeNull();
    await unscheduleUpdate(ctxOf("manager"), other);
  });

  it("refuses to schedule for the client a post that names private work — it could never go out", async () => {
    const secret = `Hidden at scheduling ${run}`;
    await createItem(ctxOf("manager"), { projectId: pOn, title: secret });
    const other = await draftBy(ctxOf("manager"), pOn, secret);
    expect(await domainCode(scheduleBy(ctxOf("manager"), other, { visibility: "CLIENT_VISIBLE" }))).toBe("UPDATE_NAMES_PRIVATE");
    // For the team it is fine.
    await scheduleBy(ctxOf("manager"), other, { visibility: "INTERNAL" });
    await unscheduleUpdate(ctxOf("manager"), other);
  });

  it("a published post can carry no schedule (the CHECK)", async () => {
    const out = await draftBy(ctxOf("manager"), pOn, `Out now ${run}`);
    await publishUpdate(ctxOf("manager"), out, { visibility: "INTERNAL" });
    await expect(
      f.platform.projectUpdate.update({
        where: { id: out },
        data: { scheduledFor: new Date(), scheduledByMemberId: f.seats.manager.memberId, scheduledVisibility: "INTERNAL" },
      }),
    ).rejects.toThrow();
  });
});

describe("the hourly job publishes what is due (C112 (b)–(d))", () => {
  it("publishes a due post AS its scheduler, to the audience chosen, clears the schedule, and audits as SYSTEM", async () => {
    const id = await draftBy(ctxOf("employee"), pOn, `Written by the employee ${run}`);
    const { scheduledFor } = await scheduleBy(ctxOf("manager"), id, { visibility: "CLIENT_VISIBLE" });

    // Not yet: a minute before the hour.
    const early = await publishScheduledUpdates(f.tenantId, minutes(scheduledFor, -1));
    expect(early.considered).toBe(0);
    expect((await rowOf(id)).status).toBe("DRAFT");

    const r = await publishScheduledUpdates(f.tenantId, minutes(scheduledFor, 10));
    expect(r).toMatchObject({ published: 1, refused: 0, failed: 0 });
    const row = await rowOf(id);
    expect(row.status).toBe("PUBLISHED");
    expect(row.visibility).toBe("CLIENT_VISIBLE");
    expect(row.seq).not.toBeNull();
    expect(row.publishedByMemberId).toBe(f.seats.manager.memberId);
    expect(row.authorMemberId).toBe(f.seats.employee.memberId);
    expect([row.scheduledFor, row.scheduledByMemberId, row.scheduledVisibility]).toEqual([null, null, null]);
    // The numbers were counted then; cost never (✦ needs a fresh factor no job has).
    expect(row.portalSnapshot).not.toBeNull();
    expect(row.internalSnapshot).not.toBeNull();
    expect(row.internalSnapshot!.cost).toBeNull();

    const published = (await auditsOf(id)).find((a) => a.action === "project_update.published")!;
    expect(published.actorType).toBe("SYSTEM");
    expect(published.actorId).toBeNull();
    expect(published.metadata).toMatchObject({ projectId: pOn, visibility: "CLIENT_VISIBLE", scheduled: true });

    // Idempotent: the next run finds nothing.
    expect((await publishScheduledUpdates(f.tenantId, minutes(scheduledFor, 70))).considered).toBe(0);
  });

  it("refuses a scheduler who may no longer publish: cleared, recorded, and they are told — once", async () => {
    const pub = await extraMember(f.roleId("manager"), "demoted");
    const id = await draftBy(ctxFor(pub), pOn, `Demoted's ${run}`);
    const { scheduledFor } = await scheduleBy(ctxFor(pub), id);
    // Demoted to employee before the hour: may draft, not publish.
    await f.platform.memberRole.deleteMany({ where: { tenantId: f.tenantId, memberId: pub } });
    await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: pub, roleId: f.roleId("employee") } });

    const r = await publishScheduledUpdates(f.tenantId, minutes(scheduledFor, 10));
    expect(r).toMatchObject({ published: 0, refused: 1 });
    const row = await rowOf(id);
    expect(row.status).toBe("DRAFT");
    expect(row.scheduledFor).toBeNull();
    const failed = (await auditsOf(id)).find((a) => a.action === "project_update.schedule_failed")!;
    expect(failed.actorType).toBe("SYSTEM");
    expect(failed.metadata).toMatchObject({ projectId: pOn, reason: "not_allowed", scheduledFor: scheduledFor.toISOString() });
    expect(await failedNotes(pub)).toEqual([
      { entityType: "Project", entityId: pOn, reason: "REQUESTER", params: { reason: "not_allowed" } },
    ]);
    // Nothing left to refuse on the next run.
    expect((await publishScheduledUpdates(f.tenantId, minutes(scheduledFor, 70))).considered).toBe(0);
  });

  it("a suspended scheduler is refused and told nothing", async () => {
    const gone = await extraMember(f.roleId("manager"), "suspended");
    const id = await draftBy(ctxFor(gone), pOn, `Suspended's ${run}`);
    const { scheduledFor } = await scheduleBy(ctxFor(gone), id);
    await f.platform.member.update({ where: { id: gone }, data: { status: "SUSPENDED" } });
    const r = await publishScheduledUpdates(f.tenantId, minutes(scheduledFor, 10));
    expect(r).toMatchObject({ published: 0, refused: 1 });
    expect((await rowOf(id)).status).toBe("DRAFT");
    expect(await failedNotes(gone)).toEqual([]);
  });

  it("refuses a post more than a day late — a run that did not happen must not send last week's post today", async () => {
    const id = await draftBy(ctxOf("manager"), pOn, `Late ${run}`);
    const { scheduledFor } = await scheduleBy(ctxOf("manager"), id);
    const r = await publishScheduledUpdates(f.tenantId, minutes(scheduledFor, 25 * 60));
    expect(r).toMatchObject({ published: 0, refused: 1 });
    expect((await rowOf(id)).status).toBe("DRAFT");
    expect((await auditsOf(id)).at(-1)!.metadata).toMatchObject({ reason: "late" });
    expect((await failedNotes(f.seats.manager.memberId)).some((n) => (n.params as Record<string, string>)["reason"] === "late")).toBe(
      true,
    );
  });

  it("refuses a post whose project was archived since", async () => {
    const id = await draftBy(ctxOf("manager"), pArc, `Archived ${run}`);
    const { scheduledFor } = await scheduleBy(ctxOf("manager"), id);
    await f.platform.project.update({ where: { id: pArc }, data: { archivedAt: new Date() } });
    const r = await publishScheduledUpdates(f.tenantId, minutes(scheduledFor, 10));
    expect(r).toMatchObject({ published: 0, refused: 1 });
    expect((await auditsOf(id)).at(-1)!.metadata).toMatchObject({ reason: "archived" });
  });

  it("Unschedule after the job published it says so — never \"Unscheduled\" over a post that went out", async () => {
    const id = await draftBy(ctxOf("manager"), pOn, `Gone already ${run}`);
    const { scheduledFor } = await scheduleBy(ctxOf("manager"), id, { visibility: "INTERNAL" });
    expect((await publishScheduledUpdates(f.tenantId, minutes(scheduledFor, 10))).published).toBe(1);
    expect(await domainCode(unscheduleUpdate(ctxOf("manager"), id))).toBe("UPDATE_NOT_DRAFT");
  });

  it("the OWNER's schedule freezes no cost either — a job never has a fresh factor", async () => {
    const id = await draftBy(ctxOf("owner"), pOn, `Owner's ${run}`);
    const { scheduledFor } = await scheduleBy(ctxOf("owner"), id, { visibility: "INTERNAL" });
    expect((await publishScheduledUpdates(f.tenantId, minutes(scheduledFor, 10))).published).toBe(1);
    const row = await rowOf(id);
    expect(row.publishedByMemberId).toBe(f.seats.owner.memberId);
    expect(row.internalSnapshot!.cost).toBeNull();
  });

  it("refuses a scheduler whose scope no longer reaches the project", async () => {
    // A role that may publish but holds no `client:view_all`: its scope is its assignments.
    const role = await f.platform.role.create({ data: { tenantId: f.tenantId, name: `Publisher ${run}` }, select: { id: true } });
    const codes = await f.platform.permission.findMany({
      where: { code: { in: ["project_update:view", "project_update:create", "project_update:publish", "project:view"] } },
      select: { id: true },
    });
    expect(codes).toHaveLength(4);
    await f.platform.rolePermission.createMany({
      data: codes.map((c) => ({ tenantId: f.tenantId, roleId: role.id, permissionId: c.id, source: "TENANT_GRANT" as const })),
    });
    const scoped = await extraMember(role.id, "scoped");
    await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: scoped, projectId: pOn } });
    const id = await draftBy(ctxFor(scoped), pOn, `Scoped ${run}`);
    const { scheduledFor } = await scheduleBy(ctxFor(scoped), id);
    await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId, memberId: scoped } });
    const r = await publishScheduledUpdates(f.tenantId, minutes(scheduledFor, 10));
    expect(r).toMatchObject({ published: 0, refused: 1 });
    expect((await auditsOf(id)).at(-1)!.metadata).toMatchObject({ reason: "not_allowed", scheduledBy: scoped });
  });

  it("refuses a post for the client that names work made private since — the dialog's warning, asked again", async () => {
    const secret = `Private task ${run}`;
    const id = await draftBy(ctxOf("manager"), pOn, secret);
    const { scheduledFor } = await scheduleBy(ctxOf("manager"), id, { visibility: "CLIENT_VISIBLE" });
    // A task by that title, private (every task starts private).
    await createItem(ctxOf("manager"), { projectId: pOn, title: secret });
    const r = await publishScheduledUpdates(f.tenantId, minutes(scheduledFor, 10));
    expect(r).toMatchObject({ published: 0, refused: 1 });
    expect((await rowOf(id)).status).toBe("DRAFT");
    expect((await auditsOf(id)).at(-1)!.metadata).toMatchObject({ reason: "private_named" });
  });

  it("a closed work module refuses nothing: its posts wait", async () => {
    const id = await draftBy(ctxOf("manager"), pOn, `Waits ${run}`);
    const { scheduledFor } = await scheduleBy(ctxOf("manager"), id, { visibility: "INTERNAL" });
    await f.platform.tenantPreference.create({ data: { tenantId: f.tenantId, key: "module.work.enabled", value: false } });
    try {
      expect((await publishScheduledUpdates(f.tenantId, minutes(scheduledFor, 10))).considered).toBe(0);
      expect((await rowOf(id)).scheduledFor).not.toBeNull();
    } finally {
      await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId, key: "module.work.enabled" } });
    }
    expect((await publishScheduledUpdates(f.tenantId, minutes(scheduledFor, 20))).published).toBe(1);
  });

  it("a post moved to a later hour is not published at its old one", async () => {
    const id = await draftBy(ctxOf("manager"), pOn, `Moved ${run}`);
    const first = (await scheduleBy(ctxOf("manager"), id, { hour: 8 })).scheduledFor;
    await scheduleBy(ctxOf("manager"), id, { hour: 11 });
    expect((await publishScheduledUpdates(f.tenantId, minutes(first, 10))).considered).toBe(0);
    expect((await rowOf(id)).status).toBe("DRAFT");
    await unscheduleUpdate(ctxOf("manager"), id);
  });
});

describe("the reminders go quiet for a post that will count (slice 135)", () => {
  const stand = (now: Date = new Date()) =>
    withTenant(f.tenantId, { type: "system" }, async (tx) => {
      const p = await tx.project.findFirstOrThrow({
        where: { id: pRem },
        select: {
          id: true,
          status: true,
          archivedAt: true,
          portalEnabled: true,
          updateCadence: true,
          updateWeekday: true,
          updateScheduleSince: true,
        },
      });
      return readUpdateSchedule(tx, f.tenantId, p, now);
    });

  it("with the portal on, only a post scheduled for the client quiets the badge", async () => {
    expect(await stand()).not.toBeNull();
    const id = await draftBy(ctxOf("manager"), pRem, `Weekly ${run}`);
    await scheduleBy(ctxOf("manager"), id, { visibility: "INTERNAL" });
    expect(await stand()).not.toBeNull();
    await scheduleBy(ctxOf("manager"), id, { visibility: "CLIENT_VISIBLE" });
    expect(await stand()).toBeNull();
    await unscheduleUpdate(ctxOf("manager"), id);
    expect(await stand()).not.toBeNull();
  });

  it("two rounds late, a post scheduled for later TODAY quiets this round (the re-check's M1)", async () => {
    // The first due day, as the badge reads it now; then stand on the day two
    // rounds after it, at noon, with nothing posted — late, and owed.
    const first = (await stand())!.dueOn;
    const roundDay = addDays(first, 14);
    const noon = hourOn(roundDay, 12);
    expect((await stand(noon))!.state).toBe("late");
    const id = await draftBy(ctxOf("manager"), pRem, `Two rounds late ${run}`);
    await scheduleBy(ctxOf("manager"), id, { visibility: "CLIENT_VISIBLE", date: roundDay, hour: 15 });
    expect(await stand(noon)).toBeNull();
    await unscheduleUpdate(ctxOf("manager"), id);
  });

  it("a post scheduled far beyond the round silences nothing (both reviews' medium)", async () => {
    const id = await draftBy(ctxOf("manager"), pRem, `Far ahead ${run}`);
    await scheduleBy(ctxOf("manager"), id, { visibility: "CLIENT_VISIBLE", date: addDays(todayIn(ZONE), 60) });
    expect(await stand()).not.toBeNull();
    await unscheduleUpdate(ctxOf("manager"), id);
  });
});
