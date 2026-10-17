import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";

import { readProjectLineup } from "./lineup";

/**
 * ALL PROJECTS ON ONE TIMELINE (slice 130, founder decision C107 (d)) against
 * the real schema and the real `app_runtime` role: who sees which projects
 * (`project:view` and the scope, a `MemberProject` seat never lifted to the
 * client's other projects), which projects are on it (planned, active and
 * paused; completed, cancelled and archived out), their days as stored, and
 * their milestones — not cancelled, in rank order, on their due day or the
 * day they were done.
 *
 * Tenant slugs come from `setupTenant("lineup")`; the prefix `lineup-` is
 * registered in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts).
 */

const run = randomUUID().slice(0, 8);
const LONG = 240_000;

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
const p: Record<string, string> = {};
const key: Record<string, string> = {};
/** `project:view`, reaching ACME only. */
let acmeSeat: { memberId: string; actor: MemberActor };
/** `project:view`, reaching the ACTIVE ACME project ONLY (a MemberProject row). */
let p1Seat: { memberId: string; actor: MemberActor };
/** `work_item:view` only — no `project:view`. */
let noProjects: { memberId: string; actor: MemberActor };
const extraUserIds: string[] = [];

const ctxOf = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const ZONE = { timeZone: "Europe/Stockholm" } as const;

async function seat(label: string, codes: string[], clientId?: string) {
  const userId = randomUUID();
  const email = `lineup-${label}-${run}@test.invalid`;
  await f.platform.user.create({ data: { id: userId, name: email, email } });
  extraUserIds.push(userId);
  const m = await f.platform.member.create({ data: { tenantId: f.tenantId, userId } });
  const role = await f.platform.role.create({ data: { tenantId: f.tenantId, name: `${label} ${run}` } });
  const perms = await f.platform.permission.findMany({ where: { code: { in: codes } } });
  expect(perms.map((x) => x.code).sort()).toEqual([...codes].sort());
  await f.platform.rolePermission.createMany({ data: perms.map((x) => ({ tenantId: f.tenantId, roleId: role.id, permissionId: x.id })) });
  await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: m.id, roleId: role.id } });
  if (clientId) await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: m.id, clientId } });
  return { memberId: m.id, actor: actorFor(m.id) };
}

beforeAll(async () => {
  f = await setupTenant("lineup");
  acme = randomUUID();
  beta = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  const up = run.slice(0, 3).toUpperCase();
  const projects = [
    // [name, client, status, start, launch, archived]
    ["active", acme, "ACTIVE", "2027-03-01", "2027-05-01", false],
    ["paused", acme, "PAUSED", "2027-02-01", "2027-06-01", false],
    ["planned", beta, "PLANNED", "2027-04-01", null, false],
    ["completed", acme, "COMPLETED", "2027-01-01", "2027-02-01", false],
    ["cancelled", acme, "CANCELLED", "2027-01-01", "2027-02-01", false],
    ["statusArchived", acme, "ARCHIVED", "2027-01-01", "2027-02-01", false],
    ["archivedAt", acme, "ACTIVE", "2027-01-01", "2027-02-01", true],
  ] as const;
  for (const [i, [name, clientId, status, start, launch, archived]] of projects.entries()) {
    p[name] = randomUUID();
    key[name] = `L${String.fromCharCode(65 + i)}${up}`;
    await f.platform.project.create({
      data: {
        id: p[name],
        tenantId: f.tenantId,
        clientId,
        key: key[name],
        name: `${name} ${run}`,
        status,
        startDate: day(start),
        launchDate: launch ? day(launch) : null,
        archivedAt: archived ? new Date() : null,
      },
    });
  }
  await f.platform.milestone.createMany({
    data: [
      {
        tenantId: f.tenantId,
        clientId: acme,
        projectId: p["active"]!,
        name: "Design",
        status: "DONE",
        dueAt: day("2027-03-15"),
        // Done late: drawn on its DUE day, not the day it was done.
        completedAt: new Date("2027-03-18T12:00:00Z"),
        rank: "a",
      },
      { tenantId: f.tenantId, clientId: acme, projectId: p["active"]!, name: "Build", status: "IN_PROGRESS", dueAt: day("2027-04-10"), rank: "b" },
      { tenantId: f.tenantId, clientId: acme, projectId: p["active"]!, name: "Dropped", status: "CANCELLED", dueAt: day("2027-04-12"), rank: "c" },
      {
        tenantId: f.tenantId,
        clientId: acme,
        projectId: p["active"]!,
        name: "Kickoff",
        status: "DONE",
        dueAt: null,
        // 23:30 UTC is 00:30 the NEXT day in Stockholm: the day is the reader's.
        completedAt: new Date("2027-03-02T23:30:00Z"),
        rank: "d",
      },
      { tenantId: f.tenantId, clientId: acme, projectId: p["active"]!, name: "Someday", status: "PLANNED", dueAt: null, rank: "e" },
    ],
  });
  acmeSeat = await seat("acme", ["project:view"], acme);
  p1Seat = await seat("p1", ["project:view"]);
  await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: p1Seat.memberId, projectId: p["active"]! } });
  noProjects = await seat("noproj", ["work_item:view"], acme);
}, LONG);

