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

  it("isAuditAction rejects unknown actions (record() fails closed)", () => {
    expect(isAuditAction("invoice.issued")).toBe(true);
    expect(isAuditAction("invoice:issued")).toBe(false);
    expect(isAuditAction("made.up_event")).toBe(false);
  });
});
