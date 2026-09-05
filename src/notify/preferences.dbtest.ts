import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { enqueueForTenant } from "@/jobs/weekly-reminders";
import { setupTenant } from "@/members/dbtest-fixture";
import { assignItem, createItem } from "@/modules/work";

import { readOwnPreferences, updateOwnPreferences } from "./preferences";
import { WEEKLY_REMINDER_KIND } from "./weekly-reminder";

/**
 * Notification preferences, the email level `notify.emit` now honours,
 * and the 2T weekly self-reminder's enqueue — against the real database
 * and the real `app_runtime` role.
 *
 * The claims worth proving here are the ones about mail that either
 * arrives when someone asked for silence, or does not arrive when they
 * asked for it:
 *   • a preference row belongs to ONE member and a write never reaches
 *     another's, even though `NotificationPreference` is class A and the
 *     database would allow it — the application shape is the only gate;
 *   • the level ladder decides per KIND, so MENTIONS really does drop
 *     an assignment email while keeping a mention;
 *   • the reminder is opt-in, once per ISO week, and `NONE` outranks it.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let projectId: string;

beforeAll(async () => {
  f = await setupTenant("prefs-notify");
  clientId = randomUUID();
  projectId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Notify Co" } });
  await f.platform.project.create({
    data: { id: projectId, tenantId: f.tenantId, clientId, key: "NTFY", name: "Notify project" },
  });
}, 60_000);

afterAll(async () => {
  const db = f.platform;
  await db.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await db.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await db.notificationPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId, parentId: { not: null } } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 60_000);

beforeEach(async () => {
  await f.platform.notificationPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
});

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

const outboxKinds = async () =>
  (
    await f.platform.emailOutbox.findMany({
      where: { tenantId: f.tenantId },
      select: { kind: true, receiverId: true },
    })
  ).map((r) => `${r.kind}:${r.receiverId}`);

/** Assign a fresh task to the employee — the one INSTANT email 2W sends
 * that is not a mention. Returns nothing; the outbox is the assertion. */
const assignToEmployee = async (title: string) => {
  const item = await createItem(ownerCtx(), { projectId, title });
  await assignItem(ownerCtx(), item.id, f.seats.employee.memberId);
};

