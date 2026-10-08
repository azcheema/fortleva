import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "@/db";
import { drainOutbox } from "@/jobs/outbox";
import { DomainError } from "@/lib/domain-error";
import { setupTenant } from "@/members/dbtest-fixture";

import type { NotificationKind } from "./catalog";
import { emit } from "./emit";
import { readOwnPreferences, updateOwnPreferences } from "./preferences";
import { WORK_MAIL_SKIPPED } from "./work-mail";

/**
 * QUIET HOURS against the real database and app_runtime (Phase 5 slice 105;
 * founder decision C73 (e), (f), (h)): `notify.emit` times a work email for
 * the end of its receiver's quiet hours and marks it held; the outbox drain
 * holds again what it claims inside them, drops at release what was seen in
 * the inbox meanwhile, drops what is no longer wanted and a held update
 * reminder a post overtook; saving the setting re-times what waits; the CHECK
 * holds the pair; mail that is not work mail is never held.
 *
 * THE CLOCK. The employee's zone is UTC (`Member.timezone`), and every quiet
 * window is placed around the CURRENT UTC hour — "quiet now" is [h, h+2),
 * "not quiet now" is [h+2, h+4) — so each assertion holds at any hour this
 * runs, with at least an hour to spare.
 *
 * It drains ITS OWN tenant only (`drainOutbox(…, { tenantId })`): never another
 * tenant's mail on the shared database (slice 100's design review).
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let employee: string;
let manager: string;
let acme: string;
let projectId: string;

const hourNow = () => new Date().getUTCHours();
const quietNow = () => ({ from: hourNow(), to: (hourNow() + 2) % 24 });
const quietLater = () => ({ from: (hourNow() + 2) % 24, to: (hourNow() + 4) % 24 });
/** The next instant the UTC wall clock reads `hour`:00. */
const nextUtcHour = (hour: number) => {
  const now = new Date();
  const r = new Date(now);
  r.setUTCHours(hour, 0, 0, 0);
  if (r.getTime() <= now.getTime()) r.setUTCDate(r.getUTCDate() + 1);
  return r;
};

const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

/** A work notification to the employee, as the manager (or the system). */
async function notify(kind: NotificationKind, opts: { system?: boolean; entity?: { type: string; id: string }; project?: string } = {}) {
  const entity = opts.entity ?? { type: "WorkItem", id: randomUUID() };
  await withTenant(f.tenantId, opts.system ? { type: "system" } : { type: "member", id: manager }, (tx) =>
    emit(tx, f.tenantId, {
      kind,
      entity,
      ...(opts.system ? {} : { actorMemberId: manager }),
      ...(opts.project ? { projectId: opts.project, params: { projectKey: "QH", step: "0", late: "false" } } : {}),
      receivers: new Map([[employee, "ASSIGNEE"]]),
    }),
  );
  // The NEWEST for this entity (ids are UUIDv7): a test may notify twice about one project.
  const note = await f.platform.notification.findFirstOrThrow({
    where: { tenantId: f.tenantId, receiverId: employee, entityId: entity.id },
    select: { id: true },
    orderBy: { id: "desc" },
  });
  const mail = await f.platform.emailOutbox.findUniqueOrThrow({ where: { idempotencyKey: `${kind}:${note.id}` } });
  return { noteId: note.id, mail };
}

const mailOf = (id: string) => f.platform.emailOutbox.findUniqueOrThrow({ where: { id } });
const drain = () => drainOutbox(50, { tenantId: f.tenantId });

beforeAll(async () => {
  f = await setupTenant("quiet");
  employee = f.seats.employee.memberId;
  manager = f.seats.manager.memberId;
  await f.platform.member.update({ where: { id: employee }, data: { timezone: "UTC" } });
  acme = randomUUID();
  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: "Acme" } });
  projectId = randomUUID();
  await f.platform.project.create({ data: { id: projectId, tenantId: f.tenantId, clientId: acme, key: "QH", name: "Quiet", status: "ACTIVE" } });
}, 120_000);

afterEach(async () => {
  if (!f) return;
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notificationPreference.deleteMany({ where: { tenantId: f.tenantId } });
});

afterAll(async () => {
  if (!f) return;
  const where = { where: { tenantId: f.tenantId } };
  await f.platform.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.work_maintenance', 'on', true)`;
    await tx.projectUpdate.deleteMany(where);
  });
  await f.platform.emailOutbox.deleteMany(where);
  await f.platform.notification.deleteMany(where);
  await f.platform.notificationPreference.deleteMany(where);
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.project.deleteMany(where);
  await f.platform.client.deleteMany(where);
  await f.cleanup();
}, 120_000);

