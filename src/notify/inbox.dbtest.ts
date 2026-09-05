import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DomainError } from "@/lib/domain-error";
import { newId } from "@/lib/ids";
import { setupTenant } from "@/members/dbtest-fixture";
import { assignItem, createItem } from "@/modules/work";

import {
  INBOX_PAGE_SIZE,
  MAX_INBOX_IDS,
  archive,
  countUnread,
  listInbox,
  markAllRead,
  markRead,
  markUnread,
  snooze,
  unarchive,
  unsnooze,
} from "./inbox";

/**
 * The member inbox against the real database and the real `app_runtime`
 * role.
 *
 * What is at stake here is not the buckets — it is the two properties
 * the service claims and cannot prove in a unit test:
 *
 *   1. A member reaches ONLY their own notifications, because the
 *      `principal_scope` RLS policy says so and not because the
 *      application remembered to filter. So the writes are aimed at
 *      another member's rows deliberately, and the answer must be
 *      indistinguishable from the answer for an id that never existed.
 *   2. A subject is resolved through `scopeWhere`, so a member who has
 *      LOST scope on a project cannot read a task's title back off
 *      their own inbox. That is the same defect the bulk-bar security
 *      review found, one surface over.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let projectId: string;
let projectKey: string;
/** A project of a different client — never in the employee's scope. */
let foreignClientId: string;
let foreignProjectId: string;

beforeAll(async () => {
  f = await setupTenant("inbox");
  clientId = randomUUID();
  projectId = randomUUID();
  projectKey = "INBX";
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Inbox Co" } });
  await f.platform.project.create({
    data: { id: projectId, tenantId: f.tenantId, clientId, key: projectKey, name: "Inbox project" },
  });
  foreignClientId = randomUUID();
  foreignProjectId = randomUUID();
  await f.platform.client.create({
    data: { id: foreignClientId, tenantId: f.tenantId, name: "Not yours" },
  });
  await f.platform.project.create({
    data: {
      id: foreignProjectId,
      tenantId: f.tenantId,
      clientId: foreignClientId,
      key: "INBXX",
      name: "Foreign project",
    },
  });
}, 60_000);

afterAll(async () => {
  const db = f.platform;
  await db.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await db.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
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
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
});

const ctxFor = (memberId: string) => ({
  tenantId: f.tenantId,
  actor: memberId === f.seats.owner.memberId ? f.seats.owner.actor : f.seats.employee.actor,
});
const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

/** Write a notification straight through the platform client: these
 * tests are about how the inbox READS and updates rows, and a fixture
 * that had to go through `emit` could not produce a read, archived or
 * snoozed one at all.
 *
 * The id is a UUIDv7 from `newId()`, exactly as `emit` writes — the
 * inbox orders and pages on it, so a v4 here would order the fixture
 * randomly and prove nothing about the real thing. `newId()` is
 * monotonic, so rows created in sequence sort in that sequence. */
const give = async (
  receiverId: string,
  over: Partial<{
    id: string;
    kind: string;
    entityType: string;
    entityId: string;
    projectId: string | null;
    readAt: Date | null;
    archivedAt: Date | null;
    snoozedTill: Date | null;
    createdAt: Date;
  }> = {},
): Promise<string> => {
  const id = over.id ?? newId();
  await f.platform.notification.create({
    data: {
      id,
      tenantId: f.tenantId,
      receiverType: "MEMBER",
      receiverId,
      kind: over.kind ?? "work_item.assigned",
      class: "INSTANT",
      entityType: over.entityType ?? "WorkItem",
      entityId: over.entityId ?? randomUUID(),
      projectId: over.projectId === undefined ? projectId : over.projectId,
      readAt: over.readAt ?? null,
      archivedAt: over.archivedAt ?? null,
      snoozedTill: over.snoozedTill ?? null,
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    },
  });
  return id;
};

const idsIn = async (memberId: string, filter: "unread" | "all" | "snoozed" | "archived") =>
  (await listInbox(ctxFor(memberId), { filter })).rows.map((r) => r.id);