afterAll(async () => {
  if (!f?.tenantId) return;
  const db = f.platform;
  const tenantId = f.tenantId;
  await db.milestone.deleteMany({ where: { tenantId } });
  await db.memberProject.deleteMany({ where: { tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId } });
  await db.project.deleteMany({ where: { tenantId } });
  await db.client.deleteMany({ where: { tenantId } });
  await f.cleanup();
  await f.platform.user.deleteMany({ where: { id: { in: extraUserIds } } });
}, LONG);

describe("readProjectLineup", () => {
  it("lists the planned, active and paused projects — completed, cancelled and archived out — by start day", async () => {
    const r = await readProjectLineup(ctxOf(f.seats.owner.actor), ZONE);
    expect(r.truncated).toBe(false);
    expect(r.projects.map((x) => x.key)).toEqual([key["paused"], key["active"], key["planned"]]);
  }, LONG);

  it("hands over each project's days as stored, and its client", async () => {
    const r = await readProjectLineup(ctxOf(f.seats.owner.actor), ZONE);
    expect(r.projects.find((x) => x.key === key["active"])).toMatchObject({
      name: `active ${run}`,
      status: "ACTIVE",
      clientName: `Acme ${run}`,
      start: "2027-03-01",
      launch: "2027-05-01",
    });
    expect(r.projects.find((x) => x.key === key["planned"])).toMatchObject({ start: "2027-04-01", launch: null });
  }, LONG);

  it("carries the milestones not cancelled, in rank order, on their due day or the day they were done", async () => {
    const r = await readProjectLineup(ctxOf(f.seats.owner.actor), ZONE);
    const active = r.projects.find((x) => x.key === key["active"])!;
    expect(active.milestones.map(({ name, done, day: d }) => ({ name, done, day: d }))).toEqual([
      { name: "Design", done: true, day: "2027-03-15" },
      { name: "Build", done: false, day: "2027-04-10" },
      { name: "Kickoff", done: true, day: "2027-03-03" },
      { name: "Someday", done: false, day: null },
    ]);
  }, LONG);

  it("never lists a client the member does not reach", async () => {
    const r = await readProjectLineup(ctxOf(acmeSeat.actor), ZONE);
    expect(r.projects.map((x) => x.key)).toEqual([key["paused"], key["active"]]);
  }, LONG);

  it("never lists a SIBLING project to a member who reaches one project of a client (no lifted scope)", async () => {
    const r = await readProjectLineup(ctxOf(p1Seat.actor), ZONE);
    expect(r.projects.map((x) => x.key)).toEqual([key["active"]]);
  }, LONG);

  it("asks project:view", async () => {
    await expect(readProjectLineup(ctxOf(noProjects.actor), ZONE)).rejects.toBeInstanceOf(AuthzError);
  }, LONG);
});
