import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RAIL_CODES } from "@/app/(tenant)/(authed)/nav";
import { STEP_UP_WINDOW_MINUTES, type MemberActor } from "@/authz/authorize";
import { MODULES, PERMISSIONS } from "@/authz/catalog";
import type { TenantDb } from "@/db";

import { accessibleCodes, hasAccess } from "./resolver";

/**
 * `accessibleCodes` ANSWERS EACH CODE EXACTLY AS `hasAccess` WOULD — all
 * four gates, for many codes, from four reads. The member shell's rail is
 * drawn from it (UI.md §3.1: a module-gated item is hidden when the
 * entitlement or preference is off), so every module state that can close
 * a module is walked here — killed by the flag, left out of the plan,
 * switched off by the tenant, a tenant override either way — and three
 * that must not (another tenant's rows, preference values other than a
 * literal false, unparseable entitlements), beside the permission
 * postures. One world is here for PARITY only: a tenant row that cannot
 * be read. Both paths answer it everything-on today, and that is a
 * fail-open neither should be held to — `src/portal/module-gates.ts`
 * closes it for the portal — so only their agreement is asserted.
 *
 * TWO KINDS OF ASSERTION, because one cannot see what the other can. The
 * equivalence table catches `accessibleCodes` WIRING the gates wrongly;
 * it cannot see a change to a rule both sides share (`flagOn`,
 * `preferenceOn`, `parseEntitlements` — which also decide every
 * `requireAccess` in the product), because such a change moves both
 * answers together. The absolute checks below pin those rules to what
 * they must say.
 *
 * The stub behaves like Prisma where it matters here: it honours the
 * `where` it is given (a key, a key list, a tenant), and a filter the
 * caller LEAVES OUT filters nothing — a read that forgot its tenant gets
 * every tenant's rows. It does not model RLS, which would hide the other
 * tenant's rows in production anyway. And it RECORDS overlapping reads,
 * which the `reads` test refuses: one connection, one statement at a
 * time — the module gates' reads must be sequential, because the tenant
 * read fails OPEN if it loses a race.
 */

const TENANT = "tenant-1";
const OTHER = "tenant-2";
const MEMBER = "member-1";
const ALL = PERMISSIONS.map((p) => p.code);
const CODES = [...ALL, "nothing:such"];
const GATED_MODULES = MODULES.filter((m) => m !== "core");

type Flag = { key: string; defaultOn: boolean; tenantOverrides: unknown };
type Preference = { tenantId: string; key: string; value: unknown };
type World = {
  readonly flags: readonly Flag[];
  readonly entitlements: unknown;
  readonly preferences: readonly Preference[];
  /** False when the tenant row cannot be read at all. */
  readonly tenantRow?: boolean;
};

type Where = { key?: string | { in: string[] }; tenantId?: string };
const keyMatches = (key: string, where: Where): boolean =>
  where.key === undefined || (typeof where.key === "string" ? where.key === key : where.key.in.includes(key));
const tenantMatches = (tenantId: string, where: Where): boolean =>
  where.tenantId === undefined || where.tenantId === tenantId;

/** An in-memory tenant: `held` are the member's codes, `world` its module state. */
const txFor = (held: readonly string[], world: World) => {
  const reads: string[] = [];
  let inFlight = 0;
  let overlapped = false;
  const read = async <T>(name: string, answer: () => T): Promise<T> => {
    reads.push(name);
    inFlight += 1;
    if (inFlight > 1) overlapped = true;
    // Yield twice, so a read started beside this one is in flight with it.
    await Promise.resolve();
    await Promise.resolve();
    inFlight -= 1;
    return answer();
  };
  const tx = {
    memberRole: {
      findMany: () =>
        read("roles", () => [{ role: { rolePermissions: held.map((code) => ({ permission: { code } })) } }]),
    },
    featureFlag: {
      findFirst: ({ where }: { where: Where }) =>
        read("flag", () => world.flags.find((f) => keyMatches(f.key, where)) ?? null),
      findMany: ({ where }: { where: Where }) =>
        read("flags", () => world.flags.filter((f) => keyMatches(f.key, where))),
    },
    tenant: {
      findFirst: ({ where }: { where: { id: string } }) =>
        read("tenant", () =>
          where.id === TENANT && world.tenantRow !== false ? { entitlements: world.entitlements } : null,
        ),
    },
    tenantPreference: {
      findFirst: ({ where }: { where: Where }) =>
        read(
          "preference",
          () => world.preferences.find((p) => tenantMatches(p.tenantId, where) && keyMatches(p.key, where)) ?? null,
        ),
      findMany: ({ where }: { where: Where }) =>
        read("preferences", () =>
          world.preferences.filter((p) => tenantMatches(p.tenantId, where) && keyMatches(p.key, where)),
        ),
    },
  } as unknown as TenantDb;
  return { tx, reads, overlapped: () => overlapped };
};

