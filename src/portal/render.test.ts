import { describe, expect, it, vi } from "vitest";

import { AuthzError, type DenialReason } from "@/authz/errors";

import { portalReadOrNull } from "./render";

/**
 * The portal's HTTP surface must render every denial identically (PLAN
 * §0, "what slice 3 inherits"). This is the whole of the mechanism that
 * makes that true, so it is worth a test that walks every reason rather
 * than one that walks the two a page happens to produce today: a reason
 * added later must land here, not in a page's `switch`.
 */
const REASONS: DenialReason[] = [
  "FEATURE_DISABLED",
  "NOT_ENTITLED",
  "DISABLED_BY_TENANT",
  "FORBIDDEN",
  "NOT_FOUND",
  "MFA_REQUIRED",
];

describe("portalReadOrNull", () => {
  it("passes a successful read through untouched", async () => {
    await expect(portalReadOrNull("t", async () => ({ n: 1 }))).resolves.toEqual({ n: 1 });
  });

  it("answers null for EVERY denial reason — the reasons are internal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const reason of REASONS) {
        await expect(
          portalReadOrNull("t", () => Promise.reject(new AuthzError(reason, "detail"))),
        ).resolves.toBeNull();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("puts the reason in the SERVER log, which is where it belongs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await portalReadOrNull("listPortalTasks", () =>
        Promise.reject(new AuthzError("NOT_ENTITLED", "work")),
      );
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain("listPortalTasks");
      expect(line).toContain("NOT_ENTITLED");
    } finally {
      warn.mockRestore();
    }
  });

  it("re-throws anything that is NOT an authorization denial", async () => {
    // A page that renders "nothing shared yet" because the database is
    // down has told the client something false about their agency.
    await expect(
      portalReadOrNull("t", () => Promise.reject(new Error("connection reset"))),
    ).rejects.toThrow("connection reset");
  });
});
