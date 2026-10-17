import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { withTenant } from "@/db";
import { dateColumn } from "@/lib/duration";
import { dueBounds, type TaskPersonFilter } from "@/lib/task-list-plan";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";

import { assignItem, assignItemToContact, createItem, deleteItem, listAllTasks, setItemArchived } from "./index";
import { createRequest } from "./requests";

/**
 * EVERY TASK IN ONE LIST (slice 130, founder decision C107) against the real
 * schema and the real `app_runtime` role: who sees what (scope composed into
 * the query, the two codes, a `MemberProject` seat never lifted to the
 * client's other projects), what is on it (open tasks and their subtasks;
 * Done, Cancelled, Triage, archived, deleted and an archived project's out),
 * the order (due day, undated last), each filter (overdue, this week, nobody,
 * me, a member, a project), and the person picker — whose names come only
 * from tasks in scope, so a member id or a project key from outside it is no
 * filter, never an error that could say it exists.
 *
 * Tenant slugs come from `setupTenant("tasks")`; the prefix `tasks-` is
 * registered in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts).
 */

const run = randomUUID().slice(0, 8);
const LONG = 240_000;

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
let pA: string;
let pB: string;
/** A SIBLING of pA under the same client — what a member reaching pA alone must never see. */
let pA2: string;
let keyA: string;
let keyB: string;
let keyA2: string;
let carol: string;
/** `work_item:view` + `project:view`, reaching ACME only. */
let acmeSeat: { memberId: string; actor: MemberActor };
/** Reaches Beta only; holds a Beta task — a name ACME's seat must never be offered. */
let betaSeat: { memberId: string; actor: MemberActor };
/** `work_item:view` + `project:view`, reaching pA ONLY (a MemberProject row). */
let p1Seat: { memberId: string; actor: MemberActor };
/** Reaches the SIBLING project only and holds its task — a name the pA-only seat must never be offered (the security review's NIT). */
let siblingSeat: { memberId: string; actor: MemberActor };
/** `work_item:view` only — no `project:view`. */
let noProjects: { memberId: string; actor: MemberActor };
const extraUserIds: string[] = [];

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const ctxOf = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });

/** Wednesday 10 March 2027; its Monday week is 8–14 March. */
const TODAY = "2027-03-10";
const read = (
  actor: MemberActor,
  over: { projectKey?: string | null; person?: TaskPersonFilter | null; due?: "overdue" | "week" | null } = {},
) =>
  listAllTasks(ctxOf(actor), {
    projectKey: over.projectKey ?? null,
    person: over.person ?? null,
    due: over.due ? dueBounds(over.due, TODAY, "MONDAY") : null,
  });

async function task(projectId: string, title: string, due: string | null, parentId?: string): Promise<string> {
  const { id } = await createItem(ownerCtx(), { projectId, title: `${title} ${run}`, ...(parentId ? { parentId } : {}) });
  if (due) await f.platform.workItem.update({ where: { id }, data: { targetDate: dateColumn(due) } });
  return id;
}

