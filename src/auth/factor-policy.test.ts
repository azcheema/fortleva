import { describe, expect, it } from "vitest";

import {
  REISSUE_WINDOW_MS,
  SESSION_VERIFY_PATHS,
  factorMutationVerdict,
  sessionVerifyVerdict,
  type FactorPolicyInput,
  type FactorVerdict,
} from "./factor-policy";

/**
 * What a password holder may do to a second factor (SECURITY.md §3.5).
 *
 * This is the rule standing between "someone learned the password" and
 * "someone owns the account's second factor" — the operator's, whose
 * plane reaches `app_platform`, a BYPASSRLS cross-tenant role, and since
 * slice 83 every member's, whose factor is what each ✦ step-up checks
 * (the vault's reveal among them). So the matrix is exhaustive rather
 * than representative, and it holds for every account alike.
 */

const NOW = Date.parse("2026-09-10T12:00:00Z");

const base: FactorPolicyInput = {
  path: "/two-factor/enable",
  hasSession: true,
  hasVerifiedFactor: false,
  mfaVerifiedAt: null,
  now: NOW,
};

const verdict = (over: Partial<FactorPolicyInput>): FactorVerdict =>
  factorMutationVerdict({ ...base, ...over });

const ALL_GUARDED = [
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/generate-backup-codes",
] as const;

