import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { withTenant } from "@/db";
import {
  applyNotificationRetention,
  ARCHIVE_AFTER_DAYS,
  KEEP_NEWEST,
  notificationRetentionTenants,
} from "@/jobs/notification-retention";
import { newId } from "@/lib/ids";
import { setupTenant } from "@/members/dbtest-fixture";
import { assignItem, createItem } from "@/modules/work";
import { requestReceivers } from "@/modules/work/notify";

import { emit } from "./emit";
import { listInbox } from "./inbox";
import { NOTIFICATION_REASONS } from "./reasons";

/**
 * The inbox's polish (Phase 5 slice 104; founder decision C72) against the
 * real database and the real `app_runtime` role:
 *
 *   · the REASON — written by `emit` from the receivers' map, read back by
 *     the list; the CHECK holds the closed set (and no reason on a contact
 *     row); the runtime role cannot change it after the fact;
 *   · the HOUSEKEEPING — archive by age (from the later of the stamp and the
 *     snooze) and beyond the newest 500, never a row snoozed ahead; delete a
 *     year after archiving, as the tenant's SYSTEM principal and with no row
 *     in the tenant's log; the DATABASE's own hold on that delete; never a
 *     row of another tenant.
 *
 * Two tenants, both `inbx-` (registered in `DBTEST_PREFIXES`). The job
 * itself is never run — it walks every tenant of the database; the
 * per-tenant function is called for THIS suite's tenant only.
 */

let a: Awaited<ReturnType<typeof setupTenant>>;
let b: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let projectId: string;

const DAY = 86_400_000;

beforeAll(async () => {
  a = await setupTenant("inbx");
  b = await setupTenant("inbx");
  clientId = randomUUID();
  projectId = randomUUID();
  await a.platform.client.create({ data: { id: clientId, tenantId: a.tenantId, name: "Reasons Co" } });
  await a.platform.project.create({
    data: {
      id: projectId,
      tenantId: a.tenantId,
      clientId,
      key: "INBP",
      name: "Reasons project",
      leadMemberId: a.seats.manager.memberId,
    },
  });
  await a.platform.memberProject.createMany({
    data: [
      { tenantId: a.tenantId, projectId, memberId: a.seats.employee.memberId },
      { tenantId: a.tenantId, projectId, memberId: a.seats.manager.memberId },
    ],
  });
}, 120_000);

afterAll(async () => {
  for (const f of [a, b]) {
    if (!f) continue;
    const db = f.platform;
    await db.notification.deleteMany({ where: { tenantId: f.tenantId } });
    await db.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
    await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
    await db.workItem.deleteMany({ where: { tenantId: f.tenantId, parentId: { not: null } } });
    await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
    await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
    await db.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
    await db.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
    await db.project.deleteMany({ where: { tenantId: f.tenantId } });
    await db.client.deleteMany({ where: { tenantId: f.tenantId } });
    await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
    await f.cleanup();
  }
}, 120_000);

beforeEach(async () => {
  await a.platform.notification.deleteMany({ where: { tenantId: a.tenantId } });
  await b.platform.notification.deleteMany({ where: { tenantId: b.tenantId } });
});

/** A row straight through the platform client — ids from `newId()`, as `emit` writes them. */
const plant = async (
  f: typeof a,
  receiverId: string,
  over: Partial<{
    id: string;
    reason: string | null;
    createdAt: Date;
    readAt: Date | null;
    archivedAt: Date | null;
    snoozedTill: Date | null;
  }> = {},
): Promise<string> => {
  const id = over.id ?? newId();
  await f.platform.notification.create({
    data: {
      id,
      tenantId: f.tenantId,
      receiverType: "MEMBER",
      receiverId,
      kind: "work_item.assigned",
      class: "INSTANT",
      entityType: "WorkItem",
      entityId: randomUUID(),
      reason: over.reason ?? null,
      readAt: over.readAt ?? null,
      archivedAt: over.archivedAt ?? null,
      snoozedTill: over.snoozedTill ?? null,
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    },
  });
  return id;
};

const row = (f: typeof a, id: string) => f.platform.notification.findUnique({ where: { id } });