async function seat(label: string, codes: string[], clientId?: string) {
  const userId = randomUUID();
  const email = `tasks-${label}-${run}@test.invalid`;
  await f.platform.user.create({ data: { id: userId, name: `${label} ${run}`, email } });
  extraUserIds.push(userId);
  const m = await f.platform.member.create({ data: { tenantId: f.tenantId, userId } });
  const role = await f.platform.role.create({ data: { tenantId: f.tenantId, name: `${label} ${run}` } });
  const perms = await f.platform.permission.findMany({ where: { code: { in: codes } } });
  expect(perms.map((p) => p.code).sort()).toEqual([...codes].sort());
  await f.platform.rolePermission.createMany({ data: perms.map((p) => ({ tenantId: f.tenantId, roleId: role.id, permissionId: p.id })) });
  await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: m.id, roleId: role.id } });
  if (clientId) await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: m.id, clientId } });
  return { memberId: m.id, actor: actorFor(m.id) };
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  f = await setupTenant("tasks");
  acme = randomUUID();
  beta = randomUUID();
  pA = randomUUID();
  pB = randomUUID();
  pA2 = randomUUID();
  carol = randomUUID();
  const up = run.slice(0, 3).toUpperCase();
  keyA = `TLA${up}`;
  keyB = `TLB${up}`;
  keyA2 = `TLC${up}`;
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: pA, tenantId: f.tenantId, clientId: acme, key: keyA, name: `Acme site ${run}`, portalEnabled: true },
      { id: pB, tenantId: f.tenantId, clientId: beta, key: keyB, name: `Beta site ${run}` },
      { id: pA2, tenantId: f.tenantId, clientId: acme, key: keyA2, name: `Acme shop ${run}` },
    ],
  });
  await f.platform.contact.create({
    data: {
      id: carol,
      tenantId: f.tenantId,
      clientId: acme,
      name: `Carol ${run}`,
      email: `tasks-carol-${run}@test.invalid`,
      portalProfile: "CONTACT_PRIMARY",
      portalStatus: "ACTIVE",
      invitedAt: new Date("2026-09-01T09:00:00Z"),
      emailVerified: true,
    },
  });
  // Every seat that holds a task needs `work_item:view` — `assignItem` refuses
  // anyone who could not open it.
  acmeSeat = await seat("acme", ["work_item:view", "project:view"], acme);
  betaSeat = await seat("beta", ["work_item:view", "project:view"], beta);
  noProjects = await seat("noproj", ["work_item:view"], acme);
  p1Seat = await seat("p1", ["work_item:view", "project:view"]);
  siblingSeat = await seat("sibling", ["work_item:view", "project:view"]);
  await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: p1Seat.memberId, projectId: pA } });
  await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: siblingSeat.memberId, projectId: pA2 } });

  ids["overdue"] = await task(pA, "Overdue", "2027-03-05");
  await assignItem(ownerCtx(), ids["overdue"], acmeSeat.memberId);
  ids["monday"] = await task(pA, "Monday this week", "2027-03-08");
  ids["friday"] = await task(pA, "Friday this week", "2027-03-12");
  await assignItem(ownerCtx(), ids["friday"], f.seats.owner.memberId);
  ids["subtask"] = await task(pA, "Its subtask", null, ids["friday"]);
  await assignItem(ownerCtx(), ids["subtask"], acmeSeat.memberId);
  ids["april"] = await task(pA, "Next month", "2027-04-02");
  ids["undated"] = await task(pA, "Undated", null);
  ids["carol"] = await task(pA, "With Carol", "2027-03-20");
  await assignItemToContact(ownerCtx(), ids["carol"], carol);

  ids["done"] = await task(pA, "Done", "2027-03-09");
  const doneState = await f.platform.workflowState.findFirstOrThrow({ where: { tenantId: f.tenantId, projectId: pA, category: "DONE" } });
  await f.platform.workItem.update({ where: { id: ids["done"] }, data: { stateId: doneState.id } });
  ids["cancelled"] = await task(pA, "Cancelled", "2027-03-09");
  const cancelled = await f.platform.workflowState.findFirstOrThrow({ where: { tenantId: f.tenantId, projectId: pA, category: "CANCELLED" } });
  await f.platform.workItem.update({ where: { id: ids["cancelled"] }, data: { stateId: cancelled.id } });
  ids["archived"] = await task(pA, "Archived", "2027-03-09");
  await setItemArchived(ownerCtx(), ids["archived"], true);
  ids["deleted"] = await task(pA, "Deleted", "2027-03-09");
  await deleteItem(ownerCtx(), ids["deleted"]);
  const req = await withTenant(f.tenantId, { type: "system" }, (tx) =>
    createRequest(tx, f.tenantId, { projectId: pA, title: `Asked ${run}`, body: null, reportedByContactId: carol }),
  );
  ids["request"] = req.id;

  ids["beta"] = await task(pB, "Beta's", "2027-03-09");
  await assignItem(ownerCtx(), ids["beta"], betaSeat.memberId);
  ids["sibling"] = await task(pA2, "Sibling's", "2027-03-11");
  await assignItem(ownerCtx(), ids["sibling"], siblingSeat.memberId);
  // Due the same day as "Friday this week", but URGENT: the order's tie-break.
  ids["urgent"] = await task(pA, "Urgent on Friday", "2027-03-12");
  await f.platform.workItem.update({ where: { id: ids["urgent"] }, data: { priority: "URGENT" } });
}, LONG);