const scopeEmployeeToInboxClient = () =>
  f.platform.memberClient.upsert({
    where: {
      tenantId_memberId_clientId: {
        tenantId: f.tenantId,
        memberId: f.seats.employee.memberId,
        clientId,
      },
    },
    create: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId },
    update: {},
  });

describe("inbox — the receiver boundary", () => {
  it("a member reads ONLY their own rows: RLS, not an application filter", async () => {
    const mine = await give(f.seats.owner.memberId);
    const theirs = await give(f.seats.employee.memberId);

    expect(await idsIn(f.seats.owner.memberId, "all")).toEqual([mine]);
    expect(await idsIn(f.seats.employee.memberId, "all")).toEqual([theirs]);
    expect(await countUnread(ownerCtx())).toBe(1);
    expect(await countUnread(employeeCtx())).toBe(1);
  });

  it("ANOTHER MEMBER'S id answers exactly like an id that never existed", async () => {
    // The oracle test. `INVALID_INPUT` vs a zero count is the only pair
    // of answers this surface can give, so a foreign id and a ghost id
    // must produce the same one — otherwise holding a UUID tells you
    // whether it is somebody's live notification.
    const theirs = await give(f.seats.employee.memberId);
    const ghost = randomUUID();

    expect(await markRead(ownerCtx(), [theirs])).toBe(0);
    expect(await markRead(ownerCtx(), [ghost])).toBe(0);
    expect(await archive(ownerCtx(), [theirs])).toBe(0);
    expect(await archive(ownerCtx(), [ghost])).toBe(0);

    // And nothing was written on the way past.
    const row = await f.platform.notification.findUniqueOrThrow({ where: { id: theirs } });
    expect(row.readAt).toBeNull();
    expect(row.archivedAt).toBeNull();
  });

  it("markAllRead cannot reach past its own receiver", async () => {
    await give(f.seats.owner.memberId);
    const theirs = await give(f.seats.employee.memberId);

    expect(await markAllRead(ownerCtx())).toBe(1);
    const row = await f.platform.notification.findUniqueOrThrow({ where: { id: theirs } });
    expect(row.readAt).toBeNull();
  });
});

