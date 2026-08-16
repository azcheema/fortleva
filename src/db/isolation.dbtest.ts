import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MODEL_CLASSES,
  PORTAL_ENABLED_FANOUT_TARGETS,
  PORTAL_GATE_VARIANTS,
  RLS_CLASSES,
  tableNameOf,
  withPlatform,
  withTenant,
} from "./index";
import { getPlatformClient, runtimeClient } from "./client";

/** Every tenant-scoped table, from the registry — a new model is
 * covered by the fail-closed / portal_deny tests the moment it is
 * classified. */
const TENANT_TABLES = MODEL_CLASSES.tenant.map(tableNameOf);

const countAll = async (
  db: { $queryRawUnsafe: typeof runtimeClient.$queryRawUnsafe },
  tables: readonly string[],
): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const t of tables) {
    // Table names come from the registry (constants), never from input.
    const rows = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${t}`);
    out[t] = rows[0]?.n ?? -1;
  }
  return out;
};

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
    const counts = await countAll(runtimeClient, ["tenant", ...TENANT_TABLES]);
    expect(counts).toEqual(
      Object.fromEntries(["tenant", ...TENANT_TABLES].map((t) => [t, 0])),
    );
  });

  it("app.principal_id is set transaction-locally per principal kind, empty outside", async () => {
    const read = (tx: { $queryRaw: typeof runtimeClient.$queryRaw }) =>
      tx
        .$queryRaw<{ v: string }[]>`SELECT current_setting('app.principal_id', true) AS v`
        .then((r) => r[0]?.v);

    expect(
      await withTenant(A.id, { type: "member", id: memberA.id }, (tx) => read(tx)),
    ).toBe(memberA.id);
    const contactId = randomUUID();
    expect(
      await withTenant(
        A.id,
        { type: "contact", id: contactId, clientId: randomUUID() },
        (tx) => read(tx),
      ),
    ).toBe(contactId);
    expect(await withTenant(A.id, { type: "system" }, (tx) => read(tx))).toBe("");
    // Outside any unit of work: unset ('' or NULL) — never a leaked id.
    expect(await read(runtimeClient)).not.toBe(memberA.id);
    expect(await read(runtimeClient) ?? "").toBe("");
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
        // Every registered tenant table, raw — class A is denied outright,
        // class B has no CLIENT_VISIBLE rows for a fake client.
        const counts = await countAll(tx, ["tenant", ...TENANT_TABLES]);
        expect(counts).toEqual(
          Object.fromEntries(["tenant", ...TENANT_TABLES].map((t) => [t, 0])),
        );
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

  it("every RLS subclass has the columns and policies its class implies", async () => {
    type Posture = { table: string; policies: string[]; columns: string[]; quals: Record<string, string> };
    const posture = await withPlatform(
      { type: "system", job: "posture-test" },
      "read RLS posture from pg_policies / information_schema",
      async (tx) => {
        const policies = await tx.$queryRaw<{ tablename: string; policyname: string; qual: string | null }[]>`
          SELECT tablename, policyname, qual FROM pg_policies WHERE schemaname = 'public'`;
        const columns = await tx.$queryRaw<{ table_name: string; column_name: string }[]>`
          SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public'`;
        const byTable = new Map<string, Posture>();
        const get = (t: string) => {
          let p = byTable.get(t);
          if (!p) byTable.set(t, (p = { table: t, policies: [], columns: [], quals: {} }));
          return p;
        };
        for (const p of policies) {
          get(p.tablename).policies.push(p.policyname);
          get(p.tablename).quals[p.policyname] = p.qual ?? "";
        }
        for (const c of columns) get(c.table_name).columns.push(c.column_name);
        return byTable;
      },
      { readOnly: true },
    );

    const of = (model: string): Posture => {
      const p = posture.get(tableNameOf(model));
      expect(p, `${tableNameOf(model)} exists`).toBeDefined();
      return p!;
    };
    const variantOf = (model: string) =>
      (PORTAL_GATE_VARIANTS as Record<string, { clientColumn: string; term: string } | undefined>)[model];

    for (const m of RLS_CLASSES.A) {
      const p = of(m);
      expect(p.policies, `${p.table}: class A needs tenant_isolation`).toContain("tenant_isolation");
      expect(p.policies, `${p.table}: class A needs portal_deny`).toContain("portal_deny");
      expect(p.policies, `${p.table}: class A must not carry portal_gate`).not.toContain("portal_gate");
      expect(p.columns, `${p.table}: class A must NEVER have visibility`).not.toContain("visibility");
      expect(p.columns, `${p.table}: class A must NEVER have portal_enabled`).not.toContain("portal_enabled");
    }
    // Class B, both subclasses: tenant_isolation + portal_gate, the
    // client column, and the visibility term unless a declared variant.
    const classB = [
      ...RLS_CLASSES.B_clientScoped.map((m) => [m, "B_clientScoped"] as const),
      ...RLS_CLASSES.B_projectScoped.map((m) => [m, "B_projectScoped"] as const),
    ];
    for (const [m, cls] of classB) {
      const p = of(m);
      const v = variantOf(m);
      expect(p.policies, `${p.table}: class B needs tenant_isolation`).toContain("tenant_isolation");
      expect(p.policies, `${p.table}: class B needs portal_gate`).toContain("portal_gate");
      expect(p.policies, `${p.table}: class B must not carry portal_deny`).not.toContain("portal_deny");
      expect(p.columns, `${p.table}: needs ${v?.clientColumn ?? "client_id"}`).toContain(
        v?.clientColumn ?? "client_id",
      );
      const gate = p.quals["portal_gate"] ?? "";
      expect(gate, `${p.table}: portal_gate must key on app.client_id`).toContain("app.client_id");
      if (v) {
        // Structural row: the visibility term is replaced — and the
        // column must not exist, or the exception is stale.
        expect(p.columns, `${p.table}: structural gate ⇒ no visibility column`).not.toContain("visibility");
        if (v.term === "status") expect(gate, `${p.table}: status-structural gate`).toContain("status");
      } else {
        expect(p.columns, `${p.table}: needs visibility`).toContain("visibility");
        expect(gate, `${p.table}: portal_gate must test visibility`).toContain("CLIENT_VISIBLE");
      }
      if (cls === "B_projectScoped") {
        expect(p.columns, `${p.table}: needs portal_enabled`).toContain("portal_enabled");
        expect(gate, `${p.table}: portal_gate must AND portal_enabled`).toContain("portal_enabled");
      } else {
        expect(p.columns, `${p.table}: clientScoped must not carry portal_enabled`).not.toContain(
          "portal_enabled",
        );
      }
    }
    // Every tenant-scoped table (any subclass) physically has tenant_id.
    for (const m of MODEL_CLASSES.tenant) {
      expect(of(m).columns, `${tableNameOf(m)}: tenant_id`).toContain("tenant_id");
    }
  });

  it("the project.portal_enabled fan-out reaches every projectScoped table", async () => {
    const platform = getPlatformClient();
    const [fn] = await platform.$queryRaw<{ src: string }[]>`
      SELECT pg_get_functiondef('project_portal_enabled_fanout'::regproc) AS src`;
    const src = fn?.src ?? "";
    for (const m of PORTAL_ENABLED_FANOUT_TARGETS) {
      const t = tableNameOf(m);
      expect(src, `fan-out trigger must UPDATE ${t}`).toMatch(new RegExp(`UPDATE\\s+${t}\\s`));
      const trig = await platform.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_trigger
        WHERE tgname = ${`${t}_stamp_portal_enabled`} AND NOT tgisinternal`;
      expect(trig[0]?.n, `${t}: BEFORE INSERT/UPDATE stamp trigger`).toBe(1);
    }
  });
});