afterAll(async () => {
  if (!f?.tenantId) return;
  const db = f.platform;
  const tenantId = f.tenantId;
  await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId}`;
  await db.notification.deleteMany({ where: { tenantId } });
  await db.emailOutbox.deleteMany({ where: { tenantId } });
  await db.comment.deleteMany({ where: { tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId } });
  await db.workItem.deleteMany({ where: { tenantId, depth: 2 } });
  await db.workItem.deleteMany({ where: { tenantId, depth: 1 } });
  await db.workItem.deleteMany({ where: { tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId } });
  await db.memberProject.deleteMany({ where: { tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId } });
  await db.contact.deleteMany({ where: { tenantId } });
  await db.project.deleteMany({ where: { tenantId } });
  await db.client.deleteMany({ where: { tenantId } });
  await db.tenantPreference.deleteMany({ where: { tenantId } });
  await f.cleanup();
  await f.platform.user.deleteMany({ where: { id: { in: extraUserIds } } });
}, LONG);

const strip = (title: string) => title.replace(` ${run}`, "");
const titles = (r: Awaited<ReturnType<typeof read>>) => (r?.entries ?? []).map((e) => strip(e.title));
const sorted = (r: Awaited<ReturnType<typeof read>>) => titles(r).sort();

const OPEN_FOR_OWNER = [
  "Beta's",
  "Friday this week",
  "Its subtask",
  "Monday this week",
  "Next month",
  "Overdue",
  "Sibling's",
  "Undated",
  "Urgent on Friday",
  "With Carol",
];

describe("listAllTasks — what is on it", () => {
  it("lists every OPEN task in scope, subtasks included — Done, Cancelled, Triage, archived and deleted out", async () => {
    const r = await read(f.seats.owner.actor);
    expect(sorted(r)).toEqual([...OPEN_FOR_OWNER].sort());
    expect(r).toMatchObject({ truncated: false, projectKey: null, person: null });
    expect(r!.projects.map((p) => p.key).sort()).toEqual([keyA, keyA2, keyB].sort());
  }, LONG);

  it("orders by due day with the undated last, the louder priority first on one day", async () => {
    const r = await read(f.seats.owner.actor);
    const t = titles(r);
    expect(t.slice(0, 8)).toEqual([
      "Overdue",
      "Monday this week",
      "Beta's",
      "Sibling's",
      "Urgent on Friday",
      "Friday this week",
      "With Carol",
      "Next month",
    ]);
    expect(t.slice(8).sort()).toEqual(["Its subtask", "Undated"]);
    expect(r!.entries.find((e) => strip(e.title) === "Overdue")).toMatchObject({ projectKey: keyA, dueOn: "2027-03-05" });
    expect(r!.entries.find((e) => strip(e.title) === "Undated")!.dueOn).toBeNull();
  }, LONG);

  it("names who holds each task — a member, a client's contact, or nobody", async () => {
    const r = await read(f.seats.owner.actor);
    const by = (title: string) => r!.entries.find((e) => strip(e.title) === title)!.assignee;
    expect(by("Overdue")).toEqual({ kind: "member", id: acmeSeat.memberId, name: `acme ${run}` });
    expect(by("With Carol")).toEqual({ kind: "contact", id: carol, name: `Carol ${run}` });
    expect(by("Monday this week")).toEqual({ kind: "none" });
  }, LONG);

  it("asks work_item:view AND project:view", async () => {
    expect(await read(noProjects.actor)).toBeNull();
  }, LONG);
});

describe("listAllTasks — the filters", () => {
  it("OVERDUE is before today; DUE THIS WEEK is the whole week, its passed days in", async () => {
    expect(sorted(await read(f.seats.owner.actor, { due: "overdue" }))).toEqual(["Beta's", "Monday this week", "Overdue"]);
    expect(sorted(await read(f.seats.owner.actor, { due: "week" }))).toEqual(
      ["Beta's", "Friday this week", "Monday this week", "Sibling's", "Urgent on Friday"].sort(),
    );
  }, LONG);

  it("NOBODY means no member and no contact; ME is the reader; a member is that member", async () => {
    expect(sorted(await read(f.seats.owner.actor, { person: { kind: "none" } }))).toEqual(
      ["Monday this week", "Next month", "Undated", "Urgent on Friday"].sort(),
    );
    expect(titles(await read(f.seats.owner.actor, { person: { kind: "me" } }))).toEqual(["Friday this week"]);
    const r = await read(f.seats.owner.actor, { person: { kind: "member", id: acmeSeat.memberId } });
    expect(r!.person).toEqual({ kind: "member", id: acmeSeat.memberId });
    expect(sorted(r)).toEqual(["Its subtask", "Overdue"]);
  }, LONG);

  it("narrows to one project, and combines filters", async () => {
    const onlyB = await read(f.seats.owner.actor, { projectKey: keyB });
    expect(onlyB!.projectKey).toBe(keyB);
    expect(titles(onlyB)).toEqual(["Beta's"]);
    expect(sorted(await read(f.seats.owner.actor, { projectKey: keyA, due: "week", person: { kind: "none" } }))).toEqual([
      "Monday this week",
      "Urgent on Friday",
    ]);
  }, LONG);

  it("offers the members assigned to open tasks in scope — and nobody else", async () => {
    const owner = await read(f.seats.owner.actor);
    expect(owner!.people.map((p) => p.id).sort()).toEqual(
      [acmeSeat.memberId, betaSeat.memberId, siblingSeat.memberId, f.seats.owner.memberId].sort(),
    );
    const acmeView = await read(acmeSeat.actor);
    // The Beta seat holds a task only in Beta: ACME's member is never offered their name.
    expect(acmeView!.people.map((p) => p.id).sort()).toEqual([acmeSeat.memberId, siblingSeat.memberId, f.seats.owner.memberId].sort());
    // The pA-only seat is never offered the SIBLING project's person, nor can it filter by them.
    const p1View = await read(p1Seat.actor);
    expect(p1View!.people.map((p) => p.id)).not.toContain(siblingSeat.memberId);
    const asked = await read(p1Seat.actor, { person: { kind: "member", id: siblingSeat.memberId } });
    expect(asked!.person).toBeNull();
    expect(sorted(asked)).toEqual(sorted(p1View));
  }, LONG);
});

describe("listAllTasks — scope", () => {
  it("never lists a project the member does not reach, nor takes it as a filter", async () => {
    const r = await read(acmeSeat.actor);
    expect(titles(r)).not.toContain("Beta's");
    expect(r!.projects.map((p) => p.key).sort()).toEqual([keyA, keyA2].sort());
    const asked = await read(acmeSeat.actor, { projectKey: keyB });
    expect(asked!.projectKey).toBeNull();
    expect(sorted(asked)).toEqual(sorted(r));
  }, LONG);

  it("a member id from outside the scope is no filter, and says nothing", async () => {
    const plain = await read(acmeSeat.actor);
    const asked = await read(acmeSeat.actor, { person: { kind: "member", id: betaSeat.memberId } });
    expect(asked!.person).toBeNull();
    expect(sorted(asked)).toEqual(sorted(plain));
    // Nor an id that is nobody at all.
    const stray = await read(acmeSeat.actor, { person: { kind: "member", id: randomUUID() } });
    expect(stray!.person).toBeNull();
    expect(sorted(stray)).toEqual(sorted(plain));
  }, LONG);

  it("never lists a SIBLING project to a member who reaches one project of a client (no lifted scope)", async () => {
    const r = await read(p1Seat.actor);
    expect(r!.projects.map((p) => p.key)).toEqual([keyA]);
    expect(r!.entries.every((e) => e.projectKey === keyA)).toBe(true);
    expect(titles(r)).not.toContain("Sibling's");
    const asked = await read(p1Seat.actor, { projectKey: keyA2 });
    expect(asked!.projectKey).toBeNull();
    expect(titles(asked)).not.toContain("Sibling's");
  }, LONG);

  it("leaves out an archived project's tasks, and the project", async () => {
    await f.platform.project.update({ where: { id: pA2 }, data: { archivedAt: new Date() } });
    try {
      const r = await read(f.seats.owner.actor);
      expect(titles(r)).not.toContain("Sibling's");
      expect(r!.projects.map((p) => p.key)).not.toContain(keyA2);
    } finally {
      await f.platform.project.update({ where: { id: pA2 }, data: { archivedAt: null } });
    }
  }, LONG);
});