describe("the setting", () => {
  it("switching on with no hours takes 19:00–07:00; off saves none; the weekend stands alone", async () => {
    expect(await updateOwnPreferences(employeeCtx(), { quietHours: {} })).toMatchObject({ quietHoursFrom: 19, quietHoursTo: 7 });
    expect(await updateOwnPreferences(employeeCtx(), { quietHours: null, quietWeekends: true })).toMatchObject({
      quietHoursFrom: null,
      quietHoursTo: null,
      quietWeekends: true,
    });
    expect(await readOwnPreferences(employeeCtx())).toMatchObject({ quietHoursFrom: null, quietHoursTo: null, quietWeekends: true });
  });

  it("the same hour twice is refused by the service and by the CHECK, and so is half a pair", async () => {
    await expect(updateOwnPreferences(employeeCtx(), { quietHours: { from: 5, to: 5 } })).rejects.toSatisfy(
      (e) => e instanceof DomainError && e.code === "QUIET_HOURS_SAME",
    );
    await updateOwnPreferences(employeeCtx(), { quietHours: { from: 22, to: 6 } });
    await expect(
      f.platform.$executeRaw`UPDATE notification_preference SET quiet_hours_to = 22 WHERE tenant_id = ${f.tenantId} AND receiver_id = ${employee}`,
    ).rejects.toThrow(/notification_preference_quiet_hours/);
    await expect(
      f.platform.$executeRaw`UPDATE notification_preference SET quiet_hours_to = NULL WHERE tenant_id = ${f.tenantId} AND receiver_id = ${employee}`,
    ).rejects.toThrow(/notification_preference_quiet_hours/);
  });
});

describe("at enqueue (notify.emit)", () => {
  it("inside quiet hours: timed for their end and marked held", async () => {
    const q = quietNow();
    await updateOwnPreferences(employeeCtx(), { quietHours: q });
    const { mail } = await notify("comment.mentioned");
    expect(mail.quietHeld).toBe(true);
    expect(mail.sendAfter.toISOString()).toBe(nextUtcHour(q.to).toISOString());
    // An assignment's two-minute wait still lands inside the window, so it waits too.
    const assigned = await notify("work_item.assigned");
    expect(assigned.mail.quietHeld).toBe(true);
    expect(assigned.mail.sendAfter.toISOString()).toBe(nextUtcHour(q.to).toISOString());
  });

  it("outside them: unchanged — now, or after the assignment's two minutes", async () => {
    await updateOwnPreferences(employeeCtx(), { quietHours: quietLater() });
    const before = Date.now();
    const { mail } = await notify("comment.mentioned");
    expect(mail.quietHeld).toBe(false);
    expect(Math.abs(mail.sendAfter.getTime() - before)).toBeLessThan(60_000);
  });
});

describe("saving the setting re-times what waits", () => {
  it("a later end moves it; switching quiet hours off releases it at once", async () => {
    const q = quietNow();
    await updateOwnPreferences(employeeCtx(), { quietHours: q });
    const { mail } = await notify("comment.mentioned");
    const later = (q.to + 1) % 24;
    await updateOwnPreferences(employeeCtx(), { quietHours: { from: q.from, to: later } });
    expect((await mailOf(mail.id)).sendAfter.toISOString()).toBe(nextUtcHour(later).toISOString());
    await updateOwnPreferences(employeeCtx(), { quietHours: null });
    const released = await mailOf(mail.id);
    expect(released.sendAfter.getTime()).toBeLessThanOrEqual(Date.now());
    expect(released.quietHeld).toBe(true);
  });
});

