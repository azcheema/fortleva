import { describe, expect, it } from "vitest";

import { platformAuditRow } from "./platform-record";

/**
 * The platform-plane row shape (SECURITY.md §7, DATA_MODEL.md §3).
 *
 * These rows are the only trace the ops console leaves, so the refusals
 * matter as much as the happy path: a platform event filed under a
 * tenant is invisible to the operator and visible to nobody else either,
 * and a tenant event filed with a null tenant is unreachable by the
 * tenant whose log it belongs in.
 */

describe("platformAuditRow", () => {
  it("files a console sign-in as a platform-plane row", () => {
    const row = platformAuditRow({
      action: "platform.login_succeeded",
      actorUserId: "user-1",
      targetType: "user",
      targetId: "user-1",
      metadata: { method: "totp", superadmin: true },
    });
    expect(row.tenantId).toBeNull();
    expect(row.visibility).toBe("PLATFORM");
    expect(row.actorType).toBe("PLATFORM_ADMIN");
    expect(row.actorId).toBe("user-1");
    expect(row.metadata).toEqual({ method: "totp", superadmin: true });
  });

  it("is SYSTEM with no actor when nobody authenticated", () => {
    // A failed console sign-in: there is a target, but no actor — the
    // same shape auth.login_failed uses on the member plane.
    for (const actorUserId of [undefined, null]) {
      const row = platformAuditRow({
        action: "platform.login_failed",
        actorUserId,
        targetType: "user",
        targetId: "user-1",
      });
      expect(row.actorType).toBe("SYSTEM");
      expect(row.actorId).toBeNull();
      expect(row.targetId).toBe("user-1");
    }
  });

  it("never lets tenantId or visibility be anything else", () => {
    // Both are the model rather than parameters, and neither is
    // reachable from the input type — pinned so a future field cannot
    // quietly make them settable.
    for (const action of [
      "platform.login_succeeded",
      "platform.login_failed",
      "platform.mfa_verification_failed",
      "platform.mfa_enabled",
      "platform.mfa_disabled",
      "platform.password_changed",
    ] as const) {
      const row = platformAuditRow({ action, actorUserId: "u" });
      expect(row.tenantId).toBeNull();
      expect(row.visibility).toBe("PLATFORM");
    }
  });

  it("refuses an action that is not in the catalog", () => {
    expect(() =>
      // @ts-expect-error — the catalog is the authority; this is the
      // runtime half of that guarantee.
      platformAuditRow({ action: "platform.not_a_real_event" }),
    ).toThrow(/unknown action/);
  });

  it("refuses a TENANT action — it belongs inside withTenant", () => {
    // The mirror of record()'s refusal pointing the other way. Without
    // it, a console hook could file `auth.login_succeeded` with a null
    // tenant, where the member whose log it belongs in can never see it.
    expect(() => platformAuditRow({ action: "auth.login_succeeded", actorUserId: "u" })).toThrow(
      /is a TENANT event/,
    );
    expect(() => platformAuditRow({ action: "work_item.created" })).toThrow(/is a TENANT event/);
  });

  it("refuses a MIRRORED action, because mirroring is not implemented", () => {
    // Writing only the platform half would look like DATA_MODEL §3.1's
    // promise had been kept. Nothing reads mirroredToTenant at runtime.
    expect(() => platformAuditRow({ action: "platform.tenant_access", actorUserId: "u" })).toThrow(
      /mirroring is not implemented/,
    );
  });

  it("carries request context when there is a request, nulls when there is not", () => {
    const bare = platformAuditRow({ action: "platform.login_failed" });
    expect(bare.requestId).toBeNull();
    expect(bare.ip).toBeNull();
    expect(bare.userAgent).toBeNull();

    const withReq = platformAuditRow(
      { action: "platform.login_failed" },
      { requestId: "req-1", ip: "203.0.113.7", userAgent: "curl/8" },
    );
    expect(withReq.requestId).toBe("req-1");
    expect(withReq.ip).toBe("203.0.113.7");
    expect(withReq.userAgent).toBe("curl/8");
  });
});
