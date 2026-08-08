import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withPlatform, withTenant } from "./index";
import { getPlatformClient, runtimeClient } from "./client";

/**
 * CI cross-tenant isolation suite, Phase 1 slice (TENANCY.md §11).
 * Adversarial by construction: seeds tenants A and B, then proves as
 * the real app_runtime role that B can neither see nor touch A.
 * Runs on every PR forever; models added in later phases extend it
 * via the model-registry census.
 */

const run = randomUUID().slice(0, 8);
const A = { id: randomUUID(), slug: `iso-a-${run}` };
const B = { id: randomUUID(), slug: `iso-b-${run}` };
const userA = { id: randomUUID(), email: `iso-a-${run}@test.invalid` };
const userB = { id: randomUUID(), email: `iso-b-${run}@test.invalid` };
const memberA = { id: randomUUID() };
const memberB = { id: randomUUID() };
const roleA = { id: randomUUID() };
const roleB = { id: randomUUID() };

beforeAll(async () => {
  await withPlatform(
    { type: "system", job: "isolation-suite-seed" },
    "seed isolation-suite fixtures",
    async (tx) => {
      for (const [t, u, m, r] of [
        [A, userA, memberA, roleA],
        [B, userB, memberB, roleB],
      ] as const) {
        await tx.tenant.create({
          data: { id: t.id, name: t.slug, slug: t.slug, entitlements: {} },
        });
        await tx.user.create({
          data: { id: u.id, name: u.email, email: u.email },
        });
        await tx.member.create({
          data: { id: m.id, tenantId: t.id, userId: u.id },
        });
        await tx.role.create({
          data: {
            id: r.id,
            tenantId: t.id,
            name: "CEO",
            isSystem: true,
            templateKey: "owner",
          },
        });
        await tx.memberRole.create({
          data: { tenantId: t.id, memberId: m.id, roleId: r.id },
        });
      }
    },
    { readOnly: false },
  );
});

afterAll(async () => {
  const platform = getPlatformClient();
  await platform.$transaction(async (tx) => {
    const tenantIds = [A.id, B.id];
    await tx.memberRole.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.role.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.member.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await tx.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    await tx.auditEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
  });
  await platform.$disconnect();
  await runtimeClient.$disconnect();
});

describe("read isolation", () => {
  it("B sees zero of A's roles/members; A's ids resolve to null", async () => {
    await withTenant(B.id, { type: "member", id: memberB.id }, async (tx) => {
      const roles = await tx.role.findMany();
      expect(roles.map((r) => r.tenantId)).toEqual([B.id]);

      const aRole = await tx.role.findFirst({ where: { id: roleA.id } });
      expect(aRole).toBeNull();

      const members = await tx.member.count();
      expect(members).toBe(1);
    });
  });

  it("B reads only its own tenant row", async () => {
    await withTenant(B.id, { type: "member", id: memberB.id }, async (tx) => {
      const tenants = await tx.tenant.findMany();
      expect(tenants.map((t) => t.id)).toEqual([B.id]);
    });
  });
});

describe("write isolation", () => {
  it("B's updates/deletes by A's ids touch zero rows", async () => {
    await withTenant(B.id, { type: "member", id: memberB.id }, async (tx) => {
      const upd = await tx.role.updateMany({
        where: { id: roleA.id },
        data: { name: "pwned" },
      });
      expect(upd.count).toBe(0);

      const del = await tx.role.deleteMany({ where: { id: roleA.id } });
      expect(del.count).toBe(0);
    });
    await withTenant(A.id, { type: "member", id: memberA.id }, async (tx) => {
      const role = await tx.role.findFirst({ where: { id: roleA.id } });
      expect(role?.name).toBe("CEO");
    });
  });

  it("cross-tenant junction insert violates the composite FK", async () => {
    await expect(
      withTenant(B.id, { type: "member", id: memberB.id }, async (tx) => {
        await tx.memberRole.create({
          data: { tenantId: B.id, memberId: memberB.id, roleId: roleA.id },
        });
      }),
    ).rejects.toThrow();
  });
});

describe("fail-closed and GUC lifecycle", () => {
  it("no GUC set → zero rows on every tenant table (raw, as app_runtime)", async () => {
    const counts = await runtimeClient.$queryRaw<
      { tenants: number; roles: number; members: number }[]
    >`SELECT (SELECT count(*)::int FROM tenant)  AS tenants,
             (SELECT count(*)::int FROM role)    AS roles,
             (SELECT count(*)::int FROM member)  AS members`;
    expect(counts[0]).toEqual({ tenants: 0, roles: 0, members: 0 });
  });

  it("GUC does not leak across transactions on the pooled connection", async () => {
    await withTenant(A.id, { type: "member", id: memberA.id }, async (tx) => {
      expect(await tx.role.count()).toBe(1);
    });
    const after = await runtimeClient.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM role`;
    expect(after[0]?.n).toBe(0);
  });

  it("writes without tenant context are rejected", async () => {
    await expect(
      runtimeClient.$executeRaw`
        INSERT INTO role (id, tenant_id, name, updated_at)
        VALUES (${randomUUID()}, ${A.id}, 'no-context', now())`,
    ).rejects.toThrow();
  });
});

describe("audit append-only (as app_runtime)", () => {
  it("insert into own tenant OK; cross-tenant insert rejected; mutation denied", async () => {
    await withTenant(A.id, { type: "member", id: memberA.id }, async (tx) => {
      await tx.auditEvent.create({
        data: {
          tenantId: A.id,
          actorType: "MEMBER",
          actorId: memberA.id,
          action: "test.event",
          visibility: "TENANT",
        },
      });
    });

    await expect(
      withTenant(B.id, { type: "member", id: memberB.id }, async (tx) => {
        await tx.auditEvent.create({
          data: {
            tenantId: A.id, // forged target tenant
            actorType: "MEMBER",
            action: "test.forged",
            visibility: "TENANT",
          },
        });
      }),
    ).rejects.toThrow();

    await expect(
      runtimeClient.$executeRaw`UPDATE audit_event SET action = 'x'`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtimeClient.$executeRaw`DELETE FROM audit_event`,
    ).rejects.toThrow(/permission denied/);
  });
});

describe("portal principal (contact) is denied everywhere in Phase 1", () => {
  it("a contact principal sees zero rows on staff tables", async () => {
    const fakeClientId = randomUUID();
    await withTenant(
      A.id,
      { type: "contact", id: randomUUID(), clientId: fakeClientId },
      async (tx) => {
        expect(await tx.role.count()).toBe(0);
        expect(await tx.member.count()).toBe(0);
        expect(await tx.tenant.count()).toBe(0);
        expect(await tx.document.count()).toBe(0);
      },
    );
  });
});

describe("posture assertions", () => {
  it("app_runtime cannot bypass RLS; every tenant table is FORCED", async () => {
    const platform = getPlatformClient();
    const role = await platform.$queryRaw<
      { rolbypassrls: boolean }[]
    >`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime'`;
    expect(role[0]?.rolbypassrls).toBe(false);

    const unforced = await platform.$queryRaw<{ relname: string }[]>`
      SELECT relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND relname NOT LIKE '_prisma%'
        AND NOT (relrowsecurity AND relforcerowsecurity)`;
    expect(unforced).toEqual([]);
  });
});
