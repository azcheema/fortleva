import { describe, expect, it } from "vitest";

import type { TenantDb } from "@/db";

import { STEP_UP_WINDOW_MINUTES, authorize, requireRecentMfa, type MemberActor } from "./authorize";
import { PERMISSIONS } from "./catalog";
import { AuthzError } from "./errors";

/**
 * MFA deny-matrix (AUTHZ.md §7.5, SECURITY.md §3.5): every ✦ code ×
 * {not enrolled, enrolled but stale, fresh}; every non-✦ code never
 * asks. Regenerated from the catalog — grows with the ✦ set.
 */

const MEMBER = "member-1";

/** A tx stub whose memberRole query returns one role holding `codes`. */
const txHolding = (codes: readonly string[]): TenantDb =>
  ({
    memberRole: {
      findMany: async () => [
        {
          role: {
            rolePermissions: codes.map((code) => ({ permission: { code } })),
          },
        },
      ],
    },
  }) as unknown as TenantDb;

const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000);

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AuthzError) return `${e.reason}:${e.detail ?? ""}`;
    throw e;
  }
};

const STARRED = PERMISSIONS.filter((p) => p.requiresMfa).map((p) => p.code);
const PLAIN = PERMISSIONS.filter((p) => !p.requiresMfa).map((p) => p.code);

describe("authorize(): ✦ codes require enrolled + recent MFA", () => {
  const tx = txHolding(PERMISSIONS.map((p) => p.code));

  it("the ✦ set is non-empty (matrix is meaningful)", () => {
    expect(STARRED.length).toBeGreaterThan(0);
  });

  it.each(STARRED)("%s: no enrolment → MFA_REQUIRED/enrol", async (code) => {
    const actor: MemberActor = { memberId: MEMBER, mfa: { enrolled: false, verifiedAt: null } };
    expect(await reasonOf(authorize(tx, actor, code))).toBe("MFA_REQUIRED:enrol");
    // Unknown posture is treated as not enrolled (fail closed).
    expect(await reasonOf(authorize(tx, { memberId: MEMBER }, code))).toBe("MFA_REQUIRED:enrol");
  });

  it.each(STARRED)("%s: enrolled but stale/absent factor → MFA_REQUIRED/step_up", async (code) => {
    const stale: MemberActor = {
      memberId: MEMBER,
      mfa: { enrolled: true, verifiedAt: minutesAgo(STEP_UP_WINDOW_MINUTES + 1) },
    };
    expect(await reasonOf(authorize(tx, stale, code))).toBe("MFA_REQUIRED:step_up");
    const never: MemberActor = { memberId: MEMBER, mfa: { enrolled: true, verifiedAt: null } };
    expect(await reasonOf(authorize(tx, never, code))).toBe("MFA_REQUIRED:step_up");
  });

  it.each(STARRED)("%s: enrolled + fresh factor → ok", async (code) => {
    const fresh: MemberActor = { memberId: MEMBER, mfa: { enrolled: true, verifiedAt: minutesAgo(1) } };
    expect(await reasonOf(authorize(tx, fresh, code))).toBe("ok");
  });

  it.each(PLAIN)("%s: non-✦ never asks for MFA", async (code) => {
    expect(await reasonOf(authorize(tx, { memberId: MEMBER }, code))).toBe("ok");
    const stale: MemberActor = { memberId: MEMBER, mfa: { enrolled: false, verifiedAt: null } };
    expect(await reasonOf(authorize(tx, stale, code))).toBe("ok");
  });

  it("permission is checked BEFORE MFA: a non-holder gets FORBIDDEN, not MFA_REQUIRED", async () => {
    const none = txHolding([]);
    const actor: MemberActor = { memberId: MEMBER, mfa: { enrolled: false, verifiedAt: null } };
    expect(await reasonOf(authorize(none, actor, STARRED[0]!))).toBe("FORBIDDEN:");
  });
});

describe("requireRecentMfa(actor, minutes) — custom sudo windows", () => {
  it("honours the caller's window rather than the default", async () => {
    const actor: MemberActor = { memberId: MEMBER, mfa: { enrolled: true, verifiedAt: minutesAgo(8) } };
    expect(await reasonOf(requireRecentMfa(actor, 10))).toBe("ok");
    expect(await reasonOf(requireRecentMfa(actor, 5))).toBe("MFA_REQUIRED:step_up");
  });

  it("enrolment beats freshness in the reason", async () => {
    const actor: MemberActor = { memberId: MEMBER, mfa: { enrolled: false, verifiedAt: minutesAgo(1) } };
    expect(await reasonOf(requireRecentMfa(actor, 10))).toBe("MFA_REQUIRED:enrol");
  });

  it("exposes the remedy on the error for the UI", async () => {
    try {
      await requireRecentMfa({ memberId: MEMBER, mfa: { enrolled: true, verifiedAt: null } }, 10);
    } catch (e) {
      expect(e).toBeInstanceOf(AuthzError);
      expect((e as AuthzError).mfaRemedy).toBe("step_up");
    }
  });
});
