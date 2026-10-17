import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { withTenant } from "@/db";
import { dateColumn } from "@/lib/duration";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";

import { assignItem, createItem, deleteItem, readCalendar, setItemArchived, setItemRepeat } from "./index";
import { createRequest } from "./requests";

/**
 * THE CALENDAR OF TASKS (slice 128, founder decision C105) against the real
 * schema and the real `app_runtime` role: who sees what (scope composed into
 * the query, the two codes), what is on it (the range, Done in, Cancelled /
 * Triage / archived / deleted out), "Only mine", the project filter (a key out
 * of scope is no filter), and the copies repeating tasks will make — under the
 * same scope and filters, none from a deleted newest task or a paused project.
 *
 * Tenant slugs come from `setupTenant("cal")`; the prefix `cal-` is registered
 * in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts).
 */

const run = randomUUID().slice(0, 8);
const LONG = 240_000;

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
let pA: string;
let pB: string;
/** A SIBLING of pA under the same client — what a member reaching pA alone must never see (AUTHZ §4: P2 stays invisible to a P1-only member). */
let pA2: string;
let keyA: string;
let keyB: string;
let keyA2: string;
/** `work_item:view` + `project:view`, reaching pA ONLY (a MemberProject row) — the security review's NIT-1. */
let p1Seat: { memberId: string; actor: MemberActor };
let carol: string;
/** `work_item:view` + `project:view`, reaching ACME only. */
let acmeSeat: { memberId: string; actor: MemberActor };
/** `work_item:view` only — no `project:view`. */
let noProjects: { memberId: string; actor: MemberActor };
const extraUserIds: string[] = [];

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const ctxOf = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });

/** March 2027, read on 20 February. */
const RANGE = { from: "2027-03-01", to: "2027-03-31", today: "2027-02-20" } as const;
const read = (actor: MemberActor, over: { projectKey?: string | null; mine?: boolean } = {}) =>
  readCalendar(ctxOf(actor), { ...RANGE, projectKey: over.projectKey ?? null, mine: over.mine ?? false });

async function task(projectId: string, title: string, due: string | null): Promise<string> {
  const { id } = await createItem(ownerCtx(), { projectId, title: `${title} ${run}` });
  if (due) await f.platform.workItem.update({ where: { id }, data: { targetDate: dateColumn(due) } });
  return id;
}