describe("at send (the outbox drain)", () => {
  it("C73 (e), (h): a held mail whose notification was read in the inbox is not sent; an unread one is", async () => {
    await updateOwnPreferences(employeeCtx(), { quietHours: quietNow() });
    const read = await notify("comment.mentioned");
    const unread = await notify("comment.mentioned");
    await f.platform.notification.update({ where: { id: read.noteId }, data: { readAt: new Date() } });
    await updateOwnPreferences(employeeCtx(), { quietHours: null }); // the quiet ends: both are due now
    const out = await drain();
    expect(out).toMatchObject({ sent: 1, skipped: 1, held: 0 });
    expect(await mailOf(read.mail.id)).toMatchObject({ status: "SKIPPED", lastError: WORK_MAIL_SKIPPED.seen });
    expect(await mailOf(unread.mail.id)).toMatchObject({ status: "SENT" });
  });

  it("a snoozed notification counts as seen", async () => {
    await updateOwnPreferences(employeeCtx(), { quietHours: quietNow() });
    const snoozed = await notify("comment.mentioned");
    await f.platform.notification.update({ where: { id: snoozed.noteId }, data: { snoozedTill: new Date(Date.now() + 3_600_000) } });
    await updateOwnPreferences(employeeCtx(), { quietHours: null });
    await drain();
    expect(await mailOf(snoozed.mail.id)).toMatchObject({ status: "SKIPPED", lastError: WORK_MAIL_SKIPPED.seen });
  });

  it("a mail claimed inside quiet hours goes back to wait for their end", async () => {
    const { mail } = await notify("comment.mentioned"); // no quiet hours yet: due now, not held
    expect(mail.quietHeld).toBe(false);
    const q = quietNow();
    await updateOwnPreferences(employeeCtx(), { quietHours: q });
    const out = await drain();
    expect(out).toMatchObject({ sent: 0, held: 1 });
    expect(await mailOf(mail.id)).toMatchObject({ status: "QUEUED", quietHeld: true, lockedAt: null, sendAfter: nextUtcHour(q.to) });
  });

  it("the email level at SEND decides: turned to Nothing since, the mail is dropped", async () => {
    const { mail } = await notify("comment.mentioned");
    await updateOwnPreferences(employeeCtx(), { emailLevel: "NONE" });
    await drain();
    expect(await mailOf(mail.id)).toMatchObject({ status: "SKIPPED", lastError: WORK_MAIL_SKIPPED.unwanted });
  });

  it("a suspended member's mail is dropped", async () => {
    const { mail } = await notify("comment.mentioned");
    await f.platform.member.update({ where: { id: employee }, data: { status: "SUSPENDED" } });
    try {
      await drain();
    } finally {
      await f.platform.member.update({ where: { id: employee }, data: { status: "ACTIVE" } });
    }
    expect(await mailOf(mail.id)).toMatchObject({ status: "SKIPPED", lastError: WORK_MAIL_SKIPPED.unwanted });
  });

  it("a mail held over a change of address goes nowhere (the security review's nit)", async () => {
    const { mail } = await notify("comment.mentioned");
    const user = await f.platform.user.findUniqueOrThrow({ where: { id: f.seats.employee.userId }, select: { email: true } });
    await f.platform.user.update({ where: { id: f.seats.employee.userId }, data: { email: `moved-${user.email}` } });
    try {
      await drain();
    } finally {
      await f.platform.user.update({ where: { id: f.seats.employee.userId }, data: { email: user.email } });
    }
    expect(await mailOf(mail.id)).toMatchObject({ status: "SKIPPED", lastError: WORK_MAIL_SKIPPED.unwanted });
  });

  it("a held 'update due' reminder a NEWER one overtook is not sent; the newer one is (the code review's L4)", async () => {
    await updateOwnPreferences(employeeCtx(), { quietHours: quietNow() });
    const project = { system: true, entity: { type: "Project", id: projectId }, project: projectId };
    const older = await notify("project_update.due", project);
    const newer = await notify("project_update.due", project);
    expect([older.mail.quietHeld, newer.mail.quietHeld]).toEqual([true, true]);
    await updateOwnPreferences(employeeCtx(), { quietHours: null });
    await drain();
    expect(await mailOf(older.mail.id)).toMatchObject({ status: "SKIPPED", lastError: WORK_MAIL_SKIPPED.overtaken });
    expect(await mailOf(newer.mail.id)).toMatchObject({ status: "SENT" });
  });

  it("mail that is not work mail is never held — the weekly reminder goes inside quiet hours", async () => {
    await updateOwnPreferences(employeeCtx(), { quietHours: quietNow(), quietWeekends: true });
    const row = await f.platform.emailOutbox.create({
      data: {
        tenantId: f.tenantId,
        idempotencyKey: `quiet-test:${randomUUID()}`,
        receiverType: "MEMBER",
        receiverId: employee,
        toEmail: "employee-quiet@test.invalid",
        kind: "time.weekly_reminder",
        locale: "en",
        sendAfter: new Date(Date.now() - 60_000),
      },
    });
    const out = await drain();
    expect(out).toMatchObject({ held: 0 });
    expect(await mailOf(row.id)).toMatchObject({ status: "SENT", quietHeld: false });
  });

  it("a held 'update due' reminder a post overtook is not sent (the design review's M4)", async () => {
    await updateOwnPreferences(employeeCtx(), { quietHours: quietNow() });
    const { mail } = await notify("project_update.due", {
      system: true,
      entity: { type: "Project", id: projectId },
      project: projectId,
    });
    expect(mail.quietHeld).toBe(true);
    // The update goes in while the reminder waits.
    await f.platform.projectUpdate.create({
      data: {
        tenantId: f.tenantId,
        clientId: acme,
        projectId,
        seq: 1,
        health: "ON_TRACK",
        body: { sections: [], metrics: {} },
        bodyText: "planted",
        portalSnapshot: {},
        status: "PUBLISHED",
        visibility: "INTERNAL",
        authorMemberId: manager,
        publishedAt: new Date(mail.createdAt.getTime() + 1_000),
        publishedByMemberId: manager,
      },
    });
    await updateOwnPreferences(employeeCtx(), { quietHours: null });
    await drain();
    expect(await mailOf(mail.id)).toMatchObject({ status: "SKIPPED", lastError: WORK_MAIL_SKIPPED.overtaken });
  });
});
