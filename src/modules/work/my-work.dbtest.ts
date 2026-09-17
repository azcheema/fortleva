import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dateColumn } from "@/lib/duration";
import { setupTenant } from "@/members/dbtest-fixture";
import { createRole, setRolePermissions } from "@/members/roles";

import {
  assignItem,
  changeState,
  createItem,
  deleteItem,
  listMyWork,
  setItemArchived,
  updateItemFields,
} from "./index";

/**
 * `/home`'s queue against the real database and the real `app_runtime`
 * role. The properties at stake:
 *
 *   1. ONLY the member's own OPEN, LIVE assignments — nothing done,
 *      cancelled, in triage, archived, deleted, in an archived project,
 *      or assigned to somebody else — soonest due first.
 *   2. SCOPE IS COMPOSED INTO THE READ: an assignment outlives access to
 *      its project, and a task the member can no longer open must leave
 *      the queue, title and all (the inbox's subject rule, one card over).
 *   3. No `work_item:view` — or no `project:view`, since a row names the
 *      project and links into it — is `null`, never a throw: `/home` is
 *      every member's landing page.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientA: string;
let clientB: string;
let projectA: string;
/** A second LIVE project of client A — the one a P1-only member must not reach. */
let projectA2: string;
let projectB: string;
let archivedProject: string;

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

beforeAll(async () => {
  f = await setupTenant("work-home");
  clientA = randomUUID();
  clientB = randomUUID();
  projectA = randomUUID();
  projectA2 = randomUUID();
  projectB = randomUUID();
  archivedProject = randomUUID();
  await f.platform.client.create({ data: { id: clientA, tenantId: f.tenantId, name: "Queue A" } });
  await f.platform.client.create({ data: { id: clientB, tenantId: f.tenantId, name: "Queue B" } });
  await f.platform.project.createMany({
    data: [
      { id: projectA, tenantId: f.tenantId, clientId: clientA, key: "MWA", name: "Queue project A" },
      { id: projectA2, tenantId: f.tenantId, clientId: clientA, key: "MWC", name: "Queue project A2" },
      { id: projectB, tenantId: f.tenantId, clientId: clientB, key: "MWB", name: "Queue project B" },
      { id: archivedProject, tenantId: f.tenantId, clientId: clientA, key: "MWZ", name: "Queue project gone" },
    ],
  });
}, 60_000);

afterAll(async () => {
  // A failed beforeAll leaves `f` unassigned, and Prisma drops an
  // undefined where-filter: every delete below would be unscoped.
  if (!f?.tenantId) return;
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
}, 60_000);

const stateOf = async (projectId: string, category: string) =>
  f.platform.workflowState.findFirstOrThrow({
    where: { tenantId: f.tenantId, projectId, category: category as never },
    orderBy: { rank: "asc" },
    select: { id: true },
  });

/** A task in `projectId`, assigned to `memberId`, with the given fields. */
const task = async (
  projectId: string,
  title: string,
  opts: {
    memberId?: string | null;
    due?: string;
    priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    category?: string;
  } = {},
): Promise<{ id: string; number: number }> => {
  const item = await createItem(ownerCtx(), { projectId, title });
  if (opts.due || opts.priority) {
    await updateItemFields(ownerCtx(), item.id, {
      ...(opts.due ? { targetDate: dateColumn(opts.due) } : {}),
      ...(opts.priority ? { priority: opts.priority } : {}),
    });
  }
  const memberId = opts.memberId === undefined ? f.seats.owner.memberId : opts.memberId;
  if (memberId) await assignItem(ownerCtx(), item.id, memberId);
  if (opts.category) await changeState(ownerCtx(), item.id, (await stateOf(projectId, opts.category)).id);
  return { id: item.id, number: item.number };
};

const titles = async (ctx: ReturnType<typeof ownerCtx>) => (await listMyWork(ctx))?.items.map((i) => i.title);