async function seat(label: string, codes: string[], clientId?: string) {
  const userId = randomUUID();
  const email = `cal-${label}-${run}@test.invalid`;
  await f.platform.user.create({ data: { id: userId, name: email, email } });
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
  f = await setupTenant("cal");
  acme = randomUUID();
  beta = randomUUID();
  pA = randomUUID();
  pB = randomUUID();
  pA2 = randomUUID();
  carol = randomUUID();
  const up = run.slice(0, 3).toUpperCase();
  keyA = `CLA${up}`;
  keyB = `CLB${up}`;
  keyA2 = `CLC${up}`;
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
      name: "Carol",
      email: `cal-carol-${run}@test.invalid`,
      portalProfile: "CONTACT_PRIMARY",
      portalStatus: "ACTIVE",
      invitedAt: new Date("2026-09-01T09:00:00Z"),
      emailVerified: true,
    },
  });
  acmeSeat = await seat("acme", ["work_item:view", "project:view"], acme);
  noProjects = await seat("noproj", ["work_item:view"], acme);
  p1Seat = await seat("p1", ["work_item:view", "project:view"]);
  await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: p1Seat.memberId, projectId: pA } });

  ids["open"] = await task(pA, "Open in March", "2027-03-10");
  ids["done"] = await task(pA, "Done in March", "2027-03-11");
  const doneState = await f.platform.workflowState.findFirstOrThrow({ where: { tenantId: f.tenantId, projectId: pA, category: "DONE" } });
  await f.platform.workItem.update({ where: { id: ids["done"] }, data: { stateId: doneState.id } });
  ids["cancelled"] = await task(pA, "Cancelled in March", "2027-03-12");
  const cancelled = await f.platform.workflowState.findFirstOrThrow({ where: { tenantId: f.tenantId, projectId: pA, category: "CANCELLED" } });
  await f.platform.workItem.update({ where: { id: ids["cancelled"] }, data: { stateId: cancelled.id } });
  ids["archived"] = await task(pA, "Archived in March", "2027-03-13");
  await setItemArchived(ownerCtx(), ids["archived"], true);
  ids["deleted"] = await task(pA, "Deleted in March", "2027-03-14");
  await deleteItem(ownerCtx(), ids["deleted"]);
  ids["april"] = await task(pA, "Due in April", "2027-04-01");
  ids["edgeFrom"] = await task(pA, "On the first", "2027-03-01");
  ids["edgeTo"] = await task(pA, "On the last", "2027-03-31");
  ids["undated"] = await task(pA, "No due date", null);
  ids["mine"] = await task(pA, "The employee's", "2027-03-15");
  await assignItem(ownerCtx(), ids["mine"], acmeSeat.memberId);
  ids["beta"] = await task(pB, "Beta's in March", "2027-03-10");
  ids["sibling"] = await task(pA2, "Sibling's in March", "2027-03-09");
  const req = await withTenant(f.tenantId, { type: "system" }, (tx) =>
    createRequest(tx, f.tenantId, { projectId: pA, title: `Asked ${run}`, body: null, reportedByContactId: carol }),
  );
  await f.platform.workItem.update({ where: { id: req.id }, data: { targetDate: dateColumn("2027-03-16") } });
  ids["request"] = req.id;

  // A weekly series in each project, next copy Mon 1 March 2027.
  for (const [projectId, name] of [
    [pA, "seriesA"],
    [pB, "seriesB"],
    [pA2, "seriesA2"],
  ] as const) {
    const holder = await task(projectId, `Weekly ${name}`, "2027-02-28");
    ids[name] = holder;
    await setItemRepeat(ownerCtx(), holder, { rhythm: "WEEKLY" }, new Date("2027-02-20T10:00:00Z"));
    const s = await f.platform.workItemRepeat.findFirstOrThrow({ where: { tenantId: f.tenantId, workItemId: holder } });
    await f.platform.workItemRepeat.update({ where: { id: s.id }, data: { nextOn: dateColumn("2027-03-01"), anchorDay: null } });
  }
  await assignItem(ownerCtx(), ids["seriesA"]!, acmeSeat.memberId);
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

const titles = (r: Awaited<ReturnType<typeof read>>) => (r?.entries ?? []).map((e) => e.title.replace(` ${run}`, "")).sort();

