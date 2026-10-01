import { afterEach, describe, expect, it, vi } from "vitest";

import { getLimiter, setLimiter, subjectDigest } from "./index";

/**
 * THE UPSTASH LEG NEVER SENDS A SUBJECT AS WRITTEN (SECURITY.md §4 and
 * §9.2: "keys are HMAC-hashed identifiers only"). The subjects are IP
 * addresses, email addresses and principal ids, and the Redis database is
 * a US-parent sub-processor's — so the promise is about what crosses the
 * wire, and this pins it at the last call before the wire: the library's
 * own `limit(identifier)`, mocked, so no test touches a network.
 */

const seen = vi.hoisted(() => ({
  identifiers: [] as string[],
  reason: undefined as string | undefined,
  options: [] as Record<string, unknown>[],
}));

vi.mock("@/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config")>()),
  upstashConfig: { url: "https://rate-limit.test.invalid", token: "not-a-token" },
}));

vi.mock("@upstash/redis", () => ({ Redis: class {} }));

vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class {
    constructor(options: Record<string, unknown>) {
      seen.options.push(options);
    }
    static slidingWindow(): object {
      return {};
    }
    async limit(identifier: string) {
      seen.identifiers.push(identifier);
      if (seen.reason === "throw") {
        throw new Error("fetch failed: getaddrinfo ENOTFOUND eu1-sacred-cat-12345.upstash.io at https://eu1-sacred-cat-12345.upstash.io/evalsha");
      }
      return { success: true, remaining: 1, reset: 0, limit: 2, pending: Promise.resolve(), reason: seen.reason };
    }
  },
}));

afterEach(() => {
  seen.identifiers.length = 0;
  seen.reason = undefined;
  setLimiter(null);
  vi.restoreAllMocks();
});

describe("the Upstash leg's identifiers", () => {
  it("are the subject's digest and never the subject", async () => {
    const limiter = getLimiter();
    expect(limiter.name).toBe("upstash");
    const subjects = ["portal:203.0.113.9", "member:kane.acmesson@example.com", "0f8fad5b-d9cb-469f-a165-70867728950e"];
    for (const [i, subject] of subjects.entries()) {
      await limiter.limit(i === 0 ? "auth.sign_in" : i === 1 ? "auth.sign_in_address" : "portal.comment_create", subject);
    }
    expect(seen.identifiers).toEqual(subjects.map(subjectDigest));
    for (const [i, subject] of subjects.entries()) {
      const sent = seen.identifiers[i] as string;
      expect(sent).not.toContain(subject);
      // No recognisable fragment either — the address's local part, the IP's last octet.
      expect(sent).not.toMatch(/acmesson|example|203\.0/i);
    }
  });

  it("is one fixed-length digest per subject, distinct between subjects", () => {
    expect(subjectDigest("portal:kane@example.com")).toBe(subjectDigest("portal:kane@example.com"));
    expect(subjectDigest("portal:kane@example.com")).not.toBe(subjectDigest("member:kane@example.com"));
    expect(subjectDigest("x")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(subjectDigest("y".repeat(10_000))).toHaveLength(43);
  });

  it("waits one second for Redis, not the library's five, keeps no block cache, and sends no analytics", async () => {
    // Three questions in turn on a sign-in (`rate-limit-hook.ts`), each
    // failing open on its timeout: the bound is what a degraded Redis costs.
    await getLimiter().limit("auth.sign_in_address", "contact:kane@example.com");
    const options = seen.options.at(-1);
    expect(options?.["timeout"]).toBe(1_000);
    expect(options?.["analytics"]).toBe(false);
    // Off, so Redis's sliding window — not a fixed-window memory of past
    // refusals, unbounded — decides when a locked account opens again.
    expect(options?.["ephemeralCache"]).toBe(false);
  });

  it("says so, loudly, when the library lets a request through on its timeout", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    seen.reason = "timeout";
    const result = await getLimiter().limit("auth.sign_in", "portal:203.0.113.9");
    expect(result.ok).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("failing open"));
  });
});

describe("the Upstash leg's failures", () => {
  it("fail open and log the error without the database's host", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    seen.reason = "throw";
    const result = await getLimiter().limit("auth.sign_in", "portal:203.0.113.9");
    expect(result.ok).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    const [line, ...rest] = error.mock.calls[0] as unknown[];
    expect(rest).toEqual([]);
    expect(String(line)).toContain("failing open");
    expect(String(line)).not.toMatch(/sacred-cat|upstash\.io/);
  });
});
