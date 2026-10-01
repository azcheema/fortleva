import { createHmac } from "node:crypto";

import { fail } from "@/lib/domain-error";

/**
 * Server-side TOTP for a stored seed (RFC 6238 over RFC 4226; plan §3.4:
 * "per-item TOTP: seed stored, code generated server-side"). The seed is
 * stored encrypted and NEVER returned — only a code and when it expires.
 * Pure: `totp.test.ts` pins the RFC 6238 Appendix B vectors.
 */

export const TOTP_ALGORITHMS = ["SHA1", "SHA256", "SHA512"] as const;
export type TotpAlgorithm = (typeof TOTP_ALGORITHMS)[number];

export type TotpParams = {
  /** The seed, base32 (RFC 4648), canonical: upper case, no padding. */
  readonly secret: string;
  readonly algorithm: TotpAlgorithm;
  readonly digits: 6 | 8;
  readonly period: 30 | 60;
};

/** Seeds shorter than 80 bits are refused (RFC 4226 §4 wants 128, and
 * recommends 160; real services ship 80-bit seeds, so 80 is the floor). */
const SEED_MIN_BYTES = 10;
const SEED_MAX_BYTES = 128;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 → bytes. Spaces, hyphens and padding are ignored. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) fail("INVALID_INPUT", "TOTP seed is not base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const canonicalSeed = (raw: string): string => {
  const clean = raw.toUpperCase().replace(/[\s=-]/g, "");
  const bytes = base32Decode(clean);
  if (bytes.length < SEED_MIN_BYTES) fail("INVALID_INPUT", "TOTP seed is too short");
  if (bytes.length > SEED_MAX_BYTES) fail("INVALID_INPUT", "TOTP seed is too long");
  return clean;
};

/**
 * What a member pastes: a bare base32 seed, or the `otpauth://totp/…` URI
 * a QR code encodes. HOTP (counter) URIs are refused — a code that
 * advances on use cannot be generated from a stored seed without a
 * counter nobody else shares. Errors never echo the input.
 */
export function parseTotpInput(raw: unknown): TotpParams {
  if (typeof raw !== "string" || raw.trim() === "") fail("INVALID_INPUT", "TOTP seed");
  const input = (raw as string).trim();
  if (!input.toLowerCase().startsWith("otpauth:")) {
    return { secret: canonicalSeed(input), algorithm: "SHA1", digits: 6, period: 30 };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail("INVALID_INPUT", "TOTP URI");
  }
  if (url.hostname.toLowerCase() !== "totp") fail("INVALID_INPUT", "only TOTP URIs are supported");
  const secret = url.searchParams.get("secret");
  if (!secret) fail("INVALID_INPUT", "TOTP URI has no secret");
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  if (!(TOTP_ALGORITHMS as readonly string[]).includes(algorithm)) fail("INVALID_INPUT", "TOTP algorithm");
  const digits = Number(url.searchParams.get("digits") ?? "6");
  if (digits !== 6 && digits !== 8) fail("INVALID_INPUT", "TOTP digits");
  const period = Number(url.searchParams.get("period") ?? "30");
  if (period !== 30 && period !== 60) fail("INVALID_INPUT", "TOTP period");
  return {
    secret: canonicalSeed(secret as string),
    algorithm: algorithm as TotpAlgorithm,
    digits: digits as 6 | 8,
    period: period as 30 | 60,
  };
}

/** RFC 4226 HOTP with RFC 6238's algorithm choice. */
export function hotp(key: Buffer, counter: bigint, algorithm: TotpAlgorithm, digits: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac(algorithm.toLowerCase(), key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The code for `atMs`, and the instant it stops being the current one. */
export function totpCode(params: TotpParams, atMs: number): { code: string; validUntil: Date } {
  const step = BigInt(Math.floor(atMs / 1000 / params.period));
  const code = hotp(base32Decode(params.secret), step, params.algorithm, params.digits);
  return { code, validUntil: new Date(Number(step + 1n) * params.period * 1000) };
}
