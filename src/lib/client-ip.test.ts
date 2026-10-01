import { describe, expect, it } from "vitest";

import { clientIpFrom, rateLimitSource, UNKNOWN_SUBJECT } from "./client-ip";

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

/**
 * The rate limiter's SOURCE (slice 81's fix-pass review): an IPv6 caller is
 * its /64, because one host is routinely given one whole; an IPv4-mapped
 * address is the IPv4 address it carries; anything else is left alone.
 */
describe("rateLimitSource", () => {
  it("leaves an IPv4 address as it is", () => {
    expect(rateLimitSource("203.0.113.9")).toBe("203.0.113.9");
  });

  it("puts every address of one /64 in one bucket, whatever the spelling", () => {
    const prefix = "2001:db8:85a3:42::/64";
    for (const address of [
      "2001:db8:85a3:42::1",
      "2001:0db8:85a3:0042:ffff:ffff:ffff:ffff",
      "2001:DB8:85A3:42:0:8a2e:370:7334",
      "[2001:db8:85a3:42::9]",
      "2001:db8:85a3:42::1%eth0",
      "2001:db8:85a3:42::192.0.2.1",
    ]) {
      expect(rateLimitSource(address), address).toBe(prefix);
    }
  });

  it("asked for a /48, puts every /64 of one /48 in one bucket — a tunnel broker's whole allocation", () => {
    for (const address of ["2001:470:1f0b:1::1", "2001:470:1f0b:ffff::9", "2001:470:1F0B:42:0:8a2e:370:7334"]) {
      expect(rateLimitSource(address, 48), address).toBe("2001:470:1f0b::/48");
    }
    expect(rateLimitSource("2001:470:1f0c::1", 48)).not.toBe(rateLimitSource("2001:470:1f0b::1", 48));
    // IPv4 is never widened: an IPv4 address is one source either way.
    expect(rateLimitSource("203.0.113.9", 48)).toBe("203.0.113.9");
    expect(rateLimitSource("::ffff:192.0.2.1", 48)).toBe("192.0.2.1");
  });

  it("keeps different /64s apart", () => {
    expect(rateLimitSource("2001:db8:85a3:42::1")).not.toBe(rateLimitSource("2001:db8:85a3:43::1"));
    expect(rateLimitSource("::1")).toBe("0:0:0:0::/64");
  });

  it("reads an IPv4-mapped address as the IPv4 address it carries", () => {
    expect(rateLimitSource("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(rateLimitSource("::ffff:c000:201")).toBe("192.0.2.1");
  });

  it("leaves what is not an IP alone — it is already one bucket", () => {
    for (const value of [UNKNOWN_SUBJECT, "not-an-ip", "2001:db8::1::2", "1.2.3"]) {
      expect(rateLimitSource(value)).toBe(value);
    }
  });
});
