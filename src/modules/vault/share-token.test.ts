import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  hashShareCode,
  mintShareToken,
  newShareCode,
  normalizeShareCode,
  parseShareToken,
  SHARE_CODE_TTL_MS,
  SHARE_MAX_CODE_ATTEMPTS,
  SHARE_MAX_CODES,
  shareLinkPath,
  shareLinkStatus,
} from "./share-token";

/**
 * The share link's pure half (slice 90): the token's shape, the code's
 * hash, and the ONE status rule both the member's list and the share page
 * act on. The database half — view-once under concurrency, the bounds,
 * the guard — is `share.dbtest.ts`.
 */

const TENANT = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("the token", () => {
  it("round-trips: the parsed tenant is the minter's, the hash is the stored one", () => {
    const { token, tokenHash } = mintShareToken(TENANT);
    expect(token.startsWith(`${TENANT}.`)).toBe(true);
    const parsed = parseShareToken(token);
    expect(parsed).toEqual({ tenantId: TENANT, tokenHash });
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores the hash of the RANDOM part only — never anything that opens it", () => {
    const { token, tokenHash } = mintShareToken(TENANT);
    const random = token.slice(TENANT.length + 1);
    expect(tokenHash).toBe(createHash("sha256").update(random).digest("hex"));
    expect(tokenHash).not.toContain(random);
  });

  it("is fresh every time", () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintShareToken(TENANT).token));
    expect(seen.size).toBe(200);
  });

  it("refuses to mint for something that is not a tenant id", () => {
    expect(() => mintShareToken("not-a-tenant")).toThrow();
    expect(() => mintShareToken(TENANT.toUpperCase())).toThrow();
  });

  it("parses nothing that is not exactly a minted token — one null for all", () => {
    const { token } = mintShareToken(TENANT);
    const random = token.slice(TENANT.length + 1);
    for (const bad of [
      undefined,
      null,
      42,
      {},
      "",
      token.slice(0, -1),
      `${token}A`,
      `${TENANT.toUpperCase()}.${random}`,
      `${TENANT}${random}A`, // no dot
      `${TENANT}.${random.slice(0, -1)}+`, // not base64url
      `${TENANT}.${random.slice(0, -1)}.`, // a second dot
      `${randomUUID().slice(0, 35)}x.${random}`, // not a uuid
      `../${TENANT.slice(3)}.${random}`,
    ]) {
      expect(parseShareToken(bad), String(bad)).toBeNull();
    }
  });

  it("spells its path in one place", () => {
    expect(shareLinkPath("abc")).toBe("/portal/share/abc");
  });
});

describe("the code", () => {
  it("is six digits, leading zeros kept", () => {
    for (let i = 0; i < 500; i += 1) expect(newShareCode()).toMatch(/^\d{6}$/);
  });

  it("is stored keyed and bound to its link: never the plain hash a dump could reverse", () => {
    const a = hashShareCode("link-a", "123456");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashShareCode("link-a", "123456")).toBe(a);
    expect(hashShareCode("link-b", "123456")).not.toBe(a);
    expect(hashShareCode("link-a", "123457")).not.toBe(a);
    // The migration's pre-apply review: sha256(`<id>:<code>`) over a
    // million codes reverses in a second. The stored value is an HMAC.
    expect(a).not.toBe(createHash("sha256").update("link-a:123456").digest("hex"));
  });

  it("forgives spaces and dashes, and nothing else", () => {
    expect(normalizeShareCode("123456")).toBe("123456");
    expect(normalizeShareCode(" 123 456 ")).toBe("123456");
    expect(normalizeShareCode("123-456")).toBe("123456");
    for (const bad of ["12345", "1234567", "12345a", "١٢٣٤٥٦", "", 123456, null, undefined, "1".repeat(40)]) {
      expect(normalizeShareCode(bad), String(bad)).toBeNull();
    }
  });
});