const OPEN: World = { flags: [], entitlements: {}, preferences: [] };
const flag = (module: string, defaultOn: boolean, tenantOverrides: unknown = null): Flag => ({
  key: `module.${module}`,
  defaultOn,
  tenantOverrides,
});
const preference = (module: string, value: unknown, tenantId = TENANT): Preference => ({
  tenantId,
  key: `module.${module}.enabled`,
  value,
});

const CLOSING_WORLDS: ReadonlyArray<readonly [string, World]> = GATED_MODULES.flatMap(
  (m): Array<readonly [string, World]> => [
    [`${m} killed by its flag`, { ...OPEN, flags: [flag(m, false)] }],
    [`${m} left out of the plan`, { ...OPEN, entitlements: { modules: { [m]: false } } }],
    [`${m} switched off by the tenant`, { ...OPEN, preferences: [preference(m, false)] }],
  ],
);

const OVERRIDE_ON: World = { ...OPEN, flags: [flag("time", false, { [TENANT]: true })] };
const OVERRIDE_OFF: World = { ...OPEN, flags: [flag("work", true, { [TENANT]: false })] };
const OTHER_TENANT: World = {
  ...OPEN,
  flags: [flag("documentation", true, { [OTHER]: false })],
  preferences: [preference("time", false, OTHER)],
};
const NOT_FALSE: World = {
  ...OPEN,
  preferences: [preference("work", "false"), preference("time", true), preference("documentation", null)],
};
const UNPARSEABLE: World = { ...OPEN, entitlements: "not-json-shaped" };
const NO_TENANT_ROW: World = { ...OPEN, tenantRow: false };

const WORLDS: ReadonlyArray<readonly [string, World]> = [
  ["everything open (no rows at all)", OPEN],
  ...CLOSING_WORLDS,
  ["a flag off by default but overridden ON for this tenant", OVERRIDE_ON],
  ["a flag on by default but overridden OFF for this tenant", OVERRIDE_OFF],
  ["another tenant's override and preference change nothing", OTHER_TENANT],
  ["a preference that is anything but false leaves the module on", NOT_FALSE],
  ["unparseable entitlements fall back to everything on", UNPARSEABLE],
  ["a tenant row that cannot be read — parity only, not a promise", NO_TENANT_ROW],
];

const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000);
const FRESH: MemberActor = { memberId: MEMBER, mfa: { enrolled: true, verifiedAt: minutesAgo(1) } };
const POSTURES: ReadonlyArray<readonly [string, MemberActor]> = [
  ["no second factor", { memberId: MEMBER, mfa: { enrolled: false, verifiedAt: null } }],
  ["a stale factor", { memberId: MEMBER, mfa: { enrolled: true, verifiedAt: minutesAgo(STEP_UP_WINDOW_MINUTES + 1) } }],
  ["a fresh factor", FRESH],
  ["impersonated", { ...FRESH, impersonated: true }],
];
const HOLDINGS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["every code", ALL],
  ["every other code", ALL.filter((_, i) => i % 2 === 1)],
];

const codesOf = (module: string): string[] => PERMISSIONS.filter((p) => p.module === module).map((p) => p.code);
const answer = (world: World) => accessibleCodes(txFor(ALL, world).tx, TENANT, FRESH, CODES);

