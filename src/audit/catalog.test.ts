import { describe, expect, it } from "vitest";

import { AUDIT_EVENTS, isAuditAction } from "./catalog";

describe("audit event catalog (DATA_MODEL.md §3.1)", () => {
  it("actions are entity.verb — dots, never colons (namespace law §1.3)", () => {
    for (const action of Object.keys(AUDIT_EVENTS)) {
      expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(action).not.toContain(":");
    }
  });

  it("impersonation and continuity events are tenant-visible (§7: not a backdoor)", () => {
    expect(AUDIT_EVENTS["impersonation.started"].visibility).toBe("TENANT");
    expect(AUDIT_EVENTS["impersonation.ended"].visibility).toBe("TENANT");
    expect(AUDIT_EVENTS["continuity_box.opened"].visibility).toBe("TENANT");
  });

  it("platform access to a tenant is mirrored into the tenant's own log", () => {
    expect(AUDIT_EVENTS["platform.tenant_access"]).toEqual({
      visibility: "PLATFORM",
      mirroredToTenant: true,
    });
    expect(AUDIT_EVENTS["entitlements.changed"].mirroredToTenant).toBe(true);
    expect(AUDIT_EVENTS["plan.changed"].mirroredToTenant).toBe(true);
  });

  it("every platform.* action is PLATFORM-visibility", () => {
    // The namespace and the visibility must not drift apart: a
    // `platform.*` action marked TENANT would be refused by
    // platformAuditRow() and accepted by record(), so it would end up
    // filed inside a tenant that can never read it. Pinned as a rule
    // rather than per-action, so it covers the ones added next.
    for (const [action, spec] of Object.entries(AUDIT_EVENTS)) {
      if (action.startsWith("platform.")) {
        expect(spec.visibility, `${action} must be PLATFORM`).toBe("PLATFORM");
      }
    }
  });

  it("the platform-plane auth events exist and are not mirrored", () => {
    // The console recorded nothing at all until 2026-09-11. Mirroring is
    // declared in the catalog type but implemented nowhere, so these must
    // stay unmirrored or platformAuditRow() will refuse them outright.
    for (const action of [
      "platform.login_succeeded",
      "platform.login_failed",
      "platform.mfa_verification_failed",
      "platform.mfa_enabled",
      "platform.mfa_disabled",
      "platform.password_changed",
      "platform.email_changed",
    ] as const) {
      expect(AUDIT_EVENTS[action]).toEqual({ visibility: "PLATFORM" });
    }
  });

  it("isAuditAction rejects unknown actions (record() fails closed)", () => {
    expect(isAuditAction("invoice.issued")).toBe(true);
    expect(isAuditAction("invoice:issued")).toBe(false);
    expect(isAuditAction("made.up_event")).toBe(false);
  });
});
