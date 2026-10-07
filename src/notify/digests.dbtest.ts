import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { enqueueMemberDigests } from "@/jobs/digests";
import { drainOutbox } from "@/jobs/outbox";
import { newId } from "@/lib/ids";
import { setTransport, type MailMessage, type MailTransport } from "@/mailer";
import { setupTenant } from "@/members/dbtest-fixture";

import { MEMBER_DIGEST_MAIL } from "./digest";

/**
 * THE TEAM'S SUMMARY EMAIL against the real database (Phase 5 slice 100;
 * founder decision C68 (b), (e), (h)) — the job's enqueue and the outbox's
 * send, both held to THIS tenant (`enqueueMemberDigests(tenantId, …)`,
 * `drainOutbox(…, { tenantId })`): neither may claim, count or "send" another
 * tenant's mail on the shared database (the design review's medium).
 *
 * The workspace's zone is the default, Europe/Stockholm (CEST, UTC+2 in
 * September), and no member has one of their own, so a default member's
 * summary is due at 06:00 UTC and may go until 09:00 UTC.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let restoreTransport: MailTransport | null = null;
const sent: (MailMessage & { from: string })[] = [];

/** 08:30 in Stockholm on Wednesday 16 September 2026. */
const NOW = new Date("2026-09-16T06:30:00.000Z");
/** Yesterday's summary time — where a first summary starts counting. */
const YESTERDAY_DUE = new Date("2026-09-15T06:00:00.000Z");
/** Where a summary made at NOW stops counting, and the next one starts. */
const SETTLED = new Date(NOW.getTime() - 60_000);

beforeAll(async () => {
  f = await setupTenant("digest");
  restoreTransport = setTransport(async (msg) => {
    sent.push(msg);
  });
}, 60_000);

