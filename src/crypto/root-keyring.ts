import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * The env ROOT keyring (SECURITY.md §6.1): `{rootKeyId: key}` + active
 * pointer, loaded from FIELD_ENCRYPTION_KEY / FIELD_ENCRYPTION_KEY_ID
 * (+ FIELD_ENCRYPTION_KEY_PREVIOUS "keyId:base64key" during rotation).
 * v1 field ciphertext is encrypted directly under a root key; v2 wraps
 * per-tenant DEKs (src/crypto/tenant-key.ts) with it. Root keys never
 * touch v2 data directly.
 */

export type Keyring = { activeKeyId: string; keys: Map<string, Buffer> };

let cachedKeyring: Keyring | null = null;

export function rootKeyring(): Keyring {
  if (cachedKeyring) return cachedKeyring;
  const raw = process.env["FIELD_ENCRYPTION_KEY"];
  if (!raw) throw new Error("FIELD_ENCRYPTION_KEY is not set");
  const activeKeyId = process.env["FIELD_ENCRYPTION_KEY_ID"] ?? "k1";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("FIELD_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  // Rotation seam: FIELD_ENCRYPTION_KEY_PREVIOUS ("keyId:base64key")
  // lets decrypt keep working while re-encryption proceeds.
  const keys = new Map([[activeKeyId, key]]);
  const prev = process.env["FIELD_ENCRYPTION_KEY_PREVIOUS"];
  if (prev) {
    const [prevId, prevKey] = prev.split(":");
    if (prevId && prevKey) keys.set(prevId, Buffer.from(prevKey, "base64"));
  }
  cachedKeyring = { activeKeyId, keys };
  return cachedKeyring;
}

/** Test seam — clears the cached env-derived keyring. */
export const resetKeyringCache = (): void => {
  cachedKeyring = null;
};

export const activeRootKeyId = (): string => rootKeyring().activeKeyId;

const V1 = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const b64u = (b: Buffer): string => b.toString("base64url");
const fromB64u = (s: string): Buffer => Buffer.from(s, "base64url");

// ── v1 primitives: directly under a root key, no AAD ────────────────

export function encryptField(plaintext: string): string {
  const { activeKeyId, keys } = rootKeyring();
  const key = keys.get(activeKeyId);
  if (!key) throw new Error("active encryption key missing");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [V1, activeKeyId, b64u(iv), b64u(ct), b64u(tag)].join(".");
}

export function decryptField(ciphertext: string): string {
  const parts = ciphertext.split(".");
  if (parts.length !== 5 || parts[0] !== V1) {
    throw new Error("field ciphertext has an unknown format");
  }
  const [, keyId, ivB64, ctB64, tagB64] = parts as [string, string, string, string, string];
  const key = rootKeyring().keys.get(keyId);
  if (!key) throw new Error(`no key for keyId "${keyId}"`);
  const decipher = createDecipheriv(ALGO, key, fromB64u(ivB64));
  decipher.setAuthTag(fromB64u(tagB64));
  return Buffer.concat([decipher.update(fromB64u(ctB64)), decipher.final()]).toString("utf8");
}

export const isEncryptedField = (value: string): boolean =>
  value.startsWith(`${V1}.`) && value.split(".").length === 5;