describe("readCalendar — what is on it", () => {
  it("draws every task due in the range across the projects in scope — Done in; Cancelled, Triage, archived, deleted, undated and out-of-range out", async () => {
    const r = await read(f.seats.owner.actor);
    expect(titles(r)).toEqual(
      ["Beta's in March", "Done in March", "On the first", "On the last", "Open in March", "Sibling's in March", "The employee's"].sort(),
    );
    expect(r!.entries.find((e) => e.title.startsWith("Done"))?.stateCategory).toBe("DONE");
    expect(r!.entries.find((e) => e.title.startsWith("Open"))).toMatchObject({ projectKey: keyA, dueOn: "2027-03-10", repeatRhythm: null });
    expect(r).toMatchObject({ truncated: false, canEdit: true, projectKey: null });
    expect(r!.projects.map((p) => p.key).sort()).toEqual([keyA, keyA2, keyB].sort());
  }, LONG);

  it("never draws a project the member does not reach, nor its repeat copies", async () => {
    const r = await read(acmeSeat.actor);
    expect(titles(r)).not.toContain("Beta's in March");
    expect(r!.projects.map((p) => p.key).sort()).toEqual([keyA, keyA2].sort());
    expect(new Set(r!.copies.map((c) => c.projectKey))).toEqual(new Set([keyA, keyA2]));
    expect(r!.canEdit).toBe(false);
    // A key out of scope is no filter — never an error that would say it exists.
    const filtered = await read(acmeSeat.actor, { projectKey: keyB });
    expect(filtered!.projectKey).toBeNull();
    expect(titles(filtered)).toEqual(titles(r));
  }, LONG);

  it("narrows to one project, and to the member's own", async () => {
    const onlyB = await read(f.seats.owner.actor, { projectKey: keyB });
    expect(onlyB!.projectKey).toBe(keyB);
    expect(titles(onlyB)).toEqual(["Beta's in March"]);
    expect(new Set(onlyB!.copies.map((c) => c.projectKey))).toEqual(new Set([keyB]));
    const mine = await read(acmeSeat.actor, { mine: true });
    expect(titles(mine)).toEqual(["The employee's"]);
    // The series whose newest task is theirs: its copies go to them.
    expect(new Set(mine!.copies.map((c) => c.holderNumber))).toEqual(
      new Set([(await f.platform.workItem.findUniqueOrThrow({ where: { id: ids["seriesA"]! } })).number]),
    );
  }, LONG);

  it("asks work_item:view AND project:view", async () => {
    expect(await read(noProjects.actor)).toBeNull();
  }, LONG);

  it("never draws a SIBLING project to a member who reaches one project of a client (no lifted scope)", async () => {
    const r = await read(p1Seat.actor);
    expect(r!.projects.map((p) => p.key)).toEqual([keyA]);
    expect(titles(r)).not.toContain("Sibling's in March");
    expect(r!.entries.every((e) => e.projectKey === keyA)).toBe(true);
    expect(r!.copies.every((c) => c.projectKey === keyA)).toBe(true);
    const asked = await read(p1Seat.actor, { projectKey: keyA2 });
    expect(asked!.projectKey).toBeNull();
    expect(titles(asked)).not.toContain("Sibling's in March");
  }, LONG);

  it("leaves out an archived project's tasks", async () => {
    await f.platform.project.update({ where: { id: pA2 }, data: { archivedAt: new Date() } });
    try {
      const r = await read(f.seats.owner.actor);
      expect(titles(r)).not.toContain("Sibling's in March");
      expect(r!.projects.map((p) => p.key)).not.toContain(keyA2);
      expect(r!.copies.some((c) => c.projectKey === keyA2)).toBe(false);
    } finally {
      await f.platform.project.update({ where: { id: pA2 }, data: { archivedAt: null } });
    }
  }, LONG);

  it("draws no copies past the projection horizon, and says so (both reviews' LOW)", async () => {
    const far = await readCalendar(ownerCtx(), { from: "2031-01-01", to: "2031-01-31", today: RANGE.today, projectKey: null, mine: false });
    expect(far!.copies).toEqual([]);
    expect(far!.copiesBeyondHorizon).toBe(true);
    expect((await read(f.seats.owner.actor))!.copiesBeyondHorizon).toBe(false);
  }, LONG);
});

describe("readCalendar — the copies repeating tasks will make (C105 (c))", () => {
  it("draws each future copy on its due day, marked by its series' newest task", async () => {
    const r = await read(f.seats.owner.actor, { projectKey: keyA });
    // Weekly from Mon 1 March: due the Sundays 7, 14, 21, 28 March.
    expect(r!.copies.map((c) => [c.appearsOn, c.dueOn])).toEqual([
      ["2027-03-01", "2027-03-07"],
      ["2027-03-08", "2027-03-14"],
      ["2027-03-15", "2027-03-21"],
      ["2027-03-22", "2027-03-28"],
    ]);
    expect(r!.copies[0]).toMatchObject({ rhythm: "WEEKLY", title: `Weekly seriesA ${run}`, projectKey: keyA });
  }, LONG);

  it("draws none for a series whose newest task is deleted, or in a paused project", async () => {
    await f.platform.project.update({ where: { id: pB }, data: { status: "PAUSED" } });
    try {
      expect((await read(f.seats.owner.actor, { projectKey: keyB }))!.copies).toEqual([]);
    } finally {
      await f.platform.project.update({ where: { id: pB }, data: { status: "ACTIVE" } });
    }
    const { deletedAt } = await deleteItem(ownerCtx(), ids["seriesA"]!);
    expect(deletedAt).toBeTruthy();
    expect((await read(f.seats.owner.actor, { projectKey: keyA }))!.copies).toEqual([]);
  }, LONG);

  it("marks the task that holds a repeat", async () => {
    const r = await readCalendar(ownerCtx(), { from: "2027-02-28", to: "2027-02-28", today: RANGE.today, projectKey: keyB, mine: false });
    expect(r!.entries).toEqual([expect.objectContaining({ title: `Weekly seriesB ${run}`, repeatRhythm: "WEEKLY" })]);
  }, LONG);
});
