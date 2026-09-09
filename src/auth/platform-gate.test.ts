import { describe, expect, it } from "vitest";

import {
  platformGateDecision,
  type PlatformGate,
  type PlatformGateInput,
} from "./platform-gate";

/**
 * The platform-console admission matrix (SECURITY.md §3.5, AUTHZ.md §9).
 *
 * The plane behind this gate holds `app_platform`, a BYPASSRLS
 * cross-tenant role, and until 2026-09-09 the code checked a cookie, a
 * plane and a role and stopped — while two documents called MFA
 * "mandatory, no exceptions". These cases are the enforcement.
 *
 * The `undefined` rows are not padding. Better Auth returns `undefined`
 * for any column absent from an instance's declared table schema, which
 * is exactly how `platformRole` came back undefined on this plane and
 * denied every session; a future field that goes missing the same way
 * must keep DENYING rather than start passing.
 */

const base: PlatformGateInput = {
  hasSession: true,
  plane: "PLATFORM",
  platformRole: "SUPERADMIN",
  twoFactorEnabled: true,
  mfaVerifiedAt: new Date("2026-09-09T10:00:00Z"),
};

const gate = (over: Partial<PlatformGateInput>): PlatformGate =>
  platformGateDecision({ ...base, ...over });

describe("platformGateDecision", () => {
  it("admits a SUPERADMIN on the platform plane who presented a factor", () => {
    expect(gate({})).toBe("ok");
  });

  describe("session and plane", () => {
    it("denies when there is no session at all", () => {
      expect(gate({ hasSession: false })).toBe("no_session");
    });

    it("denies a MEMBER-plane session replayed at the console", () => {
      expect(gate({ plane: "MEMBER" })).toBe("no_session");
    });

    it("denies a PORTAL-plane session", () => {
      expect(gate({ plane: "PORTAL" })).toBe("no_session");
    });

    it("denies when the plane field is missing entirely", () => {
      expect(gate({ plane: null })).toBe("no_session");
    });
  });

  describe("platform role", () => {
    it("denies an ordinary member", () => {
      expect(gate({ platformRole: null })).toBe("not_superadmin");
    });

    it("denies any role that is not exactly SUPERADMIN", () => {
      expect(gate({ platformRole: "ADMIN" })).toBe("not_superadmin");
      expect(gate({ platformRole: "SUPPORT" })).toBe("not_superadmin");
      expect(gate({ platformRole: "superadmin" })).toBe("not_superadmin");
    });

    it("denies when platformRole is undefined — the shipped bug this slice fixed", () => {
      // The platform auth instance declared no user.additionalFields, so
      // Better Auth never copied platformRole off the row and EVERY
      // console session was denied here. Fixed at the source; pinned
      // here so the gate's own behaviour on a missing field stays deny.
      expect(gate({ platformRole: undefined })).toBe("not_superadmin");
    });
  });

  describe("second factor", () => {
    it("sends an unenrolled SUPERADMIN to enrol, not to a verify prompt", () => {
      // The distinction is the anti-lockout property: a sole operator
      // with no factor must be told to create one.
      expect(gate({ twoFactorEnabled: false })).toBe("not_enrolled");
    });

    it("denies when twoFactorEnabled is missing", () => {
      expect(gate({ twoFactorEnabled: undefined })).toBe("not_enrolled");
      expect(gate({ twoFactorEnabled: null })).toBe("not_enrolled");
    });

    it("denies an enrolled admin whose session was not born of a factor", () => {
      // Password-only or trusted-device sign-in: the stamp is written
      // only on the two verify paths (isFreshFactorPath).
      expect(gate({ mfaVerifiedAt: null })).toBe("unverified");
      expect(gate({ mfaVerifiedAt: undefined })).toBe("unverified");
    });

    it("accepts the stamp however the adapter hands it back", () => {
      expect(gate({ mfaVerifiedAt: "2026-09-09T10:00:00Z" })).toBe("ok");
    });
  });

  describe("ordering", () => {
    it("reports the EARLIEST failure, so no denial leaks a later fact", () => {
      // A stranger must not learn that an address is a SUPERADMIN, nor
      // whether that admin has enrolled, by reading which remedy they
      // are offered. No session outranks every other complaint.
      expect(
        platformGateDecision({
          hasSession: false,
          plane: "MEMBER",
          platformRole: null,
          twoFactorEnabled: false,
          mfaVerifiedAt: null,
        }),
      ).toBe("no_session");
      // Not a SUPERADMIN outranks the MFA complaints.
      expect(gate({ platformRole: null, twoFactorEnabled: false })).toBe("not_superadmin");
      // Not enrolled outranks not verified.
      expect(gate({ twoFactorEnabled: false, mfaVerifiedAt: null })).toBe("not_enrolled");
    });
  });

  it("never returns ok unless every condition holds", () => {
    const fields = [
      "hasSession",
      "plane",
      "platformRole",
      "twoFactorEnabled",
      "mfaVerifiedAt",
    ] as const satisfies readonly (keyof PlatformGateInput)[];
    for (const f of fields) {
      expect(gate({ [f]: undefined })).not.toBe("ok");
      expect(gate({ [f]: null } as Partial<PlatformGateInput>)).not.toBe("ok");
    }
  });
});
