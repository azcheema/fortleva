import { describe, expect, it } from "vitest";

import { portalGateDecision, type PortalGateInput } from "./portal-gate";

/**
 * The portal admission matrix, with no database, no cookie and no
 * Better Auth — the sibling of platform-gate.test.ts and for the same
 * reason (see ./portal-gate.ts's header).
 *
 * The cases that earn their place are the ABSENT ones. Better Auth
 * returns `undefined` for any column an instance forgot to declare, so
 * "the field is missing" is not a hypothetical here — it is the failure
 * that made the ops console unreachable once already, and on this plane
 * the same slip would mean a session with no client scope.
 */

const ok: PortalGateInput = {
  hasSession: true,
  tenantId: "11111111-1111-1111-1111-111111111111",
  clientId: "22222222-2222-2222-2222-222222222222",
  portalStatus: "ACTIVE",
  emailVerified: true,
};

describe("portalGateDecision", () => {
  it("admits a complete, active, verified contact", () => {
    expect(portalGateDecision(ok)).toBe("ok");
  });

  it("denies with no session, and denies an EMPTY input", () => {
    expect(portalGateDecision({ ...ok, hasSession: false })).toBe("no_session");
    // A caller that forgets to pass anything must not get a pass.
    expect(portalGateDecision({})).toBe("no_session");
  });

  it("refuses a session missing its tenancy or its client — the additionalFields trap", () => {
    for (const missing of [{ tenantId: undefined }, { clientId: undefined }] as const) {
      expect(portalGateDecision({ ...ok, ...missing })).toBe("incomplete");
    }
    // null and "" are the same failure as undefined, not a different one.
    expect(portalGateDecision({ ...ok, tenantId: null })).toBe("incomplete");
    expect(portalGateDecision({ ...ok, clientId: "" })).toBe("incomplete");
  });

  it("checks completeness BEFORE status, so a wiring fault never reads as a policy denial", () => {
    // If this ordering flipped, a forgotten additionalField on a
    // SUSPENDED contact would report "not_active" — sending whoever
    // debugged it to the contact's record instead of to this file.
    expect(portalGateDecision({ ...ok, tenantId: undefined, portalStatus: "SUSPENDED" })).toBe(
      "incomplete",
    );
  });

  it("admits ONLY the literal ACTIVE", () => {
    for (const portalStatus of ["NO_ACCESS", "INVITED", "SUSPENDED", "REVOKED"]) {
      expect(portalGateDecision({ ...ok, portalStatus })).toBe("not_active");
    }
    // A value this code has never heard of — a new enum member added
    // without revisiting the gate — must deny, not pass.
    expect(portalGateDecision({ ...ok, portalStatus: "PROBATIONARY" })).toBe("not_active");
    // Case matters: nothing is normalised on the way in.
    expect(portalGateDecision({ ...ok, portalStatus: "active" })).toBe("not_active");
  });

  it("treats a missing status as incomplete rather than inactive", () => {
    expect(portalGateDecision({ ...ok, portalStatus: undefined })).toBe("incomplete");
    expect(portalGateDecision({ ...ok, portalStatus: null })).toBe("incomplete");
  });

  it("requires a verified email, and treats missing as unverified", () => {
    expect(portalGateDecision({ ...ok, emailVerified: false })).toBe("unverified");
    expect(portalGateDecision({ ...ok, emailVerified: undefined })).toBe("unverified");
    expect(portalGateDecision({ ...ok, emailVerified: null })).toBe("unverified");
  });

  it("never returns ok for anything but the exact positive case", () => {
    // A blunt sweep: every single-field degradation of `ok` denies.
    const degradations: PortalGateInput[] = [
      { ...ok, hasSession: undefined },
      { ...ok, tenantId: null },
      { ...ok, clientId: null },
      { ...ok, portalStatus: null },
      { ...ok, emailVerified: null },
    ];
    for (const input of degradations) {
      expect(portalGateDecision(input)).not.toBe("ok");
    }
  });
});