describe("inbox — the buckets", () => {
  it("unread excludes read, archived and still-snoozed rows — and includes an EXPIRED snooze", async () => {
    const hour = 60 * 60 * 1000;
    const plain = await give(f.seats.owner.memberId);
    const expired = await give(f.seats.owner.memberId, {
      snoozedTill: new Date(Date.now() - hour),
    });
    const parked = await give(f.seats.owner.memberId, {
      snoozedTill: new Date(Date.now() + hour),
    });
    const read = await give(f.seats.owner.memberId, { readAt: new Date() });
    const archived = await give(f.seats.owner.memberId, { archivedAt: new Date() });

    const unread = new Set(await idsIn(f.seats.owner.memberId, "unread"));
    expect(unread).toEqual(new Set([plain, expired]));
    // The badge and the tab are the same question, asked twice.
    expect(await countUnread(ownerCtx())).toBe(2);

    expect(await idsIn(f.seats.owner.memberId, "snoozed")).toEqual([parked]);
    expect(await idsIn(f.seats.owner.memberId, "archived")).toEqual([archived]);
    const all = new Set(await idsIn(f.seats.owner.memberId, "all"));
    expect(all).toEqual(new Set([plain, expired, parked, read]));
    expect(all.has(archived)).toBe(false);
  });

  it("newest first, and the cursor pages without a gap or an overlap", async () => {
    const total = INBOX_PAGE_SIZE + 5;
    const created: string[] = [];
    for (let i = 0; i < total; i++) created.push(await give(f.seats.owner.memberId));
    // Newest first = reverse creation order, because a v7 id carries the
    // creation instant and the list orders on it.
    const newestFirst = [...created].reverse();

    const first = await listInbox(ownerCtx(), { filter: "unread" });
    expect(first.rows.length).toBe(INBOX_PAGE_SIZE);
    expect(first.rows.map((r) => r.id)).toEqual(newestFirst.slice(0, INBOX_PAGE_SIZE));
    expect(first.nextCursor).not.toBeNull();

    const second = await listInbox(ownerCtx(), { filter: "unread", cursor: first.nextCursor });
    expect(second.rows.map((r) => r.id)).toEqual(newestFirst.slice(INBOX_PAGE_SIZE));
    expect(second.nextCursor).toBeNull();
  });

  it("A SNOOZED ROW STAYS HIDDEN ON PAGE TWO — the filter and the cursor must not collide", async () => {
    // The defect this pins: the unread filter and the keyset clause both
    // carry a top-level `OR`, so composing them by SPREADING dropped the
    // snooze term on every page after the first, and a parked row came
    // back the moment the member paged past fifty.
    const hour = 60 * 60 * 1000;
    // Created FIRST, so it is the oldest row and can only ever fall on
    // the SECOND page — which is the page the collision used to break.
    const parked = await give(f.seats.owner.memberId, {
      snoozedTill: new Date(Date.now() + hour),
    });
    for (let i = 1; i <= INBOX_PAGE_SIZE + 3; i++) await give(f.seats.owner.memberId);

    const first = await listInbox(ownerCtx(), { filter: "unread" });
    expect(first.rows.length).toBe(INBOX_PAGE_SIZE);
    const second = await listInbox(ownerCtx(), { filter: "unread", cursor: first.nextCursor });
    const seen = [...first.rows, ...second.rows].map((r) => r.id);
    expect(seen).not.toContain(parked);
    expect(seen.length).toBe(INBOX_PAGE_SIZE + 3);
    // And it is still exactly where it belongs.
    expect(await idsIn(f.seats.owner.memberId, "snoozed")).toEqual([parked]);
  });

  it("a nonsense cursor is the first page, never an error", async () => {
    const one = await give(f.seats.owner.memberId);
    for (const cursor of ["", "abc", "0.", ".x", "not-a-uuid", `${one} OR 1=1`]) {
      const page = await listInbox(ownerCtx(), { filter: "unread", cursor });
      expect(page.rows.map((r) => r.id), cursor).toEqual([one]);
    }
  });

  it("EVERY ROW OF A ONE-TRANSACTION BATCH SURVIVES THE PAGE BOUNDARY", async () => {
    // The defect this pins: `created_at` defaults to `now()` — the
    // TRANSACTION's start, to the microsecond — so rows emitted together
    // share it exactly, and a cursor built from a JS Date (milliseconds)
    // skipped every one of them on the page after the boundary. Ordering
    // on the v7 id removes the rounding entirely.
    const at = new Date();
    const batch: string[] = [];
    for (let i = 0; i < INBOX_PAGE_SIZE + 6; i++) {
      batch.push(await give(f.seats.owner.memberId, { createdAt: at }));
    }
    const first = await listInbox(ownerCtx(), { filter: "unread" });
    const second = await listInbox(ownerCtx(), { filter: "unread", cursor: first.nextCursor });
    const seen = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(seen).size).toBe(batch.length); // no duplicates
    expect(new Set(seen)).toEqual(new Set(batch)); // and none lost
  });
});

