import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.hoisted(() => vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
}));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

import { AuthzError } from "./errors";
import { handleAuthzRedirect, mfaRedirectTarget, safeNextPath } from "./redirects";

describe("MFA_REQUIRED → navigation (AUTHZ.md §7.5 deferred denial)", () => {
  it("step_up goes to the step-up page carrying next", () => {
    expect(mfaRedirectTarget(new AuthzError("MFA_REQUIRED", "step_up"), "/members?x=1")).toBe(
      "/account/step-up?next=%2Fmembers%3Fx%3D1",
    );
  });

  it("enrol goes to the account page with a notice", () => {
    expect(mfaRedirectTarget(new AuthzError("MFA_REQUIRED", "enrol"), "/members")).toBe(
      "/account?notice=mfa_required&next=%2Fmembers",
    );
  });

  it("other denials and non-authz errors are not translated", () => {
    expect(mfaRedirectTarget(new AuthzError("FORBIDDEN"), "/x")).toBeNull();
    expect(mfaRedirectTarget(new AuthzError("NOT_FOUND"), "/x")).toBeNull();
    expect(mfaRedirectTarget(new Error("boom"), "/x")).toBeNull();
  });

  it("handleAuthzRedirect redirects only for MFA_REQUIRED and returns otherwise", () => {
    expect(() => handleAuthzRedirect(new AuthzError("MFA_REQUIRED", "step_up"), "/members")).toThrow(
      "NEXT_REDIRECT:/account/step-up?next=%2Fmembers",
    );
    expect(() => handleAuthzRedirect(new AuthzError("FORBIDDEN"), "/members")).not.toThrow();
    expect(redirectMock).toHaveBeenCalledTimes(1);
  });

  it("never open-redirects: only same-origin absolute paths survive", () => {
    expect(safeNextPath("https://evil.example/")).toBe("/dashboard");
    expect(safeNextPath("//evil.example/")).toBe("/dashboard");
    expect(safeNextPath("/\\evil.example")).toBe("/dashboard");
    expect(safeNextPath(null)).toBe("/dashboard");
    expect(safeNextPath("/members")).toBe("/members");
    expect(safeNextPath("/tasks?item=WEB-3&person=me")).toBe("/tasks?item=WEB-3&person=me");
  });

  it("refuses what a URL parser turns into another origin — a tab, a newline, a backslash inside, a `..` (slice 137)", () => {
    // The WHATWG parser drops tabs and newlines, so `/\t/evil.example` is
    // `//evil.example`: the step-up page's `next` sent a member off-site.
    for (const next of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/ /evil.example", "/a\\..\\b", "/x/../../evil", "/\u0000/x"]) {
      expect(safeNextPath(next), JSON.stringify(next)).toBe("/dashboard");
      expect(mfaRedirectTarget(new AuthzError("MFA_REQUIRED", "step_up"), next)).toBe("/account/step-up?next=%2Fdashboard");
    }
  });
});