describe("the status rule — one for the member's list and the share page", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  const later = new Date("2026-10-05T12:00:00Z");
  const earlier = new Date("2026-10-03T12:00:00Z");
  const base = {
    viewedAt: null,
    revokedAt: null,
    codeAttempts: 0,
    codesSent: 0,
    codeExpiresAt: null,
    secretVersion: 3,
    expiresAt: later,
    createdAt: earlier,
  };

  it("a fresh link is waiting", () => {
    expect(shareLinkStatus(base, 3, now, null)).toBe("waiting");
  });

  it("names what ended it: opened beats expired, revoked beats changed", () => {
    expect(shareLinkStatus({ ...base, viewedAt: earlier, expiresAt: earlier }, 3, now, null)).toBe("viewed");
    expect(shareLinkStatus({ ...base, revokedAt: earlier }, 4, now, null)).toBe("revoked");
  });

  it("a link made before share links were last switched off is stopped for good — one made after is not", () => {
    expect(shareLinkStatus(base, 3, now, earlier)).toBe("stopped");
    expect(shareLinkStatus(base, 3, now, new Date(earlier.getTime() - 1))).toBe("waiting");
    // ...and what ended it first is still what it says: opened, five wrong
    // codes, or already expired when the stop came.
    expect(shareLinkStatus({ ...base, viewedAt: earlier }, 3, now, now)).toBe("viewed");
    expect(shareLinkStatus({ ...base, codeAttempts: SHARE_MAX_CODE_ATTEMPTS }, 3, now, now)).toBe("locked");
    expect(shareLinkStatus({ ...base, expiresAt: earlier }, 3, now, now)).toBe("expired");
    // Five codes mailed and the last one lapsed before the stop: LOCKED.
    expect(shareLinkStatus({ ...base, codesSent: SHARE_MAX_CODES, codeExpiresAt: earlier }, 3, now, now)).toBe("locked");
  });

  it("five checks lock it, whatever else is true", () => {
    expect(shareLinkStatus({ ...base, codeAttempts: SHARE_MAX_CODE_ATTEMPTS }, 3, now, null)).toBe("locked");
    expect(shareLinkStatus({ ...base, codeAttempts: SHARE_MAX_CODE_ATTEMPTS - 1 }, 3, now, null)).toBe("waiting");
  });

  it("five codes lock it only once the last one is no longer live", () => {
    const spent = { ...base, codesSent: SHARE_MAX_CODES };
    expect(shareLinkStatus({ ...spent, codeExpiresAt: later }, 3, now, null)).toBe("waiting");
    expect(shareLinkStatus({ ...spent, codeExpiresAt: earlier }, 3, now, null)).toBe("locked");
    expect(shareLinkStatus({ ...spent, codeExpiresAt: null }, 3, now, null)).toBe("locked");
  });

  it("a replaced secret — or a missing one — stops a link still in date", () => {
    expect(shareLinkStatus(base, 4, now, null)).toBe("changed");
    expect(shareLinkStatus(base, null, now, null)).toBe("changed");
  });

  it("expires at its moment, not after — and an expired link whose secret then changed EXPIRED", () => {
    expect(shareLinkStatus({ ...base, expiresAt: now }, 3, now, null)).toBe("expired");
    expect(shareLinkStatus({ ...base, expiresAt: new Date(now.getTime() + 1) }, 3, now, null)).toBe("waiting");
    expect(shareLinkStatus({ ...base, expiresAt: earlier }, 4, now, null)).toBe("expired");
  });
});

describe("the bounds are the migration's", () => {
  it("five checks, five codes, ten minutes — restated by the table's CHECKs", () => {
    const sql = readFileSync(
      join(process.cwd(), "prisma", "migrations", "20261004120000_credential_share_link", "migration.sql"),
      "utf8",
    );
    expect(SHARE_MAX_CODE_ATTEMPTS).toBe(5);
    expect(SHARE_MAX_CODES).toBe(5);
    expect(SHARE_CODE_TTL_MS).toBe(10 * 60_000);
    expect(sql).toContain("CHECK (code_attempts BETWEEN 0 AND 5)");
    expect(sql).toContain("CHECK (codes_sent BETWEEN 0 AND 5)");
    expect(sql).toContain("code_expires_at <= code_sent_at + interval '10 minutes'");
    expect(sql).toContain("expires_at <= created_at + interval '168 hours'");
  });
});
