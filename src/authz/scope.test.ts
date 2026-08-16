import { describe, expect, it } from "vitest";

import type { TenantDb } from "@/db";

import {
  assertInScope,
  authorizedClientIds,
  authorizedResourceIds,
  resolveScope,
  scopeWhere,
} from "./authorize";
import { AuthzError } from "./errors";

/**
 * Scope resolution over a fake tx (AUTHZ.md §4 deny-matrix): client
 * Acme has projects P1, P2; client Beta has P3; client Gamma has P4.
 *   E1: MemberProject(P1)            E2: no assignments
 *   M1: MemberClient(Acme, Beta)     V:  client:view_all
 * The real-DB twin is scope.dbtest.ts; this file pins the SHAPES.
 */

const ACME = "acme";
const BETA = "beta";
const GAMMA = "gamma";
const P1 = "p1";
const P2 = "p2";
const P3 = "p3";
const P4 = "p4";
const projects = [
  { id: P1, clientId: ACME },
  { id: P2, clientId: ACME },
  { id: P3, clientId: BETA },
  { id: P4, clientId: GAMMA },
];

type Fixture = {
  codes: string[];
  memberClients: string[];
  memberProjects: string[];
};

const fakeTx = (f: Fixture): TenantDb =>
  ({
    memberRole: {
      findMany: async () => [
        {
          role: {
            rolePermissions: f.codes.map((code) => ({ permission: { code } })),
          },
        },
      ],
    },
    memberClient: {
      findMany: async () => f.memberClients.map((clientId) => ({ clientId })),
    },
    memberProject: {
      findMany: async () =>
        f.memberProjects.map((projectId) => ({
          projectId,
          project: { clientId: projects.find((p) => p.id === projectId)!.clientId },
        })),
    },
    project: {
      findMany: async ({ where }: { where: { clientId: { in: string[] } } }) =>
        projects.filter((p) => where.clientId.in.includes(p.clientId)).map((p) => ({ id: p.id })),
      findFirst: async ({ where }: { where: { id: string } }) =>
        projects.find((p) => p.id === where.id) ? { id: where.id } : null,
    },
    client: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        [ACME, BETA, GAMMA].includes(where.id) ? { id: where.id } : null,
    },
  }) as unknown as TenantDb;

const actor = { memberId: "m" };
const E1 = fakeTx({ codes: ["client:view"], memberClients: [], memberProjects: [P1] });
const E2 = fakeTx({ codes: ["client:view"], memberClients: [], memberProjects: [] });
const M1 = fakeTx({ codes: ["client:view"], memberClients: [ACME, BETA], memberProjects: [] });
const V = fakeTx({ codes: ["client:view", "client:view_all"], memberClients: [], memberProjects: [] });

const notFound = (p: Promise<unknown>) =>
  expect(p).rejects.toMatchObject({ reason: "NOT_FOUND" } satisfies Partial<AuthzError>);

describe("resolveScope / authorizedResourceIds", () => {
  it("deny-default: zero assignments ⇒ zero clients and zero projects", async () => {
    expect(await authorizedResourceIds(E2, actor, "client")).toEqual({ kind: "ids", ids: [] });
    expect(await authorizedResourceIds(E2, actor, "project")).toEqual({ kind: "ids", ids: [] });
    expect(await authorizedClientIds(E2, actor)).toEqual({ kind: "ids", ids: [] });
  });

  it("client:view_all ⇒ all on both axes", async () => {
    expect(await authorizedResourceIds(V, actor, "client")).toEqual({ kind: "all" });
    expect(await authorizedResourceIds(V, actor, "project")).toEqual({ kind: "all" });
    expect(await resolveScope(V, actor)).toEqual({ all: true });
  });

  it("MemberClient(Acme, Beta): both clients, all their projects, never Gamma/P4", async () => {
    const s = await resolveScope(M1, actor);
    expect(s).toMatchObject({ all: false, directClientIds: [ACME, BETA], liftedClientIds: [] });
    if (s.all) throw new Error("unreachable");
    expect([...s.projectIds].sort()).toEqual([P1, P2, P3]);
    const c = await authorizedResourceIds(M1, actor, "client");
    expect(c).toEqual({ kind: "ids", ids: [ACME, BETA] });
    const p = await authorizedResourceIds(M1, actor, "project");
    expect(p.kind === "ids" && [...p.ids].sort()).toEqual([P1, P2, P3]);
  });

  it("MemberProject(P1): P1 only on the project axis; Acme LIFTED on the client axis", async () => {
    const s = await resolveScope(E1, actor);
    expect(s).toEqual({ all: false, directClientIds: [], liftedClientIds: [ACME], projectIds: [P1] });
    expect(await authorizedResourceIds(E1, actor, "client")).toEqual({ kind: "ids", ids: [ACME] });
    expect(await authorizedResourceIds(E1, actor, "project")).toEqual({ kind: "ids", ids: [P1] });
  });
});

