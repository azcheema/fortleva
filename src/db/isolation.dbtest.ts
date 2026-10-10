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
  /**
   * The suite must be CONNECTED as the restricted role, not merely
   * running alongside a role that happens to bear its name. Everything
   * below asserts properties OF app_runtime, read through the platform
   * client — and every one of those assertions passes just as happily on
   * a connection that is really the owner. That is exactly how a local
   * Postgres false-passes RLS, which is the reason TENANCY.md §11 gave
   * for refusing one. Since 2026-09-01 CI runs against a service
   * container whose OWNER is a superuser, so this assertion is what
   * makes the container's green mean what the ephemeral branch's would
   * have meant. It is cheap, and it fails loudly on the one mistake that
   * would otherwise turn this whole file into theatre.
   */
  it("is connected AS app_runtime, and the platform seam AS app_platform", async () => {
    const runtime = await runtimeClient.$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    expect(runtime[0]?.role).toBe("app_runtime");

    const platform = await getPlatformClient().$queryRaw<
      { role: string }[]
    >`SELECT current_user AS role`;
    expect(platform[0]?.role).toBe("app_platform");
  });

  /**
   * The database this suite runs against must SORT like production's.
   * Read off the deployed database on 2026-09-01: PostgreSQL 18.6,
   * datcollate/datctype `C.UTF-8`, datlocprovider `b` (the builtin
   * provider). CI now runs against a `postgres:18` service container,
   * and that image's own initdb default is `en_US.utf8` under libc —
   * which orders text differently, so every ORDER BY on a name or a
   * title would answer one way here and another in production. ci.yml
   * pins the container's locale to match; this asserts it, because a
   * promise in a YAML comment is not a check and nobody owns it.
   * (The `rank` columns are COLLATE "C" by migration and were never at
   * risk — it is every other text column that was.)
   */
  it("sorts like production: C.UTF-8 under the builtin locale provider", async () => {
    const db = await getPlatformClient().$queryRaw<
      { datcollate: string; datctype: string; datlocprovider: string }[]
    >`SELECT datcollate, datctype, datlocprovider::text
        FROM pg_database WHERE datname = current_database()`;
    expect(db[0]).toMatchObject({
      datcollate: "C.UTF-8",
      datctype: "C.UTF-8",
      datlocprovider: "b",
    });
  });

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
    type Posture = {
      table: string;
      policies: string[];
      /** The PERMISSIVE subset. They OR together, so only these can
       * WIDEN what a principal reaches; a RESTRICTIVE policy can only
       * narrow. The class-B check below keys on this distinction. */
      permissive: string[];
      columns: string[];
      quals: Record<string, string>;
    };
    const posture = await withPlatform(
      { type: "system", job: "posture-test" },
      "read RLS posture from pg_policies / information_schema",
      async (tx) => {
        const policies = await tx.$queryRaw<{ tablename: string; policyname: string; qual: string | null; permissive: string }[]>`
          SELECT tablename, policyname, qual, permissive FROM pg_policies WHERE schemaname = 'public'`;
        const columns = await tx.$queryRaw<{ table_name: string; column_name: string }[]>`
          SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public'`;
        const byTable = new Map<string, Posture>();
        const get = (t: string) => {
          let p = byTable.get(t);
          if (!p) byTable.set(t, (p = { table: t, policies: [], permissive: [], columns: [], quals: {} }));
          return p;
        };
        for (const p of policies) {
          get(p.tablename).policies.push(p.policyname);
          get(p.tablename).quals[p.policyname] = p.qual ?? "";
          if (p.permissive === "PERMISSIVE") get(p.tablename).permissive.push(p.policyname);
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
    // Class A's extra RESTRICTIVE policies that something depends on, pinned
    // BY NAME — `toContain` above cannot see one dropped (the design review
    // of slice 106, L8). `push_subscription`'s `own_device` is the only thing
    // keeping a member's devices from their colleagues (Phase 5 slice 106).
    const CLASS_A_REQUIRED_EXTRA: Readonly<Record<string, readonly string[]>> = {
      pushSubscription: ["own_device"],
    };
    for (const [m, names] of Object.entries(CLASS_A_REQUIRED_EXTRA)) {
      const p = of(m);
      for (const name of names) {
        expect(p.policies, `${p.table}: needs ${name}`).toContain(name);
        expect(p.quals[name] ?? "", `${p.table}: ${name} must key on the principal`).toContain("app.principal_id");
      }
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
      // EXACT policy set, not just "contains the two it needs".
      //
      // Every other assertion here is `toContain`, which cannot see an
      // ADDED policy — and PERMISSIVE policies OR together, so a
      // `USING (true)` added to a class-B table is the worst mistake
      // this schema can make and the one the posture test was blindest
      // to (security review, 2026-09-20: `contact_auth_lookup` was
      // added to a class-B table and nothing noticed). Anything beyond
      // the standard pair has to be named here, which forces the next
      // person adding one to state it deliberately.
      const EXTRA_CLASS_B_POLICIES: Readonly<Record<string, readonly string[]>> = {
        // The portal auth path's narrow admission (Phase 3 slice 1,
        // migration 20260920210000). SELECT only; keyed on a
        // transaction-local GUC that only src/db/portal-identity.ts
        // sets; `nullif(…,'')` so an empty GUC matches nothing.
        contact: ["contact_auth_lookup"],
      };
      // Only PERMISSIVE policies are checked, because only they can
      // WIDEN: they OR with tenant_isolation. A RESTRICTIVE addition
      // can only narrow (comment carries portal_no_update /
      // portal_no_delete that way), so it needs no declaration here.
      const allowed = new Set([
        "tenant_isolation",
        "portal_gate",
        ...(EXTRA_CLASS_B_POLICIES[m] ?? []),
      ]);
      expect(
        p.permissive.filter((name) => !allowed.has(name)).sort(),
        `${p.table}: undeclared PERMISSIVE policy on a class-B table — it ORs with tenant_isolation and can only widen`,
      ).toEqual([]);
    }
    // Class B's extra RESTRICTIVE belts that something depends on, pinned BY
    // NAME — a RESTRICTIVE policy can only narrow, so nothing above sees one
    // DROPPED (the slice-109 design review's low). `invoice`'s
    // `portal_invoice_primary` is what keeps a client's collaborators from its
    // invoices in the database (AUTHZ §8: no money for collaborators).
    const CLASS_B_REQUIRED_EXTRA: Readonly<Record<string, { readonly name: string; readonly qual: string }>> = {
      invoice: { name: "portal_invoice_primary", qual: "CONTACT_PRIMARY" },
      contract: { name: "portal_contract_primary", qual: "CONTACT_PRIMARY" },
    };
    for (const [m, { name, qual }] of Object.entries(CLASS_B_REQUIRED_EXTRA)) {
      const p = of(m);
      expect(p.policies, `${p.table}: needs ${name}`).toContain(name);
      expect(p.permissive, `${p.table}: ${name} must be RESTRICTIVE`).not.toContain(name);
      expect(p.quals[name] ?? "", `${p.table}: ${name} must test ${qual}`).toContain(qual);
      expect(p.quals[name] ?? "", `${p.table}: ${name} must read the contact's own row`).toContain("app.principal_id");
    }
    // principalScoped (notification): tenant_isolation + the RESTRICTIVE
    // receiver binding on SELECT and UPDATE, an INSERT deny for contacts,
    // and NEVER the class-B columns (it is not portal content).
    for (const m of RLS_CLASSES.principalScoped) {
      const p = of(m);
      expect(p.policies, `${p.table}: principalScoped needs tenant_isolation`).toContain(
        "tenant_isolation",
      );
      expect(p.policies, `${p.table}: principalScoped needs principal_scope`).toContain(
        "principal_scope",
      );
      expect(p.policies, `${p.table}: principalScoped needs principal_scope_update`).toContain(
        "principal_scope_update",
      );
      expect(p.policies, `${p.table}: principalScoped needs portal_insert_deny`).toContain(
        "portal_insert_deny",
      );
      // Slice 104: `app_runtime` may DELETE here, held by two RESTRICTIVE
      // policies — contacts never, and otherwise only SYSTEM on a row
      // archived over a year ago (the inbox's housekeeping). Losing either
      // turns the grant into a delete any member could make.
      expect(p.policies, `${p.table}: principalScoped needs portal_delete_deny`).toContain(
        "portal_delete_deny",
      );
      expect(p.policies, `${p.table}: principalScoped needs retention_delete`).toContain(
        "retention_delete",
      );
      expect(p.quals["retention_delete"] ?? "", `${p.table}: retention_delete is SYSTEM-only`).toContain("'system'");
      const scope = p.quals["principal_scope"] ?? "";
      expect(scope, `${p.table}: principal_scope binds to app.principal_id`).toContain(
        "app.principal_id",
      );
      expect(p.columns, `${p.table}: principalScoped never has visibility`).not.toContain(
        "visibility",
      );
      expect(p.columns, `${p.table}: principalScoped never has portal_enabled`).not.toContain(
        "portal_enabled",
      );
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

/**
 * THE PORTAL SWITCH GATE, STRUCTURALLY (Phase 3 slice 74, OPEN_QUESTIONS
 * C40; migration 20260928180000). The behaviour is measured in
 * src/projects/portal-switch-gate.dbtest.ts; what is pinned here is what
 * no row-value test can see and every part of the proof rests on: which
 * lock each function takes, and in what ORDER; that nothing a writer runs
 * can WAIT (a blocking stamp or heal closes a wait-for cycle with the
 * switch — the design review counted ~25 such writers); the READ
 * COMMITTED and no-xid premises; the volatility a stale snapshot
 * would hide behind; and that the probes' inline key derivation finds the
 * lock the product takes.
 *
 * Bodies come from pg_get_functiondef with `--` comments stripped first,
 * so prose in a comment can neither satisfy a pin nor break one.
 */
describe("the portal switch gate, structurally (slice 74)", () => {
  const STAMPED = PORTAL_ENABLED_FANOUT_TARGETS.map(tableNameOf);
  const ROW_LOCK = /\bFOR\s+(NO\s+KEY\s+UPDATE|KEY\s+SHARE|SHARE|UPDATE)\b/i;
  const bodyOf = async (fn: string): Promise<string> => {
    const [row] = await getPlatformClient().$queryRaw<{ src: string }[]>`
      SELECT pg_get_functiondef(${fn}::regproc) AS src`;
    return (row?.src ?? "").replace(/--[^\n]*/g, "");
  };

  it("the stamp and the heal only TRY the gate: no blocking lock, no row lock", async () => {
    for (const fn of ["stamp_portal_enabled", "portal_heal_in_doubt"]) {
      const src = await bodyOf(fn);
      expect(src, `${fn} tries the gate`).toContain("portal_gate_try_shared(");
      for (const blocking of ["portal_gate_enter_shared(", "portal_switch_begin(", "pg_advisory_xact_lock", "pg_advisory_lock"]) {
        expect(src, `${fn} must never wait on the gate (${blocking})`).not.toContain(blocking);
      }
      expect(src, `${fn} must take no row lock`).not.toMatch(ROW_LOCK);
    }
  });

  it("the try helpers call only the non-blocking lock functions, each on its own key", async () => {
    const tries: [string, number][] = [
      ["portal_gate_try_shared", 7401],
      ["portal_gate_try_exclusive", 7401],
      ["portal_doubt_register", 7402],
      ["portal_doubt_drained", 7402],
    ];
    for (const [fn, seed] of tries) {
      const src = await bodyOf(fn);
      expect(src, `${fn} tries`).toMatch(/pg_try_advisory_xact_lock(_shared)?\(/);
      expect(src, `${fn} keys on ${seed}`).toContain(String(seed));
      expect(src, `${fn} keys on nothing else`).not.toContain(String(seed === 7401 ? 7402 : 7401));
      const rest = src.replace(/pg_try_advisory_xact_lock(_shared)?\(/g, "");
      expect(rest, `${fn} takes no other lock`).not.toMatch(/advisory|portal_switch_begin\(|portal_gate_enter_shared\(/);
      expect(rest, `${fn} takes no row lock`).not.toMatch(ROW_LOCK);
    }
  });

  it("the blocking entries, the drain and the reconcile assert the no-xid rule; all that decides on the switch asserts READ COMMITTED", async () => {
    for (const fn of ["portal_switch_begin", "portal_gate_enter_shared", "portal_doubt_drained", "portal_switch_reconcile"]) {
      expect(await bodyOf(fn), `${fn}: no transaction id yet`).toContain("pg_current_xact_id_if_assigned()");
    }
    for (const fn of [
      "portal_switch_begin",
      "project_portal_enabled_fanout",
      "portal_switch_reconcile",
      "stamp_portal_enabled",
      "portal_heal_in_doubt",
    ]) {
      expect(await bodyOf(fn), `${fn}: READ COMMITTED`).toMatch(
        /current_setting\('transaction_isolation'\)\s*<>\s*'read committed'/,
      );
    }
  });

  it("volatility: nothing that locks or reads the switch may reuse a snapshot, or run in a worker; the key halves are immutable", async () => {
    const lockers = [
      "portal_gate_try_shared",
      "portal_gate_try_exclusive",
      "portal_doubt_register",
      "portal_doubt_drained",
      "portal_switch_begin",
      "portal_gate_enter_shared",
    ];
    const volatile = [...lockers, "stamp_portal_enabled", "portal_heal_in_doubt", "project_portal_enabled_fanout", "portal_switch_reconcile"];
    const keys = ["portal_gate_key_hi", "portal_gate_key_lo"];
    const rows = await getPlatformClient().$queryRaw<{ proname: string; provolatile: string; proparallel: string }[]>`
      SELECT p.proname::text AS proname, p.provolatile::text AS provolatile, p.proparallel::text AS proparallel
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname::text = ANY(${[...volatile, ...keys]}::text[])`;
    // One row each: an overload would make every pin above ambiguous.
    expect(rows.map((r) => r.proname).sort()).toEqual([...volatile, ...keys].sort());
    const by = new Map(rows.map((r) => [r.proname, r]));
    // A STABLE stamp would reuse the outer statement's snapshot.
    for (const fn of volatile) expect(by.get(fn)?.provolatile, `${fn}: VOLATILE`).toBe("v");
    // A parallel worker's lock is not its leader's.
    for (const fn of lockers) expect(by.get(fn)?.proparallel, `${fn}: never PARALLEL SAFE`).not.toBe("s");
    for (const fn of keys) expect(by.get(fn)?.provolatile, `${fn}: IMMUTABLE`).toBe("i");
  });

  it("the reconcile names every leg, skips locked rows, and takes the gate BEFORE it reads the switch", async () => {
    const src = await bodyOf("portal_switch_reconcile");
    for (const t of [...STAMPED, "search_index"]) {
      expect(src, `the reconcile must UPDATE ${t}`).toMatch(new RegExp(`UPDATE\\s+${t}\\s`));
    }
    // It never waits on a row a writer holds.
    expect(src.match(/FOR\s+NO\s+KEY\s+UPDATE\s+SKIP\s+LOCKED/g)?.length, "every leg skips locked rows").toBe(
      STAMPED.length + 1,
    );
    // THE ORDER IS THE SAFETY: search_index has no stamp to re-derive a
    // stale value, so a reconcile that read the switch before holding the
    // gate could write TRUE over a project a DISABLE just switched off.
    const lock = src.search(
      /(pg_advisory_xact_lock_shared\(\s*portal_gate_key_hi\(\s*p_project\s*,\s*7401\s*\)|portal_gate_enter_shared\(\s*p_project\s*\))/,
    );
    const read = src.search(/\bFROM\s+project\s/);
    expect(lock, "the reconcile takes the gate shared").toBeGreaterThanOrEqual(0);
    expect(read, "…and reads the switch only after it").toBeGreaterThan(lock);
  });

  it("the fan-out tries the gate before its first leg, and refuses with the retryable SQLSTATE", async () => {
    const src = await bodyOf("project_portal_enabled_fanout");
    const tried = src.indexOf("portal_gate_try_exclusive(");
    const firstLeg = src.search(/\bUPDATE\s+\w+\s+SET\b/);
    expect(tried, "the fan-out tries the gate exclusive").toBeGreaterThanOrEqual(0);
    expect(firstLeg, "…before any leg").toBeGreaterThan(tried);
    expect(src).toMatch(/ERRCODE\s*=\s*'55P03'/);
  });

  it("the switch changes only through the fan-out: no BEFORE trigger on `project` writes the switch, and its trigger set is exactly the four pinned here", async () => {
    // THE PROOF'S THIRD PREMISE. The fan-out is `AFTER UPDATE OF
    // portal_enabled`, and a column-specific trigger fires only when the
    // column is in the statement's SET list — a change a BEFORE UPDATE
    // trigger makes to NEW does not count. So a BEFORE UPDATE trigger that
    // rewrote NEW.portal_enabled would move the switch WITHOUT the fan-out
    // and without its gate: every child would keep its old copy, `true`
    // included. (A BEFORE INSERT one could not: a new project has no
    // children, and every later stamp reads it fresh.) The exact set is
    // pinned too, so the next trigger on `project` is a decision someone
    // makes here, not one this assertion walks past.
    //
    // THAT DECISION WAS MADE ONCE (Phase 5 slice 102, its migration
    // reviewed before it was applied): `project_update_schedule_stamp`, a
    // BEFORE INSERT OR UPDATE row trigger that ASSIGNS ONLY
    // `NEW.update_schedule_since` — it LISTENS to the switch (turning the
    // portal on restarts a project's update schedule) and never writes it.
    // So the premise is pinned by MEANING now, not by the absence of BEFORE
    // triggers: no BEFORE trigger's function on `project` assigns
    // `NEW.portal_enabled`, and the one BEFORE trigger is exactly that one.
    const rows = await getPlatformClient().$queryRaw<
      {
        tgname: string;
        row_level: boolean;
        before: boolean;
        on_update: boolean;
        events: number;
        enabled: string;
        on_switch_only: boolean;
      }[]
    >`
      SELECT t.tgname::text AS tgname,
             (t.tgtype::int & 1) = 1 AS row_level,
             (t.tgtype::int & 2) = 2 AS before,
             (t.tgtype::int & 16) = 16 AS on_update,
             (t.tgtype::int & 60) AS events,
             t.tgenabled::text AS enabled,
             t.tgattr::text = (SELECT a.attnum::text FROM pg_attribute a
                                WHERE a.attrelid = t.tgrelid AND a.attname = 'portal_enabled') AS on_switch_only
        FROM pg_trigger t
       WHERE t.tgrelid = 'project'::regclass AND NOT t.tgisinternal`;
    expect(
      rows.filter((r) => r.row_level && r.before && r.on_update).map((r) => r.tgname),
      "the one BEFORE UPDATE row trigger on project is the update schedule's stamp",
    ).toEqual(["project_update_schedule_stamp"]);
    expect(rows.map((r) => r.tgname).sort()).toEqual([
      "project_hours_sharing_fanout",
      "project_portal_enabled_fanout",
      "project_update_schedule_stamp",
      "search_feed_project",
    ]);
    // …and it is the only BEFORE trigger of any kind.
    expect(rows.filter((r) => r.before).map((r) => r.tgname)).toEqual(["project_update_schedule_stamp"]);
    // THE PREMISE BY MEANING: no BEFORE trigger's function on `project`
    // assigns NEW.portal_enabled (comments stripped by `bodyOf`).
    const beforeFns = await getPlatformClient().$queryRaw<{ fn: string }[]>`
      SELECT t.tgfoid::regproc::text AS fn
        FROM pg_trigger t
       WHERE t.tgrelid = 'project'::regclass AND NOT t.tgisinternal AND (t.tgtype::int & 2) = 2`;
    expect(beforeFns.map((r) => r.fn)).toEqual(["project_update_schedule_stamp"]);
    for (const { fn } of beforeFns) {
      const src = await bodyOf(fn);
      expect(src, `${fn} exists`).toMatch(/update_schedule_since/);
      expect(src, `${fn} never writes the switch`).not.toMatch(/NEW\s*\.\s*"?portal_enabled"?\s*:?=/i);
      // …nor the whole record, nor by `SELECT … INTO NEW…` (the re-check's nits).
      expect(src, `${fn} never assigns the whole record`).not.toMatch(/\bNEW\s*:?=/i);
      expect(src, `${fn} never selects into NEW`).not.toMatch(/\bINTO\s+(STRICT\s+)?NEW\b/i);
      // (Not a bare INSERT: the body compares `TG_OP = 'INSERT'`.)
      expect(src, `${fn} runs no statement of its own`).not.toMatch(
        /\b(INSERT\s+INTO|DELETE\s+FROM|PERFORM|EXECUTE)\b|\bUPDATE\s+\w+\s+SET\b/i,
      );
      // …and, closing the indirect ways (slice 102's security review): every
      // RETURN hands back NEW itself — never `jsonb_populate_record(NEW, …)`
      // or a copy — and every assignment is to one column of NEW other than
      // the switch, never to a record variable that could be returned.
      const returns = src.match(/\bRETURN\b[^;]*;/gi) ?? [];
      expect(returns.length, `${fn} returns`).toBeGreaterThan(0);
      for (const r of returns) expect(r.trim(), `${fn} returns NEW itself`).toMatch(/^RETURN\s+NEW\s*;$/i);
      const assigned = [...src.matchAll(/([\w."]+)\s*:=/g)].map((m) => m[1]!);
      for (const a of assigned) {
        expect(a, `${fn} assigns only a column of NEW, never the switch`).toMatch(/^NEW\.(?!"?portal_enabled\b)"?\w+"?$/i);
      }
    }
    // AND BY BEHAVIOUR, in a transaction that is rolled back: a project whose
    // every schedule column changes keeps its switch, and the switch itself
    // still moves only when it is written.
    const rollback = new Error("rollback");
    await getPlatformClient()
      .$transaction(
        async (tx) => {
          const clientId = randomUUID();
          const projectId = randomUUID();
          await tx.client.create({ data: { id: clientId, tenantId: A.id, name: "Trigger probe" } });
          await tx.project.create({
            data: { id: projectId, tenantId: A.id, clientId, key: "TPROBE", name: "Trigger probe", updateCadence: "WEEKLY" },
          });
          const sw = async () =>
            (await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { portalEnabled: true } })).portalEnabled;
          for (const data of [
            { updateCadence: "MONTHLY" as const },
            { updateWeekday: 2 },
            { status: "ACTIVE" as const },
            { updateScheduleSince: new Date(0) },
            { updateCadence: "NONE" as const },
          ]) {
            await tx.project.update({ where: { id: projectId }, data, select: { id: true } });
            expect(await sw(), `the switch after ${Object.keys(data)[0]}`).toBe(false);
          }
          await tx.project.update({ where: { id: projectId }, data: { portalEnabled: true }, select: { id: true } });
          expect(await sw()).toBe(true);
          throw rollback;
        },
        { timeout: 60_000 },
      )
      .catch((e: unknown) => {
        if (e !== rollback) throw e;
      });
    // THE FAN-OUT ITSELF, not only its name: a disabled (or replica-only)
    // fan-out keeps the name set above while the switch moves without
    // re-deriving a single child — and without the gate the fan-out tries.
    const fanout = rows.find((r) => r.tgname === "project_portal_enabled_fanout");
    expect(fanout, "the fan-out exists").toBeDefined();
    expect(fanout!.enabled, "the fan-out fires on every ordinary UPDATE (tgenabled 'O')").toBe("O");
    expect(fanout!.row_level && !fanout!.before, "AFTER … FOR EACH ROW").toBe(true);
    expect(fanout!.events, "UPDATE only (tgtype event bits)").toBe(16);
    expect(fanout!.on_switch_only, "UPDATE OF portal_enabled, and nothing else").toBe(true);
  });

  it("every stamped table carries exactly one deferred heal, firing on its stamp's own events", async () => {
    for (const t of STAMPED) {
      const rows = await getPlatformClient().$queryRaw<
        {
          tgname: string;
          events: number;
          row_after: boolean;
          attrs: string;
          deferrable: boolean;
          deferred: boolean;
          enabled: string;
          def: string;
        }[]
      >`
        SELECT t.tgname::text AS tgname,
               (t.tgtype::int & 60) AS events,
               ((t.tgtype::int & 1) = 1 AND (t.tgtype::int & 2) = 0) AS row_after,
               t.tgattr::text AS attrs,
               t.tgdeferrable AS deferrable, t.tginitdeferred AS deferred,
               t.tgenabled::text AS enabled,
               pg_get_triggerdef(t.oid) AS def
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ${t} AND NOT t.tgisinternal
           AND t.tgname IN (${`${t}_portal_heal`}, ${`${t}_stamp_portal_enabled`})`;
      const heals = rows.filter((r) => r.tgname === `${t}_portal_heal`);
      const stamp = rows.find((r) => r.tgname === `${t}_stamp_portal_enabled`);
      expect(heals, `${t}: exactly one heal`).toHaveLength(1);
      expect(stamp, `${t}: its stamp`).toBeDefined();
      const heal = heals[0]!;
      // At the writer's COMMIT, not at its statement.
      expect(heal.deferrable && heal.deferred, `${t}: DEFERRABLE INITIALLY DEFERRED`).toBe(true);
      expect(heal.row_after, `${t}: AFTER … FOR EACH ROW`).toBe(true);
      expect(heal.enabled, `${t}: enabled`).toBe("O");
      // Armed only by a fail-closed stamp of THIS transaction, and never
      // by the heal's own UPDATE (trigger depth 1).
      expect(heal.def).toContain("app.portal_in_doubt");
      expect(heal.def).toContain("pg_trigger_depth()");
      expect(heal.def).toContain("EXECUTE FUNCTION portal_heal_in_doubt()");
      // The same events and columns as the stamp it repairs.
      expect(heal.events, `${t}: the stamp's events`).toBe(stamp!.events);
      expect(heal.attrs, `${t}: the stamp's columns`).toBe(stamp!.attrs);
    }
  });

  it("the key helpers agree with the inline derivation the probes use — negative halves included", async () => {
    const platform = getPlatformClient();
    // One id for each sign combination of the two halves, FOUND rather than
    // hard-coded (1 in 4 each, from 256 candidates) — the low half is
    // sign-extended into int4, which is exactly where a probe's unsigned
    // mask and the helper could disagree.
    const rows = await platform.$queryRaw<
      { id: string; seed: number; hi_neg: boolean; lo_neg: boolean; hi_ok: boolean; lo_ok: boolean }[]
    >`
      WITH candidates AS (SELECT gen_random_uuid()::text AS id FROM generate_series(1, 256)),
      picked AS (
        SELECT DISTINCT ON (portal_gate_key_hi(id, 7401) < 0, portal_gate_key_lo(id, 7401) < 0) id
          FROM candidates
         ORDER BY portal_gate_key_hi(id, 7401) < 0, portal_gate_key_lo(id, 7401) < 0, id)
      SELECT picked.id, s.seed,
             portal_gate_key_hi(picked.id, s.seed) < 0 AS hi_neg,
             portal_gate_key_lo(picked.id, s.seed) < 0 AS lo_neg,
             (portal_gate_key_hi(picked.id, s.seed)::bigint & 4294967295)
               = ((hashtextextended(picked.id, s.seed) >> 32) & 4294967295) AS hi_ok,
             (portal_gate_key_lo(picked.id, s.seed)::bigint & 4294967295)
               = (hashtextextended(picked.id, s.seed) & 4294967295) AS lo_ok
        FROM picked CROSS JOIN (VALUES (7401), (7402)) AS s(seed)`;
    const gate = rows.filter((r) => r.seed === 7401);
    expect(new Set(gate.map((r) => `${r.hi_neg}/${r.lo_neg}`)).size, "every sign combination").toBe(4);
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.hi_ok, `${r.id}/${r.seed}: high half`).toBe(true);
      expect(r.lo_ok, `${r.id}/${r.seed}: low half`).toBe(true);
    }
    // And end to end: the lock the product's helpers take is the one the
    // inline probe finds, for an id whose halves are both negative.
    const negative = gate.find((r) => r.hi_neg && r.lo_neg)!;
    const seen = await platform.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(portal_gate_key_hi(${negative.id}, 7401), portal_gate_key_lo(${negative.id}, 7401))`;
      const [row] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND objsubid = 2 AND granted AND mode = 'ExclusiveLock'
           AND pid = pg_backend_pid()
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND classid::bigint = ((hashtextextended(${negative.id}::text, 7401) >> 32) & 4294967295)
           AND objid::bigint = (hashtextextended(${negative.id}::text, 7401) & 4294967295)`;
      return row?.n ?? 0;
    });
    expect(seen).toBe(1);
  });
});
