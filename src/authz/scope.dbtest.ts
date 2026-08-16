import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest setup/cleanup uses the raw layer */
import { getPlatformClient } from "@/db/client";
import { withTenant } from "@/db";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import {
  assignMemberToClient,
  assignMemberToProject,
  unassignMemberFromClient,
  unassignMemberFromProject,
} from "@/clients/assignments";

import { assertInScope, authorizedResourceIds, scopeWhere, type MemberActor } from "./authorize";

/**
 * Client ↔ client scoping against the real DB as app_runtime (AUTHZ.md
 * §4 deny-matrix, PLAN.md Phase 2 non-negotiable tests):
 *   Acme {P1, P2}, Beta {P3}, Gamma {P4}
 *   E1 = MemberProject(P1) · M1 = MemberClient(Acme, Beta) · E2 = nothing
 *   owner = client:view_all
 * plus the assignment services (audited, scope-checked, idempotent).
 */

const platform = () => getPlatformClient();
let t: Awaited<ReturnType<typeof setupTenant>>;
let tenantId: string;

const ids = {
  acme: randomUUID(),
  beta: randomUUID(),
  gamma: randomUUID(),
  p1: randomUUID(),
  p2: randomUUID(),
  p3: randomUUID(),
  p4: randomUUID(),
};
const milestoneOf: Record<string, string> = {};

/** Extra members with NO template role (pure assignment subjects). */
let e1: MemberActor;
let m1: MemberActor;
let e2: MemberActor;
/** Custom role holder: manage_assignments WITHOUT client:view_all. */
let assigner: MemberActor;
const extraUsers: string[] = [];

const seatBare = async (label: string): Promise<MemberActor> => {
  const userId = randomUUID();
  extraUsers.push(userId);
  const email = `${label}-${randomUUID().slice(0, 8)}@test.invalid`;
  await platform().user.create({ data: { id: userId, name: email, email } });
  const m = await platform().member.create({ data: { tenantId, userId } });
  return actorFor(m.id);
};

const notFound = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ reason: "NOT_FOUND" });
const forbidden = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ reason: "FORBIDDEN" });

beforeAll(async () => {
  t = await setupTenant("scope");
  tenantId = t.tenantId;
  const db = platform();
  for (const [id, name] of [
    [ids.acme, "Acme"],
    [ids.beta, "Beta"],
    [ids.gamma, "Gamma"],
  ] as const) {
    await db.client.create({ data: { id, tenantId, name } });
  }
  for (const [id, clientId, key] of [
    [ids.p1, ids.acme, "P1"],
    [ids.p2, ids.acme, "P2"],
    [ids.p3, ids.beta, "P3"],
    [ids.p4, ids.gamma, "P4"],
  ] as const) {
    await db.project.create({ data: { id, tenantId, clientId, key, name: key } });
    const ms = await db.milestone.create({
      data: { tenantId, clientId, projectId: id, name: `${key} kickoff`, rank: "a0" },
    });
    milestoneOf[id] = ms.id;
  }
  e1 = await seatBare("e1");
  m1 = await seatBare("m1");
  e2 = await seatBare("e2");
  await db.memberProject.create({ data: { tenantId, memberId: e1.memberId, projectId: ids.p1 } });
  await db.memberClient.createMany({
    data: [
      { tenantId, memberId: m1.memberId, clientId: ids.acme },
      { tenantId, memberId: m1.memberId, clientId: ids.beta },
    ],
  });
  // Custom "Assigner" role: both manage_assignments codes, no view_all.
  assigner = await seatBare("assigner");
  const role = await db.role.create({ data: { tenantId, name: "Assigner" } });
  const perms = await db.permission.findMany({
    where: { code: { in: ["client:manage_assignments", "project:manage_assignments"] } },
  });
  await db.rolePermission.createMany({
    data: perms.map((p) => ({ tenantId, roleId: role.id, permissionId: p.id })),
  });
  await db.memberRole.create({ data: { tenantId, memberId: assigner.memberId, roleId: role.id } });
  await db.memberClient.create({ data: { tenantId, memberId: assigner.memberId, clientId: ids.acme } });
});

afterAll(async () => {
  const db = platform();
  await db.milestone.deleteMany({ where: { tenantId } });
  await db.memberProject.deleteMany({ where: { tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId } });
  await db.project.deleteMany({ where: { tenantId } });
  await db.client.deleteMany({ where: { tenantId } });
  await t.cleanup(); // members go with the tenant; then their users
  await db.user.deleteMany({ where: { id: { in: extraUsers } } });
});

