import { describe, expect, it } from "vitest";

import { clientIpFrom, UNKNOWN_SUBJECT } from "./client-ip";

/**
 * The derivation both the rate limiter and the audit trail use. It is
 * tested directly, and across hop counts, because `trustedProxyHops` is
 * read from config at import time — so a test that went through
 * `clientIp` or `clientIpFromHeaders` could only ever exercise one
 * deployment shape, and the whole contract is about which hop is
 * trustworthy in which shape.
 */
const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;

describe("clientIpFrom", () => {
  it("with one proxy in front, takes the hop that proxy wrote", () => {
    // nginx's `$proxy_add_x_forwarded_for` APPENDS the peer it saw to
    // whatever arrived, so the rightmost entry is ours and everything to
    // its left may be invention.
    expect(clientIpFrom(headers({ "x-forwarded-for": "203.0.113.9" }), 1)).toBe("203.0.113.9");
    expect(clientIpFrom(headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }), 1)).toBe(
      "203.0.113.9",
    );
  });

  it("IGNORES A FORGED PREFIX, which is the whole point", () => {
    // The attack the old derivation allowed: a caller sends a chain of
    // their own invention and the app believes the first entry.
    const forged = "9.9.9.9, 8.8.8.8, 7.7.7.7";
    const get = headers({ "x-forwarded-for": `${forged}, 203.0.113.9` });
    expect(clientIpFrom(get, 1)).toBe("203.0.113.9");
    expect(clientIpFrom(get, 1)).not.toBe("9.9.9.9");
  });

  it("NEVER reads x-real-ip, which no chain can position", () => {
    // It was read FIRST by the rate limiter, and the documented
    // deployment does not set it — so it arrived verbatim from the
    // caller and every request could be a fresh subject.
    expect(clientIpFrom(headers({ "x-real-ip": "198.51.100.4" }), 1)).toBe(UNKNOWN_SUBJECT);
    expect(
      clientIpFrom(headers({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "203.0.113.9" }), 1),
    ).toBe("203.0.113.9");
  });

  it("counts from the right, so a CDN in front is one more declared hop", () => {
    const get = headers({ "x-forwarded-for": "203.0.113.9, 70.70.70.70" });
    expect(clientIpFrom(get, 2)).toBe("203.0.113.9");
    expect(clientIpFrom(get, 1)).toBe("70.70.70.70");
  });

  it("refuses a chain shorter than the deployment declares", () => {
    // The request did not arrive the way the deployment says it does, so
    // there is no position to read from. Sharing one bucket is the safe
    // direction; reading the wrong position is not.
    expect(clientIpFrom(headers({ "x-forwarded-for": "203.0.113.9" }), 2)).toBe(UNKNOWN_SUBJECT);
    expect(clientIpFrom(headers({}), 1)).toBe(UNKNOWN_SUBJECT);
    expect(clientIpFrom(headers({ "x-forwarded-for": "" }), 1)).toBe(UNKNOWN_SUBJECT);
    expect(clientIpFrom(headers({ "x-forwarded-for": " , , " }), 1)).toBe(UNKNOWN_SUBJECT);
  });

  it("trusts nothing at all when the deployment declares no proxy", () => {
    expect(clientIpFrom(headers({ "x-forwarded-for": "203.0.113.9" }), 0)).toBe(UNKNOWN_SUBJECT);
  });

  it("BOUNDS THE VALUE, because it becomes a key in an in-process map", () => {
    // A cap on the NUMBER of subjects is worth nothing if one subject may
    // be a megabyte, and on the unauthenticated path the caller supplies
    // the string.
    const huge = "x".repeat(5_000);
    const out = clientIpFrom(headers({ "x-forwarded-for": huge }), 1);
    expect(out.length).toBeLessThanOrEqual(64);
    // A full IPv6 address with a zone still survives intact.
    const v6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
    expect(clientIpFrom(headers({ "x-forwarded-for": v6 }), 1)).toBe(v6);
  });
});
