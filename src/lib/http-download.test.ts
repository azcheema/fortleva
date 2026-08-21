import { describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { DomainError } from "@/lib/domain-error";

import { attachmentDisposition, badRequest, crossSiteRefusal, csvResponse, downloadFailure } from "./http-download";

/**
 * The download plumbing every CSV route shares (SECURITY.md §5, ARC-25):
 * attachment + no-store + nosniff on success; a denial maps to a
 * bodiless 404 (scope) / 403 (permission) — never a reason the caller
 * can read; a domain error is a 400 with one word; MFA_REQUIRED becomes
 * navigation (Next's redirect throws); anything else propagates; a
 * cross-site initiator is refused before any work.
 */
describe("http-download — the CSV route plumbing", () => {
  it("csvResponse: text/csv attachment with the RFC 6266 name, never cached, never sniffed", async () => {
    const res = csvResponse("a,b\r\n1,2\r\n", "time-entries-2026-08-01-2026-08-31.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      "attachment; filename=\"time-entries-2026-08-01-2026-08-31.csv\"; filename*=UTF-8''time-entries-2026-08-01-2026-08-31.csv",
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("a,b\r\n1,2\r\n");
  });

  it("attachmentDisposition: quotes, backslashes and non-ASCII never reach the header verbatim", () => {
    const d = attachmentDisposition('Åsa "Ö" \\ x.csv');
    expect(d.startsWith('attachment; filename="_sa ___ _ x.csv"; filename*=UTF-8\'\'')).toBe(true);
    expect(d).not.toMatch(/[\r\n]/);
    expect(d).toContain("%C3%85sa%20%22%C3%96%22%20%5C%20x.csv");
  });

  it("badRequest: a one-word reason, no-store, never the input echoed", async () => {
    const res = badRequest("range");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid range");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("crossSiteRefusal: refuses Sec-Fetch-Site: cross-site, lets same-origin / same-site / none / absent through", () => {
    const req = (site?: string) => new Request("https://app.example/time/export", { headers: site ? { "sec-fetch-site": site } : {} });
    expect(crossSiteRefusal(req("cross-site"))?.status).toBe(403);
    expect(crossSiteRefusal(req("same-origin"))).toBeNull();
    expect(crossSiteRefusal(req("same-site"))).toBeNull();
    expect(crossSiteRefusal(req("none"))).toBeNull();
    expect(crossSiteRefusal(req())).toBeNull();
  });

  it("downloadFailure: NOT_FOUND → 404, FORBIDDEN → 403 (bodiless, no-store); a domain error → 400; MFA_REQUIRED → step-up navigation; anything else propagates", async () => {
    const notFound = downloadFailure(new AuthzError("NOT_FOUND"), "/time/export?kind=team");
    expect([notFound.status, await notFound.text(), notFound.headers.get("cache-control")]).toEqual([404, "", "private, no-store"]);
    const forbidden = downloadFailure(new AuthzError("FORBIDDEN"), "/time/export?kind=team");
    expect([forbidden.status, await forbidden.text()]).toEqual([403, ""]);
    const bad = downloadFailure(new DomainError("INVALID_INPUT", "range too long"), "/time/export");
    expect([bad.status, await bad.text()]).toEqual([400, "invalid invalid_input"]);
    // Next's redirect() signals navigation by throwing — the route lets it propagate.
    expect(() => downloadFailure(new AuthzError("MFA_REQUIRED", "step_up"), "/projects/ACME/time/export?kind=rollup&cost=1")).toThrow(/NEXT_REDIRECT/);
    expect(() => downloadFailure(new Error("db down"), "/time/export")).toThrow("db down");
  });
});
