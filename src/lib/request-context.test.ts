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

  it("derives requestId/ip/userAgent from request headers", async () => {
    withHeaders({
      "x-vercel-id": "fra1::abc",
      "x-request-id": "ignored",
      "x-forwarded-for": "203.0.113.9, 10.0.0.2",
      "user-agent": "vitest/1.0",
    });
    expect(await getRequestContext()).toEqual({
      requestId: "fra1::abc",
      ip: "203.0.113.9",
      userAgent: "vitest/1.0",
    });
  });

  it("falls back x-request-id → generated id; x-real-ip when no forwarded-for", async () => {
    withHeaders({ "x-request-id": "req-7", "x-real-ip": "198.51.100.4" });
    expect(await getRequestContext()).toMatchObject({ requestId: "req-7", ip: "198.51.100.4" });

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
