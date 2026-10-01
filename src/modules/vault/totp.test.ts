import { describe, expect, it } from "vitest";

import { DomainError } from "@/lib/domain-error";

import { base32Decode, hotp, parseTotpInput, totpCode, type TotpParams } from "./totp";

/**
 * RFC 6238 Appendix B — the published test vectors, 8 digits, for the
 * three algorithms with their reference seeds (ASCII "1234567890"
 * repeated to 20, 32 and 64 bytes). The non-negotiable "TOTP vectors"
 * test of PLAN Phase 3V.
 */
const SEED_SHA1 = Buffer.from("12345678901234567890", "ascii");
const SEED_SHA256 = Buffer.from("12345678901234567890123456789012", "ascii");
const SEED_SHA512 = Buffer.from(
  "1234567890123456789012345678901234567890123456789012345678901234",
  "ascii",
);
const VECTORS: [number, string, string, string][] = [
  // [unix seconds, SHA1, SHA256, SHA512]
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const toBase32 = (bytes: Buffer): string => {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
};

const codeOf = (seed: Buffer, algorithm: TotpParams["algorithm"], t: number) =>
  totpCode({ secret: toBase32(seed), algorithm, digits: 8, period: 30 }, t * 1000).code;

const domainCode = (fn: () => unknown): string => {
  try {
    fn();
    return "ok";
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

describe("TOTP — RFC 6238 Appendix B vectors", () => {
  for (const [t, sha1, sha256, sha512] of VECTORS) {
    it(`T=${t}`, () => {
      expect(codeOf(SEED_SHA1, "SHA1", t)).toBe(sha1);
      expect(codeOf(SEED_SHA256, "SHA256", t)).toBe(sha256);
      expect(codeOf(SEED_SHA512, "SHA512", t)).toBe(sha512);
    });
  }

  it("RFC 4226 Appendix D: HOTP of the reference seed, 6 digits, counters 0..9", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, i) => expect(hotp(SEED_SHA1, BigInt(i), "SHA1", 6)).toBe(code));
  });

  it("validUntil is the end of the current step", () => {
    const params: TotpParams = { secret: toBase32(SEED_SHA1), algorithm: "SHA1", digits: 6, period: 30 };
    expect(totpCode(params, 59_000).validUntil.getTime()).toBe(60_000);
    expect(totpCode(params, 60_000).validUntil.getTime()).toBe(90_000);
  });
});

describe("TOTP seed input", () => {
  it("base32 round-trips, ignoring case, spaces, hyphens and padding", () => {
    const b32 = toBase32(SEED_SHA1);
    expect(base32Decode(b32).equals(SEED_SHA1)).toBe(true);
    const messy = b32.toLowerCase().replace(/(.{4})/g, "$1 ").replace(/ $/, "") + "====";
    expect(base32Decode(messy).equals(SEED_SHA1)).toBe(true);
  });

  it("a bare seed defaults to SHA1 / 6 digits / 30 s, stored canonical", () => {
    const parsed = parseTotpInput(` ${toBase32(SEED_SHA1).toLowerCase()} `);
    expect(parsed).toEqual({ secret: toBase32(SEED_SHA1), algorithm: "SHA1", digits: 6, period: 30 });
  });

  it("an otpauth://totp URI carries its parameters", () => {
    const uri = `otpauth://totp/Acme:ops%40acme.test?secret=${toBase32(SEED_SHA256)}&issuer=Acme&algorithm=SHA256&digits=8&period=60`;
    expect(parseTotpInput(uri)).toEqual({ secret: toBase32(SEED_SHA256), algorithm: "SHA256", digits: 8, period: 60 });
  });

  it("refuses what it cannot generate from, without echoing the input", () => {
    const short = toBase32(Buffer.alloc(9, 7)); // 72 bits < the 80-bit floor
    for (const bad of [
      "",
      "not base32 !!",
      short,
      `otpauth://hotp/x?secret=${toBase32(SEED_SHA1)}&counter=1`,
      `otpauth://totp/x?secret=${toBase32(SEED_SHA1)}&algorithm=MD5`,
      `otpauth://totp/x?secret=${toBase32(SEED_SHA1)}&digits=7`,
      `otpauth://totp/x?secret=${toBase32(SEED_SHA1)}&period=45`,
      "otpauth://totp/x?issuer=Acme",
    ]) {
      expect(domainCode(() => parseTotpInput(bad)), bad).toBe("INVALID_INPUT");
    }
    let thrown: unknown = null;
    try {
      parseTotpInput("SECRETLOOKINGVALUE1!");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect(String(thrown)).not.toContain("SECRETLOOKINGVALUE1");
  });
});