describe("factorMutationVerdict", () => {
  it("ignores paths it does not guard", () => {
    expect(verdict({ path: "/sign-in/email" })).toBe("allow");
    expect(verdict({ path: "/two-factor/verify-totp" })).toBe("allow");
    // Prefix confusion must not open the gate.
    expect(verdict({ path: "/two-factor/enable-something" })).toBe("allow");
  });

  it("opens no path to an enrolled account on a session and the password alone", () => {
    // Slice 83's case, for every account: no proof of the factor, no
    // marker — the shape a stolen session plus a phished password has.
    // Members used to get "allow" on all four here.
    for (const path of ALL_GUARDED) {
      expect(verdict({ path, hasVerifiedFactor: true })).not.toBe("allow");
    }
  });

  it("denies every guarded path without a readable session", () => {
    for (const path of ALL_GUARDED) {
      expect(verdict({ path, hasSession: false })).toBe("no_session");
      expect(verdict({ path, hasSession: undefined })).toBe("no_session");
    }
  });

  describe("the frozen endpoints", () => {
    it("never lets anyone disable or reveal the factor", () => {
      // Both hand the account over outright: one removes the factor, the
      // other returns the secret. No proof makes them acceptable.
      const fresh = new Date(NOW - 1_000);
      expect(verdict({ path: "/two-factor/disable" })).toBe("frozen");
      expect(verdict({ path: "/two-factor/disable", mfaVerifiedAt: fresh })).toBe("frozen");
      expect(verdict({ path: "/two-factor/get-totp-uri" })).toBe("frozen");
      expect(verdict({ path: "/two-factor/get-totp-uri", mfaVerifiedAt: fresh })).toBe("frozen");
    });
  });

  describe("enable", () => {
    it("permits the first enrolment — the documented bootstrap window", () => {
      expect(verdict({ hasVerifiedFactor: false })).toBe("allow");
    });

    it("refuses to replace a factor that already exists", () => {
      // Better Auth would delete the secret and backup codes and recreate
      // the row as verified: a silent swap with no proof of possession.
      expect(verdict({ hasVerifiedFactor: true })).toBe("already_enrolled");
      // A fresh stamp must not buy a replacement either.
      expect(verdict({ hasVerifiedFactor: true, mfaVerifiedAt: new Date(NOW) })).toBe(
        "already_enrolled",
      );
    });
  });

  describe("reissuing backup codes", () => {
    // The reissue action opens the process-local marker; a request
    // cannot. Every case below carries it EXCEPT the ones testing its
    // absence, which is the load-bearing condition.
    const reissue = (over: Partial<FactorPolicyInput>) =>
      verdict({
        path: "/two-factor/generate-backup-codes",
        hasReissueIntent: true,
        ...over,
      });

    it("refuses it to a raw request even with a perfectly fresh stamp", () => {
      // THE case this rule exists for: every member-plane step-up writes
      // mfaVerifiedAt, so a stolen member cookie plus the password would
      // otherwise reissue inside the window of an unrelated step-up —
      // the weak plane minting the strong plane's second factors.
      expect(
        verdict({
          path: "/two-factor/generate-backup-codes",
          hasReissueIntent: false,
          mfaVerifiedAt: new Date(NOW),
        }),
      ).toBe("needs_recent_factor");
      expect(
        verdict({
          path: "/two-factor/generate-backup-codes",
          mfaVerifiedAt: new Date(NOW),
        }),
      ).toBe("needs_recent_factor");
    });

    it("allows it on proof the current factor was just presented", () => {
      expect(reissue({ mfaVerifiedAt: new Date(NOW) })).toBe("allow");
      expect(reissue({ mfaVerifiedAt: new Date(NOW - REISSUE_WINDOW_MS + 1_000) })).toBe("allow");
      // However the adapter hands the column back.
      expect(reissue({ mfaVerifiedAt: "2026-09-10T12:00:00Z" })).toBe("allow");
    });

    it("refuses it on a password alone", () => {
      // The whole point: a password thief must not be able to mint
      // themselves a permanent set of second factors. Even holding the
      // marker, no stamp means no proof.
      expect(reissue({ mfaVerifiedAt: null })).toBe("needs_recent_factor");
      expect(reissue({ mfaVerifiedAt: undefined })).toBe("needs_recent_factor");
    });

    it("refuses a stale stamp", () => {
      expect(reissue({ mfaVerifiedAt: new Date(NOW - REISSUE_WINDOW_MS - 1) })).toBe(
        "needs_recent_factor",
      );
      expect(reissue({ mfaVerifiedAt: new Date(NOW - 60 * 60_000) })).toBe("needs_recent_factor");
    });

    it("refuses a stamp from the future and an unparseable one", () => {
      // A clock problem is not proof, and neither is a garbage value.
      expect(reissue({ mfaVerifiedAt: new Date(NOW + 60_000) })).toBe("needs_recent_factor");
      expect(reissue({ mfaVerifiedAt: "not a date" })).toBe("needs_recent_factor");
    });

    it("is exactly at the boundary, not approximately", () => {
      expect(reissue({ mfaVerifiedAt: new Date(NOW - REISSUE_WINDOW_MS) })).toBe("allow");
      expect(reissue({ mfaVerifiedAt: new Date(NOW - REISSUE_WINDOW_MS - 1) })).toBe(
        "needs_recent_factor",
      );
    });
  });

  it("never answers allow on a missing input", () => {
    // Every optional field absent at once: the shape a caller gets wrong.
    for (const path of ALL_GUARDED) {
      const v = factorMutationVerdict({ path, now: NOW });
      expect(v).toBe("no_session");
      // …and with a session but nothing else (code review, slice 83): an
      // `enable` whose caller forgot to ask whether a factor exists is
      // answered as if one did.
      expect(factorMutationVerdict({ path, hasSession: true, now: NOW })).not.toBe("allow");
    }
  });
});

describe("sessionVerifyVerdict — a code checked against a live session", () => {
  it("lets only the product's own step-up check an enrolled factor", () => {
    // The security review's medium: with a session, Better Auth counts no
    // attempts, so an unmarked check is a stolen session guessing codes.
    expect(sessionVerifyVerdict({ enrolled: true, hasStepUpIntent: false })).toBe("step_up_only");
    expect(sessionVerifyVerdict({ enrolled: true, hasStepUpIntent: true })).toBe("allow");
  });

  it("puts a first enrolment's confirmation under the member's daily cap", () => {
    // The one legitimate HTTP caller: /account's and /ops/login's ramp.
    expect(sessionVerifyVerdict({ enrolled: false, hasStepUpIntent: false })).toBe("budget");
  });

  it("guards exactly the two code checks", () => {
    expect([...SESSION_VERIFY_PATHS].sort()).toEqual(["/two-factor/verify-backup-code", "/two-factor/verify-totp"]);
    // The mutations are the other rule's; no path is in both.
    for (const path of ALL_GUARDED) expect(SESSION_VERIFY_PATHS.has(path)).toBe(false);
  });
});