describe("listMyWork — what is in the queue", () => {
  it("only the member's own open, live assignments: soonest due, undated last, the louder priority first", async () => {
    await task(projectA, "due later, low", { due: "2026-09-20", priority: "LOW" });
    await task(projectA, "overdue", { due: "2026-09-10" });
    await task(projectA, "undated, urgent", { priority: "URGENT" });
    await task(projectA, "due later, high", { due: "2026-09-20", priority: "HIGH" });
    await task(projectA, "undated, in progress", { category: "IN_PROGRESS" });
    await task(projectB, "other client, backlog", { category: "BACKLOG" });

    // Every one of these is assigned to the owner or near enough to be
    // mistaken for it, and none belongs in the queue.
    await task(projectA, "the employee's", { memberId: f.seats.employee.memberId });
    await task(projectA, "nobody's", { memberId: null });
    await task(projectA, "done", { category: "DONE" });
    await task(projectA, "cancelled", { category: "CANCELLED" });
    const archived = await task(projectA, "archived");
    await setItemArchived(ownerCtx(), archived.id, true);
    const deleted = await task(projectA, "deleted");
    await deleteItem(ownerCtx(), deleted.id);
    await task(archivedProject, "archived project's");
    await f.platform.project.update({
      where: { id: archivedProject },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });
    // TRIAGE: no 2W verb puts a task there (the portal's), so the row is
    // written as the triage writer will — the state and its status together.
    const triaged = await task(projectA, "in triage");
    await f.platform.workItem.update({
      where: { id: triaged.id },
      data: { stateId: (await stateOf(projectA, "TRIAGE")).id, triageStatus: "PENDING" },
      select: { id: true },
    });
    expect(
      (await f.platform.workItem.findUniqueOrThrow({ where: { id: triaged.id }, select: { stateCategory: true } }))
        .stateCategory,
    ).toBe("TRIAGE");

    const queue = await listMyWork(ownerCtx());
    expect(queue?.truncated).toBe(false);
    // The undated tail: URGENT before NONE, then project key (MWA < MWB).
    expect(queue?.items.map((i) => i.title)).toEqual([
      "overdue",
      "due later, high",
      "due later, low",
      "undated, urgent",
      "undated, in progress",
      "other client, backlog",
    ]);
    const overdue = queue!.items[0]!;
    expect(overdue).toMatchObject({ projectKey: "MWA", projectName: "Queue project A", stateCategory: "TODO" });
    expect(overdue.targetDate?.toISOString().slice(0, 10)).toBe("2026-09-10");
    // RAW state pair, as every work read hands it to a page: a seeded
    // state has no stored name, only its key.
    expect(overdue.stateName).toBeNull();
    expect(overdue.stateSeedKey).not.toBeNull();

    // The employee holds exactly one task, but no scope on this client
    // yet — so even their own assignment is not theirs to see.
    expect(await titles(employeeCtx())).toEqual([]);
  }, 240_000); // fourteen service transactions to the database before the first read

  it("truncates at the limit and says so — and only when there is more", async () => {
    const all = (await listMyWork(ownerCtx()))!.items;
    expect(all.length).toBeGreaterThan(2);
    const capped = await listMyWork(ownerCtx(), { limit: 2 });
    expect(capped?.items.map((i) => i.id)).toEqual(all.slice(0, 2).map((i) => i.id));
    expect(capped?.truncated).toBe(true);
    expect((await listMyWork(ownerCtx(), { limit: all.length }))?.truncated).toBe(false);
  });
});

describe("listMyWork — scope and the gate", () => {
  it("SCOPE IS COMPOSED INTO THE READ: a task the member lost access to leaves their queue, and comes back with it", async () => {
    const inA = await task(projectA, "employee, client A", { memberId: f.seats.employee.memberId, due: "2026-09-01" });
    await task(projectA2, "employee, client A's other project", { memberId: f.seats.employee.memberId });
    await task(projectB, "employee, client B", { memberId: f.seats.employee.memberId });

    // A client assignment: every project of client A, never client B's —
    // even though client B's task is assigned to them.
    await f.platform.memberClient.create({
      data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: clientA },
    });
    const withClient = await listMyWork(employeeCtx());
    expect(withClient?.items.map((i) => i.title)).toEqual([
      "employee, client A",
      "the employee's",
      "employee, client A's other project",
    ]);
    expect(withClient?.items[0]?.id).toBe(inA.id);

    // Unassigned from the client: the queue empties — an answer, not an error.
    await f.platform.memberClient.deleteMany({
      where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId },
    });
    expect(await titles(employeeCtx())).toEqual([]);

    // A PROJECT assignment reaches that project's tasks ONLY: not client
    // B's, and — the lift AUTHZ.md §4 forbids for content — not the task
    // in client A's OTHER project either.
    await f.platform.memberProject.create({
      data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: projectA },
    });
    try {
      expect(await titles(employeeCtx())).toEqual(["employee, client A", "the employee's"]);
    } finally {
      await f.platform.memberProject.deleteMany({
        where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId },
      });
    }
  }, 120_000);

  it("THE GATE IS BOTH CODES, AND A MISSING ONE IS null, NOT A THROW — /home draws no queue", async () => {
    // Fresh members on custom roles holding exactly the codes named, so
    // the GATE decides: the fixture's seats hold both codes and dozens
    // more, and cannot tell a read gated on the right code from one gated
    // on another (the slice-22 review's lesson).
    const asRole = async (name: string, codes: string[], check: (ctx: ReturnType<typeof ownerCtx>) => Promise<void>) => {
      const { roleId } = await createRole({ tenantId: f.tenantId, actor: f.seats.owner.actor, name });
      const userId = randomUUID();
      let memberId: string | null = null;
      try {
        await setRolePermissions({ tenantId: f.tenantId, actor: f.seats.owner.actor, roleId, codes });
        await f.platform.user.create({ data: { id: userId, name, email: `${randomUUID().slice(0, 8)}@test.invalid` } });
        memberId = (await f.platform.member.create({ data: { tenantId: f.tenantId, userId } })).id;
        await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId, roleId } });
        await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId, clientId: clientA } });
        await check({ tenantId: f.tenantId, actor: { memberId, mfa: { enrolled: false, verifiedAt: null } } });
      } finally {
        if (memberId) await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId, memberId } });
        if (memberId) await f.platform.memberRole.deleteMany({ where: { tenantId: f.tenantId, memberId } });
        if (memberId) await f.platform.member.delete({ where: { id: memberId } });
        await f.platform.user.deleteMany({ where: { id: userId } });
        await f.platform.rolePermission.deleteMany({ where: { tenantId: f.tenantId, roleId } });
        await f.platform.role.delete({ where: { id: roleId } });
      }
    };
    await asRole("Queue: work only", ["work_item:view"], async (ctx) => {
      expect(await listMyWork(ctx)).toBeNull();
    });
    await asRole("Queue: project only", ["project:view"], async (ctx) => {
      expect(await listMyWork(ctx)).toBeNull();
    });
    // Both codes and nothing assigned: an EMPTY queue, not a null one.
    await asRole("Queue: both", ["work_item:view", "project:view"], async (ctx) => {
      expect(await listMyWork(ctx)).toEqual({ items: [], truncated: false });
    });
  }, 120_000);
});