// The unknown code is a config error `authorizedCodes` logs.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(POSTURES)("accessibleCodes answers each code as hasAccess does — %s", (_, actor) => {
  it.each(WORLDS)("%s", async (_world, world) => {
    for (const [, held] of HOLDINGS) {
      const { tx } = txFor(held, world);
      const expected = new Set<string>();
      for (const code of CODES) {
        if (await hasAccess(tx, TENANT, actor, code)) expected.add(code);
      }
      expect(await accessibleCodes(tx, TENANT, actor, CODES)).toEqual(expected);
    }
  });
});

describe("the rules themselves — what the table cannot see", () => {
  it("each way of closing a module takes that module's codes away, and only those", async () => {
    // Without this, a table in which no world closed anything would pass
    // while pinning nothing about gates 1–3.
    for (const [name, world] of CLOSING_WORLDS) {
      const closed = name.split(" ")[0]!;
      const got = await answer(world);
      expect(codesOf(closed).filter((c) => got.has(c)), name).toEqual([]);
      expect(ALL.length - got.size, name).toBe(codesOf(closed).length);
    }
  });

  it("a tenant override beats the flag's default, both ways", async () => {
    expect((await answer(OVERRIDE_ON)).has("time:track")).toBe(true);
    expect((await answer(OVERRIDE_OFF)).has("work_item:view")).toBe(false);
  });

  it("another tenant's override and preference close nothing here", async () => {
    const got = await answer(OTHER_TENANT);
    expect(got.has("document:view") && got.has("time:track")).toBe(true);
  });

  it("only a literal false switches a module off — not \"false\", not true, not null", async () => {
    const got = await answer(NOT_FALSE);
    expect(got.has("work_item:view") && got.has("time:track") && got.has("document:view")).toBe(true);
  });

  it("unparseable entitlements leave every module on — `parseEntitlements`' documented fallback", async () => {
    // Deliberately NOT asserted for `NO_TENANT_ROW`: that answer is a
    // fail-open, pinned above only as agreement between the two paths, so
    // closing it later is a hardening and not a regression.
    expect((await answer(UNPARSEABLE)).size).toBe(ALL.length);
  });
});

describe("reads", () => {
  it("four, one at a time, whatever the number of codes or modules", async () => {
    const { tx, reads, overlapped } = txFor(ALL, OPEN);
    await accessibleCodes(tx, TENANT, FRESH, CODES);
    expect(reads).toEqual(["roles", "flags", "tenant", "preferences"]);
    expect(overlapped()).toBe(false);
  });

  it("only the roles when nothing held needs a module gate", async () => {
    const { tx, reads } = txFor(codesOf("core"), OPEN);
    await accessibleCodes(tx, TENANT, FRESH, CODES);
    expect(reads).toEqual(["roles"]);
  });

  it("the stub can see overlapping reads at all", async () => {
    // Without this, `overlapped()` could be false because the stub never
    // interleaves, and the sequence assertion above would prove nothing.
    const { tx, overlapped } = txFor(ALL, OPEN);
    await Promise.all([hasAccess(tx, TENANT, FRESH, "time:track"), hasAccess(tx, TENANT, FRESH, "work_item:view")]);
    expect(overlapped()).toBe(true);
  });
});

describe("the rail", () => {
  it("asks no ✦ code — `accessibleCodes`, like `hasAccess`, would hide one from a holder who has not stepped up", () => {
    const starred = new Set(PERMISSIONS.filter((p) => p.requiresMfa).map((p) => p.code));
    expect(RAIL_CODES.filter((code) => starred.has(code))).toEqual([]);
  });

  it("is drawn from accessibleCodes over RAIL_CODES — a tripwire against a revert to the permission gate alone", () => {
    const layout = readFileSync(join(process.cwd(), "src", "app", "(tenant)", "(authed)", "layout.tsx"), "utf8");
    expect(layout).toContain("accessibleCodes(tx, membership.tenantId, actor, RAIL_CODES)");
    expect(layout).not.toMatch(/\b(authorizedCodes|resolvePermissions|isAuthorized|hasAccess)\(/);
  });
});