describe("notification preferences", () => {
  it("a member with no row reads the defaults — and reading writes nothing", async () => {
    expect(await readOwnPreferences(ownerCtx())).toEqual({
      emailLevel: "PARTICIPATING",
      weeklyTimeReminder: false,
    });
    expect(await f.platform.notificationPreference.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });

  it("an update creates the row, settles both fields and audits the RESULT", async () => {
    const before = (await f.audits("notification.preference_changed")).length;
    const saved = await updateOwnPreferences(ownerCtx(), { emailLevel: "MENTIONS" });
    expect(saved).toEqual({ emailLevel: "MENTIONS", weeklyTimeReminder: false });
    expect(await readOwnPreferences(ownerCtx())).toEqual(saved);

    const events = await f.audits("notification.preference_changed");
    expect(events.length).toBe(before + 1);
    // The settled values, not the patch: the page saves one field at a
    // time, so an event carrying only what changed would not say what
    // the member's notifications actually became.
    expect(events.at(-1)?.metadata).toMatchObject({
      emailLevel: "MENTIONS",
      weeklyTimeReminder: false,
    });
    expect(events.at(-1)?.targetId).toBe(f.seats.owner.memberId);
  });

  it("a second update keeps the field it did not touch", async () => {
    await updateOwnPreferences(ownerCtx(), { emailLevel: "NONE" });
    await updateOwnPreferences(ownerCtx(), { weeklyTimeReminder: true });
    expect(await readOwnPreferences(ownerCtx())).toEqual({
      emailLevel: "NONE",
      weeklyTimeReminder: true,
    });
  });

  it("the perKind merge keeps settings this build has never heard of", async () => {
    await updateOwnPreferences(ownerCtx(), { weeklyTimeReminder: true });
    const row = await f.platform.notificationPreference.findFirstOrThrow({
      where: { tenantId: f.tenantId, receiverId: f.seats.owner.memberId },
    });
    await f.platform.notificationPreference.update({
      where: { id: row.id },
      data: { perKind: { ...(row.perKind as object), "some.future_kind": { email: true } } },
    });

    await updateOwnPreferences(ownerCtx(), { weeklyTimeReminder: false });
    const after = await f.platform.notificationPreference.findFirstOrThrow({ where: { id: row.id } });
    expect(after.perKind).toEqual({
      [WEEKLY_REMINDER_KIND]: { email: false },
      "some.future_kind": { email: true },
    });
  });

  it("ONE MEMBER'S WRITE NEVER REACHES ANOTHER'S ROW — the shape is the gate, not the database", async () => {
    // `NotificationPreference` is class A: `tenant_isolation` and
    // `portal_deny` only, no per-principal binding, so RLS would let
    // either member write either row. Nothing here takes a receiver id,
    // which is why it cannot happen.
    await updateOwnPreferences(ownerCtx(), { emailLevel: "NONE" });
    await updateOwnPreferences(employeeCtx(), { emailLevel: "ALL" });

    expect((await readOwnPreferences(ownerCtx())).emailLevel).toBe("NONE");
    expect((await readOwnPreferences(employeeCtx())).emailLevel).toBe("ALL");
    expect(await f.platform.notificationPreference.count({ where: { tenantId: f.tenantId } })).toBe(2);
  });
});

describe("emit honours the email level, per kind", () => {
  it("no preference row = the schema default, and an assignment mails", async () => {
    await assignToEmployee("Default level");
    expect(await outboxKinds()).toEqual([`work_item.assigned:${f.seats.employee.memberId}`]);
  });

  it("NONE sends no mail — and the IN-APP row still lands", async () => {
    await updateOwnPreferences(employeeCtx(), { emailLevel: "NONE" });
    await assignToEmployee("Silent");
    expect(await outboxKinds()).toEqual([]);
    // The notification itself is never gated: an assignment you cannot
    // see is work you never find out about.
    expect(
      await f.platform.notification.count({
        where: { tenantId: f.tenantId, receiverId: f.seats.employee.memberId },
      }),
    ).toBe(1);
  });

  it("MENTIONS drops an ASSIGNMENT email — the ladder decides per kind, not per member", async () => {
    await updateOwnPreferences(employeeCtx(), { emailLevel: "MENTIONS" });
    await assignToEmployee("Too quiet");
    expect(await outboxKinds()).toEqual([]);
  });

  it("PARTICIPATING and ALL both mail an assignment", async () => {
    for (const level of ["PARTICIPATING", "ALL"] as const) {
      await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
      await updateOwnPreferences(employeeCtx(), { emailLevel: level });
      await assignToEmployee(`Loud ${level}`);
      expect(await outboxKinds(), level).toEqual([`work_item.assigned:${f.seats.employee.memberId}`]);
    }
  });
});

describe("the weekly self-reminder enqueue (2T D6)", () => {
  // A Wednesday, well past Monday 08:00 in any zone this fixture uses.
  const WEDNESDAY = new Date("2026-10-07T12:00:00Z");
  const members = () => [f.seats.owner.memberId, f.seats.employee.memberId];

  it("enqueues nothing for a member who never ticked the box", async () => {
    expect(await enqueueForTenant(f.tenantId, members(), WEDNESDAY)).toBe(0);
    expect(await outboxKinds()).toEqual([]);
  });

  it("ONCE PER ISO WEEK: a second run in the same week enqueues nothing more", async () => {
    await updateOwnPreferences(ownerCtx(), { weeklyTimeReminder: true });
    expect(await enqueueForTenant(f.tenantId, members(), WEDNESDAY)).toBe(1);
    // The idempotency key IS the guard — no table, no "last sent" column.
    expect(await enqueueForTenant(f.tenantId, members(), WEDNESDAY)).toBe(0);
    expect(await enqueueForTenant(f.tenantId, members(), new Date("2026-10-09T09:00:00Z"))).toBe(0);

    const rows = await f.platform.emailOutbox.findMany({ where: { tenantId: f.tenantId } });
    expect(rows.length).toBe(1);
    expect(rows[0]?.kind).toBe(WEEKLY_REMINDER_KIND);
    expect(rows[0]?.receiverId).toBe(f.seats.owner.memberId);
    // Self-addressed and data-free: no params, no notification behind it.
    expect(rows[0]?.params).toBeNull();
    expect(rows[0]?.notificationIds).toEqual([]);
    expect(rows[0]?.idempotencyKey).toBe(
      `weekly-reminder:${f.seats.owner.memberId}:2026-W41`,
    );
  });

  it("the NEXT week is a new key, so the reminder is weekly rather than once", async () => {
    await updateOwnPreferences(ownerCtx(), { weeklyTimeReminder: true });
    expect(await enqueueForTenant(f.tenantId, members(), WEDNESDAY)).toBe(1);
    expect(await enqueueForTenant(f.tenantId, members(), new Date("2026-10-14T12:00:00Z"))).toBe(1);
    expect((await f.platform.emailOutbox.findMany({ where: { tenantId: f.tenantId } })).length).toBe(2);
  });

  it("nothing is enqueued before the member's own Monday morning has passed", async () => {
    await updateOwnPreferences(ownerCtx(), { weeklyTimeReminder: true });
    // Monday 04:00 UTC = 06:00 in Stockholm, two hours before the slot.
    expect(await enqueueForTenant(f.tenantId, members(), new Date("2026-10-05T04:00:00Z"))).toBe(0);
    expect(await outboxKinds()).toEqual([]);
  });

  it("a suppressed address is never queued at all", async () => {
    await updateOwnPreferences(ownerCtx(), { weeklyTimeReminder: true });
    const owner = await f.platform.member.findFirstOrThrow({
      where: { tenantId: f.tenantId, id: f.seats.owner.memberId },
      select: { user: { select: { email: true } } },
    });
    const email = owner.user.email.toLowerCase();
    await f.platform.emailSuppression.create({ data: { email, reason: "HARD_BOUNCE" } });
    try {
      expect(await enqueueForTenant(f.tenantId, members(), WEDNESDAY)).toBe(0);
      expect(await outboxKinds()).toEqual([]);
    } finally {
      await f.platform.emailSuppression.deleteMany({ where: { email } });
    }
  });
});
