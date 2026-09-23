import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getRequestContext,
  requestContextFromHeaders,
  withRequestContext,
} from "./request-context";

const headersState = vi.hoisted(() => ({
  map: null as Map<string, string> | null,
}));

vi.mock("next/headers", () => ({
  headers: async () => {
    if (!headersState.map) {
      throw new Error("`headers` was called outside a request scope");
    }
    const m = headersState.map;
    return { get: (name: string) => m.get(name.toLowerCase()) ?? null };
  },
}));

const withHeaders = (h: Record<string, string>) => {
  headersState.map = new Map(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
};

afterEach(() => {
  headersState.map = null;
});

describe("getRequestContext(): ALS store wins, then next/headers, else undefined", () => {
  it("returns the explicit ALS store when present", async () => {
    withHeaders({ "x-request-id": "from-headers" });
    const ctx = await withRequestContext({ requestId: "als-1", ip: "10.0.0.1" }, () =>
      getRequestContext(),
    );
    expect(ctx).toEqual({ requestId: "als-1", ip: "10.0.0.1" });
  });

  /**
   * **THESE TWO CASES CHANGED ON 2026-09-23, and they had been pinning
   * the defect.** The old expectations were the LEFTMOST forwarded hop
   * and, failing that, `x-real-ip` — both values a caller writes. A
   * security review of the portal invitation page found that the rate
   * limiter shared that derivation, so rotating one header bought an
   * unlimited budget on the product's only unauthenticated route; the
   * audit row's `ip` had the same property, one header apart. Both now
   * go through `src/lib/client-ip.ts`, which counts from the RIGHT of
   * the chain by the number of proxies the deployment declares
   * (`TRUSTED_PROXY_HOPS`, default 1) and never reads `x-real-ip`.
   *
   * `client-ip.test.ts` covers the derivation across hop counts, which
   * this file cannot: the hop count is read from config at import.
   */
  it("derives requestId/ip/userAgent from request headers", async () => {
    withHeaders({
      "x-vercel-id": "fra1::abc",
      "x-request-id": "ignored",
      "x-forwarded-for": "203.0.113.9, 10.0.0.2",
      "user-agent": "vitest/1.0",
    });
    expect(await getRequestContext()).toEqual({
      requestId: "fra1::abc",
      // THE RIGHTMOST HOP at the default of one declared proxy — the one
      // our own edge appended. With this fixture read as a two-hop
      // deployment (a client, an intermediate, us) the real client is
      // 203.0.113.9 and TRUSTED_PROXY_HOPS would be 2; that arithmetic
      // is pinned in client-ip.test.ts.
      ip: "10.0.0.2",
      userAgent: "vitest/1.0",
    });
  });

  it("falls back x-request-id → generated id; NO ip from x-real-ip alone", async () => {
    withHeaders({ "x-request-id": "req-7", "x-real-ip": "198.51.100.4" });
    const withRealIpOnly = await getRequestContext();
    expect(withRealIpOnly).toMatchObject({ requestId: "req-7" });
    // Deliberately absent: an address with no chain has no position that
    // can be trusted, so the row records no ip rather than a forged one.
    expect(withRealIpOnly?.ip).toBeUndefined();

    withHeaders({});
    const ctx = await getRequestContext();
    expect(ctx?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx?.ip).toBeUndefined();
    expect(ctx?.userAgent).toBeUndefined();
  });

  it("is undefined outside any request scope (jobs, tests)", async () => {
    expect(await getRequestContext()).toBeUndefined();
  });
});

describe("requestContextFromHeaders (pure)", () => {
  it("omits empty ip/userAgent keys instead of storing empty strings", () => {
    const ctx = requestContextFromHeaders(
      (n) => (n === "x-forwarded-for" ? " , " : null),
      () => "gen",
    );
    expect(ctx).toEqual({ requestId: "gen" });
  });
});