describe("inbox — the verbs", () => {
  it("read / unread round-trips, and a second call changes nothing", async () => {
    const id = await give(f.seats.owner.memberId);
    expect(await markRead(ownerCtx(), [id])).toBe(1);
    expect(await markRead(ownerCtx(), [id])).toBe(0);
    expect(await countUnread(ownerCtx())).toBe(0);
    expect(await markUnread(ownerCtx(), [id])).toBe(1);
    expect(await countUnread(ownerCtx())).toBe(1);
  });

  it("ARCHIVING ALSO MARKS READ — an archived row must not keep inflating the badge", async () => {
    const id = await give(f.seats.owner.memberId);
    expect(await archive(ownerCtx(), [id])).toBe(1);
    const row = await f.platform.notification.findUniqueOrThrow({ where: { id } });
    expect(row.archivedAt).not.toBeNull();
    expect(row.readAt).not.toBeNull();
    expect(await countUnread(ownerCtx())).toBe(0);

    expect(await unarchive(ownerCtx(), [id])).toBe(1);
    // Restoring does NOT un-read it: it was seen.
    expect(await countUnread(ownerCtx())).toBe(0);
    expect(await idsIn(f.seats.owner.memberId, "all")).toEqual([id]);
  });

  it("a snooze un-reads the row and hides it until the instant passes", async () => {
    const id = await give(f.seats.owner.memberId, { readAt: new Date() });
    const till = new Date(Date.now() + 60 * 60 * 1000);
    expect(await snooze(ownerCtx(), [id], till)).toBe(1);

    expect(await countUnread(ownerCtx())).toBe(0);
    expect(await idsIn(f.seats.owner.memberId, "unread")).toEqual([]);
    expect(await idsIn(f.seats.owner.memberId, "snoozed")).toEqual([id]);

    expect(await unsnooze(ownerCtx(), [id])).toBe(1);
    // Un-snoozing brings it back UNREAD, which is what the snooze promised.
    expect(await countUnread(ownerCtx())).toBe(1);
  });

  it("markAllRead reaches past the first page but leaves snoozed and archived rows alone", async () => {
    const hour = 60 * 60 * 1000;
    for (let i = 0; i < INBOX_PAGE_SIZE + 3; i++) await give(f.seats.owner.memberId);
    const parked = await give(f.seats.owner.memberId, { snoozedTill: new Date(Date.now() + hour) });
    const archived = await give(f.seats.owner.memberId, { archivedAt: new Date() });

    expect(await markAllRead(ownerCtx())).toBe(INBOX_PAGE_SIZE + 3);
    expect(await countUnread(ownerCtx())).toBe(0);
    const parkedRow = await f.platform.notification.findUniqueOrThrow({ where: { id: parked } });
    expect(parkedRow.readAt).toBeNull();
    const archivedRow = await f.platform.notification.findUniqueOrThrow({ where: { id: archived } });
    expect(archivedRow.readAt).toBeNull();
  });

  it("refuses an empty selection, an oversized one, and a snooze outside its bounds", async () => {
    const id = await give(f.seats.owner.memberId);
    await expect(markRead(ownerCtx(), [])).rejects.toThrow(DomainError);
    await expect(
      markRead(
        ownerCtx(),
        Array.from({ length: MAX_INBOX_IDS + 1 }, () => randomUUID()),
      ),
    ).rejects.toThrow(DomainError);
    await expect(snooze(ownerCtx(), [id], new Date(Date.now() - 1000))).rejects.toThrow(DomainError);
    await expect(
      snooze(ownerCtx(), [id], new Date(Date.now() + 91 * 24 * 60 * 60 * 1000)),
    ).rejects.toThrow(DomainError);
    // None of the refusals wrote anything.
    const row = await f.platform.notification.findUniqueOrThrow({ where: { id } });
    expect(row.readAt).toBeNull();
    expect(row.snoozedTill).toBeNull();
  });
});

