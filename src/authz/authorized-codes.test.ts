import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TenantDb } from "@/db";

import {
  STEP_UP_WINDOW_MINUTES,
  authorizedCodes,
  isAuthorized,
  resolvePermissions,
  type MemberActor,
} from "./authorize";
import { PERMISSIONS } from "./catalog";

/**
 * `authorizedCodes` ANSWERS EACH CODE EXACTLY AS `isAuthorized` WOULD —
 * the promise every read that swapped a fan-out of `isAuthorized` legs
 * for one resolution rests on: the shell's nav, the inbox's subjects,
 * `/files`, a project's Time tab, the list and the item panel. Its
 * docblock said so and nothing checked it. `resolvePermissions` — the
 * same read for `/members` and `/settings/roles` — is held to the same
 * table, and its second answer, `afterStepUp`, to the definition its
 * type gives: a ✦ code refused NOW that a fresh factor would allow.
 * Pinned over the whole catalogue plus an unknown code, across every
 * posture the answer turns on: which codes are held, the second factor
 * and impersonation (view verbs only).
 *
 * The table compares against `isAuthorized`, which runs its own path
 * (`authorize`). If that is ever rebuilt on `resolvePermissions`, the
 * table proves nothing, and the absolute facts in the branch test below
 * are all that is left.
 */

const MEMBER = "member-1";
const ALL = PERMISSIONS.map((p) => p.code);
const STARRED = PERMISSIONS.filter((p) => p.requiresMfa).map((p) => p.code);
const UNKNOWN = "nothing:such";
const CODES = [...ALL, UNKNOWN];

/** A tx stub whose member holds `codes`, counting the reads of their roles. */
const txHolding = (codes: readonly string[]) => {
  let reads = 0;
  const tx = {
    memberRole: {
      findMany: async () => {
        reads += 1;
        return [{ role: { rolePermissions: codes.map((code) => ({ permission: { code } })) } }];
      },
    },
  } as unknown as TenantDb;
  return { tx, reads: () => reads };
};

const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000);

const FRESH_FACTOR = { enrolled: true, verifiedAt: minutesAgo(1) };
const STALE_FACTOR = { enrolled: true, verifiedAt: minutesAgo(STEP_UP_WINDOW_MINUTES + 1) };

const NO_FACTOR: MemberActor = { memberId: MEMBER, mfa: { enrolled: false, verifiedAt: null } };
const UNKNOWN_POSTURE: MemberActor = { memberId: MEMBER };
const STALE: MemberActor = { memberId: MEMBER, mfa: STALE_FACTOR };
const FRESH: MemberActor = { memberId: MEMBER, mfa: FRESH_FACTOR };
const IMPERSONATED: MemberActor = { ...FRESH, impersonated: true };
const IMPERSONATED_STALE: MemberActor = { ...STALE, impersonated: true };

const POSTURES: ReadonlyArray<readonly [string, MemberActor]> = [
  ["no second factor", NO_FACTOR],
  ["an unknown posture", UNKNOWN_POSTURE],
  ["a stale factor", STALE],
  ["a fresh factor", FRESH],
  ["impersonated, with a fresh factor", IMPERSONATED],
  ["impersonated, with a stale factor", IMPERSONATED_STALE],
];

const HOLDINGS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["every code", ALL],
  ["every other code", ALL.filter((_, i) => i % 2 === 0)],
  ["nothing", []],
  // A role row can still carry a code the catalogue no longer lists; it
  // is refused as a config error, never granted because it is held.
  ["every code and one the catalogue does not know", [...ALL, UNKNOWN]],
];

// An unknown code is a config error both paths LOG; the noise is
// expected here, and one test below checks it is still logged.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("one resolution answers each code as isAuthorized does", () => {
  for (const [holding, held] of HOLDINGS) {
    it.each(POSTURES)(`holding ${holding}, %s`, async (_, actor) => {
      const { tx } = txHolding(held);
      const allowed = new Set<string>();
      const afterStepUp = new Set<string>();
      for (const code of CODES) {
        if (await isAuthorized(tx, actor, code)) allowed.add(code);
        else if (await isAuthorized(tx, { ...actor, mfa: FRESH_FACTOR }, code)) afterStepUp.add(code);
      }
      expect(await authorizedCodes(tx, actor, CODES)).toEqual(allowed);
      expect(await resolvePermissions(tx, actor, CODES)).toEqual({ allowed, afterStepUp });
    });
  }

  it("the table reaches every branch it claims to", async () => {
    // Without this, a table in which every posture happened to answer
    // the same would pass while pinning nothing about ✦ or impersonation.
    const { tx } = txHolding(ALL);
    const fresh = await resolvePermissions(tx, FRESH, CODES);
    const stale = await resolvePermissions(tx, STALE, CODES);
    const impersonated = await resolvePermissions(tx, IMPERSONATED_STALE, CODES);

    expect(STARRED.length).toBeGreaterThan(0);
    expect(STARRED.filter((code) => !fresh.allowed.has(code))).toEqual([]);
    expect(fresh.afterStepUp.size).toBe(0);
    expect(STARRED.filter((code) => stale.allowed.has(code))).toEqual([]);
    expect(stale.allowed.size).toBe(ALL.length - STARRED.length);
    expect([...stale.afterStepUp].sort()).toEqual([...STARRED].sort());

    // Impersonation is view-only, and the step-up answer does not get
    // round it: an editor offered on `afterStepUp` stays hidden.
    const viewVerb = (code: string): boolean => /:(view|view_all)$/.test(code);
    expect(impersonated.allowed.size).toBeGreaterThan(0);
    expect([...impersonated.allowed].filter((code) => !viewVerb(code))).toEqual([]);
    expect([...impersonated.afterStepUp].filter((code) => !viewVerb(code))).toEqual([]);
    expect(impersonated.afterStepUp.has("member:manage_roles")).toBe(false);
    expect(impersonated.afterStepUp.has("role:edit")).toBe(false);

    expect(fresh.allowed.has(UNKNOWN)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(UNKNOWN));
  });
});

describe("one resolution, however many codes", () => {
  it("authorizedCodes reads the member's roles once", async () => {
    const { tx, reads } = txHolding(ALL);
    await authorizedCodes(tx, FRESH, CODES);
    expect(reads()).toBe(1);
  });

  it("resolvePermissions reads them once for both answers", async () => {
    const { tx, reads } = txHolding(ALL);
    await resolvePermissions(tx, STALE, CODES);
    expect(reads()).toBe(1);
  });
});