describe("why it reached them", () => {
  it("an assignment is stored as ASSIGNEE and read back by the list", async () => {
    const ctx = { tenantId: a.tenantId, actor: a.seats.owner.actor };
    const item = await createItem(ctx, { projectId, title: "Reasoned" });
    await assignItem(ctx, item.id, a.seats.employee.memberId);
    const stored = await a.platform.notification.findMany({
      where: { tenantId: a.tenantId, receiverId: a.seats.employee.memberId },
      select: { reason: true, kind: true },
    });
    expect(stored).toEqual([{ reason: "ASSIGNEE", kind: "work_item.assigned" }]);
    const listed = await listInbox({ tenantId: a.tenantId, actor: a.seats.employee.actor }, { filter: "unread" });
    expect(listed.rows.map((r) => r.reason)).toEqual(["ASSIGNEE"]);
  });

  it("a project's people: the lead as the lead though also assigned, the rest as members — and emit stores each", async () => {
    const receivers = await withTenant(a.tenantId, { type: "system" }, (tx) =>
      requestReceivers(tx, a.tenantId, projectId),
    );
    expect(Object.fromEntries(receivers)).toEqual({
      [a.seats.manager.memberId]: "PROJECT_LEAD",
      [a.seats.employee.memberId]: "PROJECT_MEMBER",
    });
    await withTenant(a.tenantId, { type: "system" }, (tx) =>
      emit(tx, a.tenantId, {
        kind: "work_item.request_received",
        entity: { type: "WorkItem", id: randomUUID() },
        projectId,
        receivers,
      }),
    );
    const stored = await a.platform.notification.findMany({
      where: { tenantId: a.tenantId },
      select: { receiverId: true, reason: true },
    });
    expect(Object.fromEntries(stored.map((r) => [r.receiverId, r.reason]))).toEqual({
      [a.seats.manager.memberId]: "PROJECT_LEAD",
      [a.seats.employee.memberId]: "PROJECT_MEMBER",
    });
  });

  it("the CHECK holds the closed set — every reason the code knows inserts, nothing else does", async () => {
    // Drift between `NOTIFICATION_REASONS` and the migration's list fails HERE.
    for (const reason of NOTIFICATION_REASONS) {
      await expect(plant(a, a.seats.owner.memberId, { reason }), reason).resolves.toBeTypeOf("string");
    }
    await expect(plant(a, a.seats.owner.memberId, { reason: "MENTIONED" })).rejects.toThrow(/notification_reason_known/);
    await expect(plant(a, a.seats.owner.memberId, { reason: "owner" })).rejects.toThrow(/notification_reason_known/);
  });

  it("a contact's row carries no reason", async () => {
    const contactId = randomUUID();
    await expect(
      a.platform.notification.create({
        data: {
          id: newId(),
          tenantId: a.tenantId,
          receiverType: "CONTACT",
          receiverId: contactId,
          clientId,
          kind: "work_item.assigned",
          class: "INSTANT",
          entityType: "WorkItem",
          entityId: randomUUID(),
          reason: "CLIENT_MEMBER",
        },
      }),
    ).rejects.toThrow(/notification_reason_known/);
  });

  it("the runtime role cannot change a reason after the fact — not even the receiver's own", async () => {
    const id = await plant(a, a.seats.owner.memberId, { reason: "PROJECT_MEMBER" });
    await expect(
      withTenant(a.tenantId, { type: "member", id: a.seats.owner.memberId }, (tx) =>
        tx.notification.updateMany({ where: { id }, data: { reason: "OWNER" } }),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withTenant(a.tenantId, { type: "system" }, (tx) =>
        tx.$executeRaw`UPDATE notification SET reason = 'OWNER' WHERE id = ${id}`,
      ),
    ).rejects.toThrow(/permission denied/i);
    expect((await row(a, id))?.reason).toBe("PROJECT_MEMBER");
  });
});

describe("the housekeeping (C72 (f))", () => {
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const ahead = (days: number) => new Date(now.getTime() + days * DAY);
  const monthsAgo = (months: number) => {
    const d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() - months);
    return d;
  };

  it("archives by age — from the later of the stamp and the snooze — and marks read; never a row snoozed ahead", async () => {
    const owner = a.seats.owner.memberId;
    const old = await plant(a, owner, { createdAt: ago(ARCHIVE_AFTER_DAYS + 1) });
    const oldRead = await plant(a, owner, { createdAt: ago(ARCHIVE_AFTER_DAYS + 5), readAt: ago(ARCHIVE_AFTER_DAYS + 4) });
    const young = await plant(a, owner, { createdAt: ago(ARCHIVE_AFTER_DAYS - 1) });
    // Snoozed into the future: never archived, however old.
    const parked = await plant(a, owner, { createdAt: ago(200), snoozedTill: ahead(3) });
    // Came back from a snooze ten days ago: its 90 days run from then.
    const woke = await plant(a, owner, { createdAt: ago(200), snoozedTill: ago(10) });
    // …and one that came back long enough ago goes.
    const wokeLongAgo = await plant(a, owner, { createdAt: ago(300), snoozedTill: ago(ARCHIVE_AFTER_DAYS + 2) });
    const audited = (await a.audits("platform.system_job")).length;

    const r = await applyNotificationRetention(a.tenantId, now);
    expect(r).toEqual({ archived: 3, deleted: 0 });
    // Nothing was due for deletion, so no "delete" row reached the tenant's
    // log (the code and security reviews' medium: it used to, every run).
    expect((await a.audits("platform.system_job")).length).toBe(audited);

    for (const id of [old, oldRead, wokeLongAgo]) {
      const after = await row(a, id);
      expect(after?.archivedAt?.getTime(), id).toBe(now.getTime());
      expect(after?.readAt, id).not.toBeNull();
    }
    // A row already read keeps the moment it was read.
    expect((await row(a, oldRead))?.readAt?.getTime()).toBe(ago(ARCHIVE_AFTER_DAYS + 4).getTime());
    for (const id of [young, parked, woke]) expect((await row(a, id))?.archivedAt, id).toBeNull();

    // Idempotent: nothing left to do.
    expect(await applyNotificationRetention(a.tenantId, now)).toEqual({ archived: 0, deleted: 0 });
  });

  it("archives beyond the receiver's newest 500, oldest first — per receiver, sparing a row snoozed ahead", async () => {
    const employee = a.seats.employee.memberId;
    const ids = Array.from({ length: KEEP_NEWEST + 3 }, () => newId());
    await a.platform.notification.createMany({
      data: ids.map((id) => ({
        id,
        tenantId: a.tenantId,
        receiverType: "MEMBER" as const,
        receiverId: employee,
        kind: "work_item.assigned",
        class: "INSTANT" as const,
        entityType: "WorkItem",
        entityId: randomUUID(),
        // The third-oldest is snoozed ahead: it stays, though past the cap.
        ...(id === ids[2] ? { snoozedTill: ahead(1) } : {}),
      })),
    });
    // Another receiver's few rows are not counted against this one's 500.
    const other = await plant(a, a.seats.owner.memberId);

    const r = await applyNotificationRetention(a.tenantId, now);
    expect(r).toEqual({ archived: 2, deleted: 0 });
    const archived = await a.platform.notification.findMany({
      where: { tenantId: a.tenantId, archivedAt: { not: null } },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(archived.map((x) => x.id)).toEqual([ids[0], ids[1]]);
    expect((await row(a, ids[2]!))?.archivedAt).toBeNull();
    expect((await row(a, other))?.archivedAt).toBeNull();
  });

  it("deletes a row archived more than 12 months ago and keeps a younger one — writing nothing into the tenant's log", async () => {
    const owner = a.seats.owner.memberId;
    const gone = await plant(a, owner, { createdAt: monthsAgo(14), readAt: monthsAgo(13), archivedAt: monthsAgo(13) });
    // The year counts from the ARCHIVE, not from the stamp: 14 months old, archived 11 ago, stays.
    const kept = await plant(a, owner, { createdAt: monthsAgo(14), readAt: monthsAgo(11), archivedAt: monthsAgo(11) });
    const before = (await a.audits("platform.system_job")).length;

    const r = await applyNotificationRetention(a.tenantId, now);
    expect(r).toEqual({ archived: 0, deleted: 1 });
    expect(await row(a, gone)).toBeNull();
    expect(await row(a, kept)).not.toBeNull();
    // The delete runs as the tenant's own SYSTEM principal — no platform
    // write, so no "delete" row in the tenant's log (the reviews' medium).
    expect((await a.audits("platform.system_job")).length).toBe(before);
  });

  it("the DATABASE holds the delete: only SYSTEM, only a row archived over a year — never a member or a contact", async () => {
    const owner = a.seats.owner.memberId;
    const old = await plant(a, owner, { createdAt: monthsAgo(14), readAt: monthsAgo(13), archivedAt: monthsAgo(13) });
    const young = await plant(a, owner, { createdAt: monthsAgo(3), readAt: monthsAgo(2), archivedAt: monthsAgo(2) });
    const live = await plant(a, owner, { createdAt: monthsAgo(20) });
    // A contact's OWN row, archived over a year ago — one a contact can SEE
    // (`principal_scope`), so refusing it is the delete policies' doing, not
    // the read policy's (the fix-pass review's low).
    const contactId = randomUUID();
    const theirs = newId();
    await a.platform.notification.create({
      data: {
        id: theirs,
        tenantId: a.tenantId,
        receiverType: "CONTACT",
        receiverId: contactId,
        clientId,
        kind: "work_item.assigned",
        class: "INSTANT",
        entityType: "WorkItem",
        entityId: randomUUID(),
        readAt: monthsAgo(13),
        archivedAt: monthsAgo(13),
        createdAt: monthsAgo(14),
      },
    });
    const del = (principal: Parameters<typeof withTenant>[1]) =>
      withTenant(a.tenantId, principal, (tx) => tx.$executeRaw`DELETE FROM notification WHERE tenant_id = ${a.tenantId}`);

    // The receiver themselves: no such verb, and the database agrees.
    expect(await del({ type: "member", id: owner })).toBe(0);
    // A contact, even their own year-old archived row: `portal_delete_deny`
    // and `retention_delete` together (the census and the isolation pin hold
    // the first structurally — the second alone already refuses a contact).
    expect(await del({ type: "contact", id: contactId, clientId })).toBe(0);
    for (const id of [old, young, live, theirs]) expect(await row(a, id), id).not.toBeNull();

    // SYSTEM, asked to delete EVERYTHING, takes only the rows archived over a year ago.
    expect(await del({ type: "system" })).toBe(2);
    expect(await row(a, old)).toBeNull();
    expect(await row(a, theirs)).toBeNull();
    expect(await row(a, young)).not.toBeNull();
    expect(await row(a, live)).not.toBeNull();
  });

  it("finds both tenants, and one tenant's run never touches the other's rows", async () => {
    const inA = await plant(a, a.seats.owner.memberId, { createdAt: ago(ARCHIVE_AFTER_DAYS + 10) });
    const inB = await plant(b, b.seats.owner.memberId, { createdAt: ago(ARCHIVE_AFTER_DAYS + 10) });
    const deadInB = await plant(b, b.seats.owner.memberId, {
      createdAt: monthsAgo(20),
      readAt: monthsAgo(19),
      archivedAt: monthsAgo(19),
    });

    const found = await notificationRetentionTenants(now);
    expect(found).toEqual(expect.arrayContaining([a.tenantId, b.tenantId]));

    expect(await applyNotificationRetention(a.tenantId, now)).toEqual({ archived: 1, deleted: 0 });
    expect((await row(a, inA))?.archivedAt).not.toBeNull();
    expect((await row(b, inB))?.archivedAt).toBeNull();
    expect(await row(b, deadInB)).not.toBeNull();
  });

  it("each discovery pass finds a tenant on its own — the count, and the old archive", async () => {
    // Over the cap, every row young: found by the count alone.
    await b.platform.notification.createMany({
      data: Array.from({ length: KEEP_NEWEST + 1 }, () => ({
        id: newId(),
        tenantId: b.tenantId,
        receiverType: "MEMBER" as const,
        receiverId: b.seats.owner.memberId,
        kind: "work_item.assigned",
        class: "INSTANT" as const,
        entityType: "WorkItem",
        entityId: randomUUID(),
      })),
    });
    expect(await notificationRetentionTenants(now)).toContain(b.tenantId);

    // An archived row past its year, nothing else: found by the archive alone.
    await b.platform.notification.deleteMany({ where: { tenantId: b.tenantId } });
    // (Old, but archived — so the age pass, which reads unarchived rows only, cannot be what finds it.)
    await plant(b, b.seats.owner.memberId, { createdAt: monthsAgo(14), readAt: monthsAgo(13), archivedAt: monthsAgo(13) });
    expect(await notificationRetentionTenants(now)).toContain(b.tenantId);
  });

  it("an empty tenant is not found for want of work", async () => {
    await plant(b, b.seats.owner.memberId);
    expect(await notificationRetentionTenants(now)).not.toContain(b.tenantId);
  });
});