afterAll(async () => {
  if (restoreTransport) setTransport(restoreTransport);
  const db = f.platform;
  await db.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await db.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await db.notificationPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 60_000);

beforeEach(async () => {
  sent.length = 0;
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notificationPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.member.updateMany({ where: { tenantId: f.tenantId }, data: { status: "ACTIVE" } });
  await f.platform.tenant.update({ where: { id: f.tenantId }, data: { status: "ACTIVE" } });
});

type Row = {
  memberId: string;
  kind?: string;
  createdAt: Date;
  readAt?: Date;
  archivedAt?: Date;
  snoozedTill?: Date;
};

/** A notification as `notify.emit` would have written it, at a chosen time. */
async function notify(row: Row): Promise<string> {
  const id = newId();
  await f.platform.notification.create({
    data: {
      id,
      tenantId: f.tenantId,
      receiverType: "MEMBER",
      receiverId: row.memberId,
      kind: row.kind ?? "work_item.commented",
      class: "COALESCED",
      entityType: "WorkItem",
      entityId: newId(),
      createdAt: row.createdAt,
      readAt: row.readAt ?? null,
      archivedAt: row.archivedAt ?? null,
      snoozedTill: row.snoozedTill ?? null,
    },
  });
  return id;
}

const summaries = () =>
  f.platform.emailOutbox.findMany({
    where: { tenantId: f.tenantId, kind: MEMBER_DIGEST_MAIL },
    orderBy: { createdAt: "asc" },
  });

const at = (iso: string) => new Date(iso);

describe("the summary's enqueue", () => {
  it("counts what is new and unread since the previous period — nothing read, archived, snoozed, older, newer or anyone else's", async () => {
    const emp = f.seats.employee.memberId;
    const counted = [
      await notify({ memberId: emp, createdAt: at("2026-09-15T12:00:00Z") }),
      // Already mailed at once (an assignment) — counted too: an overview (C68 (h)).
      await notify({ memberId: emp, kind: "work_item.assigned", createdAt: at("2026-09-15T13:00:00Z") }),
      // A snooze that has run out is unread news again.
      await notify({ memberId: emp, createdAt: at("2026-09-15T14:00:00Z"), snoozedTill: at("2026-09-16T05:00:00Z") }),
    ];
    await notify({ memberId: emp, createdAt: at("2026-09-15T15:00:00Z"), readAt: at("2026-09-15T16:00:00Z") });
    await notify({ memberId: emp, createdAt: at("2026-09-15T15:00:00Z"), archivedAt: at("2026-09-15T16:00:00Z") });
    await notify({ memberId: emp, createdAt: at("2026-09-15T15:00:00Z"), snoozedTill: at("2026-09-17T06:00:00Z") });
    await notify({ memberId: emp, createdAt: at("2026-09-14T20:00:00Z") }); // before the previous period
    await notify({ memberId: emp, createdAt: at("2026-09-16T06:45:00Z") }); // after the moment it is made
    // Inside the last minute before it is made — the NEXT summary's (`DIGEST_SETTLE_MS`).
    await notify({ memberId: emp, createdAt: new Date(NOW.getTime() - 30_000) });
    await notify({ memberId: emp, kind: "some.future_kind", createdAt: at("2026-09-15T15:00:00Z") });

    expect(await enqueueMemberDigests(f.tenantId, NOW)).toBe(1);
    const [row] = await summaries();
    expect(row).toBeDefined();
    expect(row!.receiverId).toBe(emp);
    expect(row!.idempotencyKey).toBe(`digest:member:${emp}:2026-09-16`);
    expect([...row!.notificationIds].sort()).toEqual([...counted].sort());
    // Only the summary's time, for the outbox's "too late" — no counts, no names.
    expect(row!.params).toEqual({ dueAt: "2026-09-16T06:00:00.000Z" });
    // Made "a minute ago": counted up to there, and the next one starts there.
    expect(row!.sendAfter.toISOString()).toBe(SETTLED.toISOString());
    expect(row!.createdAt.toISOString()).toBe(SETTLED.toISOString());
    expect(row!.toEmail).toMatch(/^employee-digest-.*@test\.invalid$/);
  });

  it("goes only in the hours after its time: not before, not in the afternoon", async () => {
    await notify({ memberId: f.seats.employee.memberId, createdAt: at("2026-09-15T12:00:00Z") });
    expect(await enqueueMemberDigests(f.tenantId, at("2026-09-16T05:59:00Z"))).toBe(0);
    // 11:00 in Stockholm: the three catch-up hours are over.
    expect(await enqueueMemberDigests(f.tenantId, at("2026-09-16T09:00:00Z"))).toBe(0);
    expect(await enqueueMemberDigests(f.tenantId, at("2026-09-16T13:00:00Z"))).toBe(0);
    expect(await summaries()).toHaveLength(0);
    expect(await enqueueMemberDigests(f.tenantId, at("2026-09-16T08:59:00Z"))).toBe(1);
  });

  it("is once a period, and the next one counts from the last — no row twice", async () => {
    const emp = f.seats.employee.memberId;
    const first = await notify({ memberId: emp, createdAt: at("2026-09-15T12:00:00Z") });
    // Stamped in the last minute before today's was made: tomorrow's.
    const settling = await notify({ memberId: emp, createdAt: new Date(NOW.getTime() - 30_000) });
    expect(await enqueueMemberDigests(f.tenantId, NOW)).toBe(1);
    expect(await enqueueMemberDigests(f.tenantId, at("2026-09-16T07:30:00Z"))).toBe(0);

    // Still unread tomorrow, but it was in today's summary.
    const later = await notify({ memberId: emp, createdAt: at("2026-09-16T12:00:00Z") });
    expect(await enqueueMemberDigests(f.tenantId, at("2026-09-17T06:30:00Z"))).toBe(1);
    const rows = await summaries();
    expect(rows.map((r) => [...r.notificationIds].sort())).toEqual([[first], [settling, later].sort()]);
    expect(rows[1]!.idempotencyKey).toBe(`digest:member:${emp}:2026-09-17`);
  });

  it("a job seconds after the hour still chains: the minute before the hour is the next summary's, not nobody's", async () => {
    const emp = f.seats.employee.memberId;
    const a = await notify({ memberId: emp, createdAt: at("2026-09-15T12:00:00Z") });
    // 07:59:40 in Stockholm — after the first summary's settled edge (07:59:10).
    const b = await notify({ memberId: emp, createdAt: at("2026-09-16T05:59:40Z") });
    expect(await enqueueMemberDigests(f.tenantId, at("2026-09-16T06:00:10Z"))).toBe(1);
    expect(await enqueueMemberDigests(f.tenantId, at("2026-09-17T06:00:10Z"))).toBe(1);
    const rows = await summaries();
    expect(rows.map((r) => r.notificationIds)).toEqual([[a], [b]]);
  });

  it("an hour moved later keeps the chain: nothing between the old hour and the new is lost", async () => {
    const emp = f.seats.employee.memberId;
    await notify({ memberId: emp, createdAt: at("2026-09-15T12:00:00Z") });
    expect(await enqueueMemberDigests(f.tenantId, NOW)).toBe(1); // 08:30 Stockholm, the 08:00 summary
    // Midday news, then the member moves their summary to 20:00.
    const midday = await notify({ memberId: emp, createdAt: at("2026-09-16T10:00:00Z") });
    await f.platform.notificationPreference.create({
      data: { tenantId: f.tenantId, receiverType: "MEMBER", receiverId: emp, digestHour: 20 },
    });
    // 20:30 Stockholm the next day.
    expect(await enqueueMemberDigests(f.tenantId, at("2026-09-17T18:30:00Z"))).toBe(1);
    const rows = await summaries();
    expect(rows[1]!.notificationIds).toEqual([midday]);
  });

  it("a summary the outbox DROPPED unsent is not a link in the chain: the next counts from the one before it", async () => {
    const emp = f.seats.employee.memberId;
    const before = await notify({ memberId: emp, createdAt: at("2026-09-14T12:00:00Z") });
    expect(await enqueueMemberDigests(f.tenantId, at("2026-09-15T06:30:00Z"))).toBe(1); // sent
    const dropped = await notify({ memberId: emp, createdAt: at("2026-09-15T12:00:00Z") });
    expect(await enqueueMemberDigests(f.tenantId, NOW)).toBe(1);
    // The outbox dropped today's as too late (what `drainOutbox` writes).
    const rows = await summaries();
    await f.platform.emailOutbox.update({ where: { id: rows[0]!.id }, data: { status: "SENT" } });
    await f.platform.emailOutbox.update({
      where: { id: rows[1]!.id },
      data: { status: "SKIPPED", lastError: "digest:late" },
    });
    expect(await enqueueMemberDigests(f.tenantId, at("2026-09-17T06:30:00Z"))).toBe(1);
    const third = (await summaries())[2]!;
    // Today's news reaches tomorrow's summary; the day before's, already sent, does not.
    expect(third.notificationIds).toEqual([dropped]);
    expect(third.notificationIds).not.toContain(before);
  });

  it("sends nothing when there is nothing new", async () => {
    await notify({ memberId: f.seats.employee.memberId, createdAt: at("2026-09-15T12:00:00Z"), readAt: NOW });
    expect(await enqueueMemberDigests(f.tenantId, NOW)).toBe(0);
  });

  it("sends nothing to a member who chose Never, or no email at all, or is suspended — or whose address bounced", async () => {
    const { owner, admin, manager, employee } = f.seats;
    for (const s of [owner, admin, manager, employee]) {
      await notify({ memberId: s.memberId, createdAt: at("2026-09-15T12:00:00Z") });
    }
    await f.platform.notificationPreference.createMany({
      data: [
        { tenantId: f.tenantId, receiverType: "MEMBER", receiverId: owner.memberId, digestCadence: "NONE" },
        { tenantId: f.tenantId, receiverType: "MEMBER", receiverId: admin.memberId, emailLevel: "NONE" },
      ],
    });
    await f.platform.member.update({ where: { id: manager.memberId }, data: { status: "SUSPENDED" } });
    const employeeEmail = (await f.platform.user.findUniqueOrThrow({ where: { id: employee.userId } })).email;
    await f.platform.emailSuppression.create({ data: { email: employeeEmail, reason: "HARD_BOUNCE", source: "dbtest" } });
    try {
      expect(await enqueueMemberDigests(f.tenantId, NOW)).toBe(0);
    } finally {
      await f.platform.emailSuppression.delete({ where: { email: employeeEmail } });
    }
  });

  it("a member on 'mentions only' still gets the summary — the level decides what is mailed at once, not the overview", async () => {
    const emp = f.seats.employee.memberId;
    await f.platform.notificationPreference.create({
      data: { tenantId: f.tenantId, receiverType: "MEMBER", receiverId: emp, emailLevel: "MENTIONS" },
    });
    await notify({ memberId: emp, kind: "work_item.assigned", createdAt: at("2026-09-15T12:00:00Z") });
    expect(await enqueueMemberDigests(f.tenantId, NOW)).toBe(1);
  });

  it("weekly: on the member's weekday and hour, keyed by the ISO week, counting the week", async () => {
    const emp = f.seats.employee.memberId;
    await f.platform.notificationPreference.create({
      data: {
        tenantId: f.tenantId,
        receiverType: "MEMBER",
        receiverId: emp,
        digestCadence: "WEEKLY",
        digestWeekday: 3, // Wednesday — 16 September
        digestHour: 8,
      },
    });
    const old = await notify({ memberId: emp, createdAt: at("2026-09-10T12:00:00Z") });
    expect(await enqueueMemberDigests(f.tenantId, NOW)).toBe(1);
    const [row] = await summaries();
    expect(row!.idempotencyKey).toBe(`digest:member:${emp}:2026-W38`);
    expect(row!.notificationIds).toEqual([old]);
    // Thursday: not its day.
    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
    expect(await enqueueMemberDigests(f.tenantId, at("2026-09-17T06:30:00Z"))).toBe(0);
  });

  it("a member's own zone moves their hour", async () => {
    const emp = f.seats.employee.memberId;
    await f.platform.member.update({ where: { id: emp }, data: { timezone: "America/New_York" } });
    try {
      await notify({ memberId: emp, createdAt: at("2026-09-15T12:00:00Z") });
      // 02:30 in New York: not yet.
      expect(await enqueueMemberDigests(f.tenantId, NOW)).toBe(0);
      // 08:30 in New York (EDT, UTC−4).
      expect(await enqueueMemberDigests(f.tenantId, at("2026-09-16T12:30:00Z"))).toBe(1);
    } finally {
      await f.platform.member.update({ where: { id: emp }, data: { timezone: null } });
    }
  });

  it("a workspace that is suspended, being offboarded or closed sends none", async () => {
    await notify({ memberId: f.seats.employee.memberId, createdAt: at("2026-09-15T12:00:00Z") });
    for (const status of ["SUSPENDED", "OFFBOARDING", "CLOSED"] as const) {
      await f.platform.tenant.update({ where: { id: f.tenantId }, data: { status } });
      expect(await enqueueMemberDigests(f.tenantId, NOW)).toBe(0);
    }
  });

  it("never counts more than the inbox's 500 rows", async () => {
    const emp = f.seats.employee.memberId;
    await f.platform.notification.createMany({
      data: Array.from({ length: 503 }, (_, i) => ({
        id: newId(),
        tenantId: f.tenantId,
        receiverType: "MEMBER" as const,
        receiverId: emp,
        kind: "work_item.commented",
        class: "COALESCED" as const,
        entityType: "WorkItem",
        entityId: newId(),
        createdAt: new Date(YESTERDAY_DUE.getTime() + (i + 1) * 60_000),
      })),
    });
    expect(await enqueueMemberDigests(f.tenantId, NOW)).toBe(1);
    expect((await summaries())[0]!.notificationIds).toHaveLength(500);
  });
});

/**
 * THE SEND, on the REAL clock: the outbox drops a summary still unsent three
 * hours after it was made, so a summary made "in September" would never go.
 * Each test puts the employee's summary at the current UTC hour, in UTC, so it
 * is due now; rows are stamped an hour ago.
 */
async function dueNowForEmployee(): Promise<Date> {
  const now = new Date();
  const emp = f.seats.employee.memberId;
  await f.platform.member.update({ where: { id: emp }, data: { timezone: "UTC" } });
  await f.platform.notificationPreference.create({
    data: { tenantId: f.tenantId, receiverType: "MEMBER", receiverId: emp, digestHour: now.getUTCHours() },
  });
  return now;
}

describe("the summary's send", () => {
  const hourAgo = () => new Date(Date.now() - 3_600_000);

  beforeEach(async () => {
    await f.platform.member.update({ where: { id: f.seats.employee.memberId }, data: { timezone: null } });
  });

  it("counts what is STILL unread when it goes, names nothing, carries the owner's address for replies, and stamps nothing", async () => {
    const emp = f.seats.employee.memberId;
    const now = await dueNowForEmployee();
    const a = await notify({ memberId: emp, createdAt: hourAgo() });
    const b = await notify({ memberId: emp, createdAt: hourAgo() });
    const c = await notify({ memberId: emp, kind: "budget.threshold_reached", createdAt: hourAgo() });
    expect(await enqueueMemberDigests(f.tenantId, now)).toBe(1);
    // Read in the app between the enqueue and the send.
    await f.platform.notification.update({ where: { id: a }, data: { readAt: new Date() } });
    const out = await drainOutbox(50, { tenantId: f.tenantId });
    expect(out.sent).toBe(1);
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.subject).toBe("Fortleva: 2 new updates in your inbox");
    expect(mail.text).toContain("- 1 task you follow has new comments");
    expect(mail.text).toContain("- 1 project budget reached a threshold");
    expect(mail.text).toContain("/inbox");
    expect(mail.text).toContain("/settings/notifications");
    expect(mail.text).not.toContain(f.tenantId);
    // The owner's sign-in address until the workspace confirms one (C68 (c)).
    const ownerEmail = (await f.platform.user.findUniqueOrThrow({ where: { id: f.seats.owner.userId } })).email;
    expect(mail.replyTo).toBe(ownerEmail.toLowerCase());
    // `emailedAt` belongs to the mail ABOUT one notification; a summary stamps nothing.
    const stamped = await f.platform.notification.count({
      where: { id: { in: [a, b, c] }, emailedAt: { not: null } },
    });
    expect(stamped).toBe(0);
    expect((await summaries())[0]!.status).toBe("SENT");
  });

  it("is SKIPPED when everything it would count has been read", async () => {
    const emp = f.seats.employee.memberId;
    const now = await dueNowForEmployee();
    const a = await notify({ memberId: emp, createdAt: hourAgo() });
    expect(await enqueueMemberDigests(f.tenantId, now)).toBe(1);
    await f.platform.notification.update({ where: { id: a }, data: { readAt: new Date() } });
    const out = await drainOutbox(50, { tenantId: f.tenantId });
    expect(out.skipped).toBe(1);
    expect(sent).toHaveLength(0);
    expect((await summaries())[0]!.status).toBe("SKIPPED");
    // All of it read: no drop reason — it still chains, losing nothing.
    expect((await summaries())[0]!.lastError).toBeNull();
  });

  it("is SKIPPED when the member chose Never after it was made, or no email, or was suspended", async () => {
    const emp = f.seats.employee.memberId;
    for (const change of ["never", "no-email", "suspended"] as const) {
      await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
      await f.platform.notificationPreference.deleteMany({ where: { tenantId: f.tenantId } });
      await f.platform.member.update({ where: { id: emp }, data: { status: "ACTIVE" } });
      const now = await dueNowForEmployee();
      await notify({ memberId: emp, createdAt: hourAgo() });
      expect(await enqueueMemberDigests(f.tenantId, now)).toBe(1);
      if (change === "never") {
        await f.platform.notificationPreference.updateMany({ where: { tenantId: f.tenantId }, data: { digestCadence: "NONE" } });
      } else if (change === "no-email") {
        await f.platform.notificationPreference.updateMany({ where: { tenantId: f.tenantId }, data: { emailLevel: "NONE" } });
      } else {
        await f.platform.member.update({ where: { id: emp }, data: { status: "SUSPENDED" } });
      }
      const out = await drainOutbox(50, { tenantId: f.tenantId });
      expect(out.skipped, change).toBe(1);
      expect(sent, change).toHaveLength(0);
      // Tagged as dropped, so the next summary does not count from it.
      expect((await summaries())[0]!.lastError, change).toBe("digest:unwanted");
    }
  });

  it("is SKIPPED when still unsent four hours after it was made (three catch-up hours and one of grace)", async () => {
    const emp = f.seats.employee.memberId;
    const mine = await notify({ memberId: emp, createdAt: hourAgo() });
    await f.platform.emailOutbox.create({
      data: {
        tenantId: f.tenantId,
        idempotencyKey: `digest:member:${emp}:late`,
        receiverType: "MEMBER",
        receiverId: emp,
        toEmail: "employee-late@test.invalid",
        kind: MEMBER_DIGEST_MAIL,
        locale: "en",
        notificationIds: [mine],
        sendAfter: new Date(Date.now() - 60_000),
        createdAt: new Date(Date.now() - 4.5 * 3_600_000),
      },
    });
    const out = await drainOutbox(50, { tenantId: f.tenantId });
    expect(out.skipped).toBe(1);
    expect(sent).toHaveLength(0);
    expect((await summaries())[0]!.lastError).toBe("digest:late");
  });

  it("measures late from the summary's OWN time: one made in its third hour still goes at the next hourly drain; four hours on, it is dropped", async () => {
    const emp = f.seats.employee.memberId;
    const madeAt = (dueHoursAgo: number, key: string, id: string) =>
      f.platform.emailOutbox.create({
        data: {
          tenantId: f.tenantId,
          idempotencyKey: `digest:member:${emp}:${key}`,
          receiverType: "MEMBER",
          receiverId: emp,
          toEmail: "employee-made-late@test.invalid",
          kind: MEMBER_DIGEST_MAIL,
          locale: "en",
          // Made just now, for a summary due `dueHoursAgo` hours ago.
          params: { dueAt: new Date(Date.now() - dueHoursAgo * 3_600_000).toISOString() },
          notificationIds: [id],
          sendAfter: new Date(Date.now() - 60_000),
        },
      });
    // Made at 10:00 for 08:00, drained at 11:30: inside the grace hour — sent.
    await madeAt(3.5, "third-hour", await notify({ memberId: emp, createdAt: hourAgo() }));
    expect((await drainOutbox(50, { tenantId: f.tenantId })).sent).toBe(1);
    // Due four and a half hours ago: dropped.
    await madeAt(4.5, "too-late", await notify({ memberId: emp, createdAt: hourAgo() }));
    const out = await drainOutbox(50, { tenantId: f.tenantId });
    expect(out.skipped).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("never counts another member's rows, even if an id were linked to it", async () => {
    const emp = f.seats.employee.memberId;
    const mine = await notify({ memberId: emp, createdAt: hourAgo() });
    const theirs = await notify({ memberId: f.seats.manager.memberId, createdAt: hourAgo() });
    const theirs2 = await notify({ memberId: f.seats.manager.memberId, createdAt: hourAgo() });
    await f.platform.emailOutbox.create({
      data: {
        tenantId: f.tenantId,
        idempotencyKey: `digest:member:${emp}:forged`,
        receiverType: "MEMBER",
        receiverId: emp,
        toEmail: "employee-forged@test.invalid",
        kind: MEMBER_DIGEST_MAIL,
        locale: "en",
        notificationIds: [mine, theirs, theirs2],
        sendAfter: new Date(Date.now() - 60_000),
      },
    });
    await drainOutbox(50, { tenantId: f.tenantId });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("Fortleva: 1 new update in your inbox");
  });

  it("a one-tenant drain's audit rows are that tenant's", async () => {
    const before = (await f.audits("platform.system_job")).length;
    await drainOutbox(50, { tenantId: f.tenantId });
    expect((await f.audits("platform.system_job")).length).toBeGreaterThan(before);
  });
});