const as = <T>(actor: MemberActor, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(tenantId, { type: "member", id: actor.memberId }, fn);

describe("authorizedResourceIds", () => {
  it("deny-default: E2 (no assignments) ⇒ zero clients, zero projects", async () => {
    await as(e2, async (tx) => {
      expect(await authorizedResourceIds(tx, e2, "client")).toEqual({ kind: "ids", ids: [] });
      expect(await authorizedResourceIds(tx, e2, "project")).toEqual({ kind: "ids", ids: [] });
    });
  });

  it("M1 (Acme, Beta): both clients and P1..P3; never Gamma/P4", async () => {
    await as(m1, async (tx) => {
      const c = await authorizedResourceIds(tx, m1, "client");
      expect(c.kind === "ids" && [...c.ids].sort()).toEqual([ids.acme, ids.beta].sort());
      const p = await authorizedResourceIds(tx, m1, "project");
      expect(p.kind === "ids" && [...p.ids].sort()).toEqual([ids.p1, ids.p2, ids.p3].sort());
    });
  });

  it("E1 (P1 only): project axis = P1; client axis = Acme (the lift)", async () => {
    await as(e1, async (tx) => {
      expect(await authorizedResourceIds(tx, e1, "project")).toEqual({ kind: "ids", ids: [ids.p1] });
      expect(await authorizedResourceIds(tx, e1, "client")).toEqual({ kind: "ids", ids: [ids.acme] });
    });
  });

  it("owner (client:view_all) ⇒ all", async () => {
    await as(t.seats.owner.actor, async (tx) => {
      expect(await authorizedResourceIds(tx, t.seats.owner.actor, "client")).toEqual({ kind: "all" });
      expect(await authorizedResourceIds(tx, t.seats.owner.actor, "project")).toEqual({ kind: "all" });
    });
  });
});

describe("assertInScope → NOT_FOUND", () => {
  it("M1 assigned to Acme and Beta cannot reach Gamma or P4", async () => {
    await as(m1, async (tx) => {
      await assertInScope(tx, m1, { clientId: ids.acme });
      await assertInScope(tx, m1, { projectId: ids.p3 });
      await notFound(assertInScope(tx, m1, { clientId: ids.gamma }));
      await notFound(assertInScope(tx, m1, { projectId: ids.p4 }));
    });
  });

  it("E1 (P1): P1 yes, P2 NOT_FOUND, Acme card only via lifted:true", async () => {
    await as(e1, async (tx) => {
      await assertInScope(tx, e1, { projectId: ids.p1 });
      await notFound(assertInScope(tx, e1, { projectId: ids.p2 }));
      await notFound(assertInScope(tx, e1, { clientId: ids.acme }));
      await assertInScope(tx, e1, { clientId: ids.acme, lifted: true });
    });
  });

  it("E2: everything NOT_FOUND; owner: only unknown ids are NOT_FOUND", async () => {
    await as(e2, async (tx) => {
      await notFound(assertInScope(tx, e2, { projectId: ids.p1 }));
      await notFound(assertInScope(tx, e2, { clientId: ids.acme, lifted: true }));
    });
    const owner = t.seats.owner.actor;
    await as(owner, async (tx) => {
      await assertInScope(tx, owner, { projectId: ids.p4 });
      await notFound(assertInScope(tx, owner, { projectId: randomUUID() }));
    });
  });
});

describe("scopeWhere composed into real list queries", () => {
  const listMilestones = async (actor: MemberActor) =>
    as(actor, async (tx) => {
      const scope = await scopeWhere(tx, actor, { clientField: "clientId", projectField: "projectId" });
      const rows = await tx.milestone.findMany({ where: { ...scope }, select: { projectId: true } });
      return rows.map((r) => r.projectId).sort();
    });
  const listClients = async (actor: MemberActor) =>
    as(actor, async (tx) => {
      const scope = await scopeWhere(tx, actor, { clientField: "id", lifted: true });
      const rows = await tx.client.findMany({ where: { ...scope }, select: { id: true } });
      return rows.map((r) => r.id).sort();
    });

  it("E1 sees P1's rows and the Acme card — none of Acme's P2 rows", async () => {
    expect(await listMilestones(e1)).toEqual([ids.p1]);
    expect(await listClients(e1)).toEqual([ids.acme]);
  });

  it("M1 sees Acme + Beta rows (P1, P2, P3) and both cards; E2 sees nothing; owner sees all", async () => {
    expect(await listMilestones(m1)).toEqual([ids.p1, ids.p2, ids.p3].sort());
    expect(await listClients(m1)).toEqual([ids.acme, ids.beta].sort());
    expect(await listMilestones(e2)).toEqual([]);
    expect(await listClients(e2)).toEqual([]);
    expect(await listMilestones(t.seats.owner.actor)).toEqual([ids.p1, ids.p2, ids.p3, ids.p4].sort());
    expect((await listClients(t.seats.owner.actor)).length).toBe(3);
  });
});

describe("assignment services", () => {
  it("manager assigns E2 to Gamma: audited, idempotent, then unassign", async () => {
    const mgr = t.seats.manager.actor;
    const r1 = await assignMemberToClient({ tenantId, actor: mgr, memberId: e2.memberId, clientId: ids.gamma });
    expect(r1).toEqual({ changed: true });
    const r2 = await assignMemberToClient({ tenantId, actor: mgr, memberId: e2.memberId, clientId: ids.gamma });
    expect(r2).toEqual({ changed: false });
    await as(e2, async (tx) => {
      expect(await authorizedResourceIds(tx, e2, "project")).toEqual({ kind: "ids", ids: [ids.p4] });
    });
    const added = await t.audits("assignment.client_added");
    expect(added.filter((a) => a.targetId === ids.gamma)).toHaveLength(1);
    expect(added[0]?.metadata).toEqual({ memberId: e2.memberId });

    const u1 = await unassignMemberFromClient({ tenantId, actor: mgr, memberId: e2.memberId, clientId: ids.gamma });
    expect(u1).toEqual({ changed: true });
    const u2 = await unassignMemberFromClient({ tenantId, actor: mgr, memberId: e2.memberId, clientId: ids.gamma });
    expect(u2).toEqual({ changed: false });
    expect(await t.audits("assignment.client_removed")).toHaveLength(1);
    await as(e2, async (tx) => {
      expect(await authorizedResourceIds(tx, e2, "project")).toEqual({ kind: "ids", ids: [] });
    });
  });

  it("project assignment lifts only the parent card; audited; unassign", async () => {
    const mgr = t.seats.manager.actor;
    expect(
      await assignMemberToProject({ tenantId, actor: mgr, memberId: e2.memberId, projectId: ids.p3 }),
    ).toEqual({ changed: true });
    await as(e2, async (tx) => {
      expect(await authorizedResourceIds(tx, e2, "project")).toEqual({ kind: "ids", ids: [ids.p3] });
      expect(await authorizedResourceIds(tx, e2, "client")).toEqual({ kind: "ids", ids: [ids.beta] });
      await notFound(assertInScope(tx, e2, { clientId: ids.beta }));
    });
    expect((await t.audits("assignment.project_added")).map((a) => a.targetId)).toContain(ids.p3);
    expect(
      await unassignMemberFromProject({ tenantId, actor: mgr, memberId: e2.memberId, projectId: ids.p3 }),
    ).toEqual({ changed: true });
    expect(await t.audits("assignment.project_removed")).toHaveLength(1);
  });

  it("no permission ⇒ FORBIDDEN; unknown member ⇒ NOT_FOUND", async () => {
    await forbidden(
      assignMemberToClient({ tenantId, actor: e1, memberId: e2.memberId, clientId: ids.acme }),
    );
    await notFound(
      assignMemberToClient({
        tenantId,
        actor: t.seats.manager.actor,
        memberId: randomUUID(),
        clientId: ids.acme,
      }),
    );
  });

  it("manage_assignments without view_all: only inside the actor's own scope (else NOT_FOUND)", async () => {
    // assigner holds both manage codes and MemberClient(Acme) only.
    expect(
      await assignMemberToClient({ tenantId, actor: assigner, memberId: e2.memberId, clientId: ids.acme }),
    ).toEqual({ changed: true });
    await notFound(
      assignMemberToClient({ tenantId, actor: assigner, memberId: e2.memberId, clientId: ids.gamma }),
    );
    expect(
      await assignMemberToProject({ tenantId, actor: assigner, memberId: e1.memberId, projectId: ids.p2 }),
    ).toEqual({ changed: true });
    await notFound(
      assignMemberToProject({ tenantId, actor: assigner, memberId: e1.memberId, projectId: ids.p4 }),
    );
    // Now E1 reaches P2 as well — and Acme directly via the new row? No:
    // E1 got MemberProject(P2), not MemberClient — still card-only.
    await as(e1, async (tx) => {
      const p = await authorizedResourceIds(tx, e1, "project");
      expect(p.kind === "ids" && [...p.ids].sort()).toEqual([ids.p1, ids.p2].sort());
      await notFound(assertInScope(tx, e1, { clientId: ids.acme }));
    });
    // Reset for cleanliness of other assertions.
    await unassignMemberFromClient({ tenantId, actor: assigner, memberId: e2.memberId, clientId: ids.acme });
    await unassignMemberFromProject({ tenantId, actor: assigner, memberId: e1.memberId, projectId: ids.p2 });
  });
});