describe("assertInScope → NOT_FOUND, never FORBIDDEN", () => {
  it("no assignments: every ref is NOT_FOUND", async () => {
    await notFound(assertInScope(E2, actor, { projectId: P1 }));
    await notFound(assertInScope(E2, actor, { clientId: ACME }));
    await notFound(assertInScope(E2, actor, { clientId: ACME, lifted: true }));
  });

  it("MemberClient(Acme, Beta) reaches Acme/Beta/P1..P3, not Gamma/P4", async () => {
    await assertInScope(M1, actor, { clientId: ACME });
    await assertInScope(M1, actor, { clientId: BETA });
    await assertInScope(M1, actor, { projectId: P2 });
    await assertInScope(M1, actor, { projectId: P3 });
    await notFound(assertInScope(M1, actor, { clientId: GAMMA }));
    await notFound(assertInScope(M1, actor, { projectId: P4 }));
  });

  it("MemberProject(P1): P1 yes, P2 no; Acme card only with lifted:true", async () => {
    await assertInScope(E1, actor, { projectId: P1 });
    await notFound(assertInScope(E1, actor, { projectId: P2 }));
    await notFound(assertInScope(E1, actor, { clientId: ACME }));
    await assertInScope(E1, actor, { clientId: ACME, lifted: true });
    await notFound(assertInScope(E1, actor, { clientId: BETA, lifted: true }));
  });

  it("client:view_all: in scope when the row exists in the tenant, NOT_FOUND otherwise", async () => {
    await assertInScope(V, actor, { projectId: P4 });
    await assertInScope(V, actor, { clientId: GAMMA });
    await notFound(assertInScope(V, actor, { projectId: "nope" }));
    await notFound(assertInScope(V, actor, { clientId: "nope" }));
  });
});

describe("scopeWhere fragments", () => {
  it("client:view_all ⇒ {}", async () => {
    expect(await scopeWhere(V, actor, { clientField: "clientId", projectField: "projectId" })).toEqual({});
    expect(await scopeWhere(V, actor, { clientField: "id", lifted: true })).toEqual({});
  });

  it("project-scoped table: OR of direct clients and projects — lifted clients absent", async () => {
    expect(await scopeWhere(E1, actor, { clientField: "clientId", projectField: "projectId" })).toEqual({
      OR: [{ clientId: { in: [] } }, { projectId: { in: [P1] } }],
    });
    const m = await scopeWhere(M1, actor, { clientField: "clientId", projectField: "projectId" });
    expect(m).toMatchObject({ OR: [{ clientId: { in: [ACME, BETA] } }, {}] });
  });

  it("client-scoped table without projectField: direct clients only", async () => {
    expect(await scopeWhere(E1, actor, { clientField: "clientId" })).toEqual({ clientId: { in: [] } });
    expect(await scopeWhere(M1, actor, { clientField: "clientId" })).toEqual({
      clientId: { in: [ACME, BETA] },
    });
  });

  it("Client table (clientField 'id', lifted): direct ∪ lifted", async () => {
    expect(await scopeWhere(E1, actor, { clientField: "id", lifted: true })).toEqual({
      id: { in: [ACME] },
    });
    expect(await scopeWhere(E2, actor, { clientField: "id", lifted: true })).toEqual({ id: { in: [] } });
  });
});