describe("inbox — what a row is ABOUT", () => {
  it("resolves an in-scope task to its title and its peek link", async () => {
    const item = await createItem(ownerCtx(), { projectId, title: "Resolve me" });
    await give(f.seats.owner.memberId, { entityType: "WorkItem", entityId: item.id });

    const [row] = (await listInbox(ownerCtx(), { filter: "unread" })).rows;
    expect(row?.kind).toBe("work_item.assigned");
    expect(row?.subject).toEqual({
      title: "Resolve me",
      href: `/projects/${projectKey}/backlog?item=${projectKey}-${item.number}`,
    });
  });

  it("A MEMBER WITHOUT SCOPE ON THE PROJECT GETS NO TITLE AND NO LINK — the row still shows", async () => {
    // The property the service claims: member scope is application-level
    // and never an RLS term, so a bare tenant-scoped read here would
    // hand a member the title of work they cannot see. The notification
    // is genuinely theirs — only the subject is not.
    await f.platform.memberClient.deleteMany({
      where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId },
    });
    const item = await createItem(ownerCtx(), { projectId, title: "Secret title" });
    await give(f.seats.employee.memberId, { entityType: "WorkItem", entityId: item.id });

    const [blind] = (await listInbox(employeeCtx(), { filter: "unread" })).rows;
    expect(blind?.subject).toBeNull();
    // The kind still renders, so the member is told SOMETHING happened.
    expect(blind?.kind).toBe("work_item.assigned");

    // Give them the client and the very same row resolves.
    await scopeEmployeeToInboxClient();
    const [seeing] = (await listInbox(employeeCtx(), { filter: "unread" })).rows;
    expect(seeing?.subject?.title).toBe("Secret title");
    await f.platform.memberClient.deleteMany({
      where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId },
    });
  });

  it("a deleted task and a foreign one look the same from the inbox: no subject", async () => {
    const foreign = await createItem(ownerCtx(), {
      projectId: foreignProjectId,
      title: "Foreign title",
    });
    await scopeEmployeeToInboxClient();
    const ghostId = await give(f.seats.employee.memberId, {
      entityType: "WorkItem",
      entityId: randomUUID(),
    });
    const foreignId = await give(f.seats.employee.memberId, {
      entityType: "WorkItem",
      entityId: foreign.id,
      projectId: foreignProjectId,
    });

    const rows = (await listInbox(employeeCtx(), { filter: "unread" })).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(ghostId)?.subject).toBeNull();
    expect(byId.get(foreignId)?.subject).toBeNull();
    await f.platform.memberClient.deleteMany({
      where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId },
    });
  });

  it("A ROLE WITHOUT work_item:view GETS NO TITLE — the list is ungated, the subject is not", async () => {
    // Reaching your own inbox needs no permission; reading a task's
    // TITLE is what `work_item:view` governs, and a member can be
    // assigned a task by someone else without holding any work
    // permission of their own.
    await scopeEmployeeToInboxClient();
    const item = await createItem(ownerCtx(), { projectId, title: "Gated title" });
    await give(f.seats.employee.memberId, { entityType: "WorkItem", entityId: item.id });
    expect((await listInbox(employeeCtx(), { filter: "unread" })).rows[0]?.subject?.title).toBe(
      "Gated title",
    );

    // Strip the role and the very same row loses its subject — while
    // still telling the member that something happened.
    const seats = await f.platform.memberRole.findMany({
      where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId },
    });
    await f.platform.memberRole.deleteMany({
      where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId },
    });
    try {
      const [row] = (await listInbox(employeeCtx(), { filter: "unread" })).rows;
      expect(row?.kind).toBe("work_item.assigned");
      expect(row?.subject).toBeNull();
    } finally {
      await f.platform.memberRole.createMany({
        data: seats.map((r) => ({ tenantId: r.tenantId, memberId: r.memberId, roleId: r.roleId })),
        skipDuplicates: true,
      });
      await f.platform.memberClient.deleteMany({
        where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId },
      });
    }
  });

  it("a non-item notification points at its project", async () => {
    await give(f.seats.owner.memberId, {
      kind: "budget.threshold_reached",
      entityType: "ProjectBudget",
      entityId: randomUUID(),
    });
    const [row] = (await listInbox(ownerCtx(), { filter: "unread" })).rows;
    expect(row?.kind).toBe("budget.threshold_reached");
    expect(row?.subject).toEqual({
      title: "Inbox project",
      href: `/projects/${projectKey}/money`,
    });
  });

  it("a kind this build does not know still renders, as a null kind", async () => {
    await give(f.seats.owner.memberId, { kind: "some.future_kind" });
    const [row] = (await listInbox(ownerCtx(), { filter: "unread" })).rows;
    expect(row?.kind).toBeNull();
  });

  it("END TO END: assigning a task puts a resolvable row in the assignee's inbox", async () => {
    await scopeEmployeeToInboxClient();
    const item = await createItem(ownerCtx(), { projectId, title: "Please do this" });
    await assignItem(ownerCtx(), item.id, f.seats.employee.memberId);

    const rows = (await listInbox(employeeCtx(), { filter: "unread" })).rows;
    expect(rows.length).toBe(1);
    expect(rows[0]?.kind).toBe("work_item.assigned");
    expect(rows[0]?.subject?.title).toBe("Please do this");
    // The actor never notifies themself.
    expect(await countUnread(ownerCtx())).toBe(0);

    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.memberClient.deleteMany({
      where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId },
    });
  });
});
