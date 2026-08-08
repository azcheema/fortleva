import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Field-level encryption service (SECURITY.md §6): AES-256-GCM,
 * ciphertext format `v1.<keyId>.<iv>.<ct>.<tag>` (base64url parts).
 * The key lives in env at v1; keyId is in the format so rotation and a
 * later per-tenant-DEK/KMS upgrade are additive, not migrations.
 * Applied to: TwoFactor.secret/backupCodes, Tenant bank fields,
 * Tenant.databaseUrl (DATA_MODEL.md §4 — the closed inventory).
 */

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

type Keyring = { activeKeyId: string; keys: Map<string, Buffer> };

let cachedKeyring: Keyring | null = null;

function keyring(): Keyring {
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

const b64u = (b: Buffer): string => b.toString("base64url");

export function encryptField(plaintext: string): string {
  const { activeKeyId, keys } = keyring();
  const key = keys.get(activeKeyId);
  if (!key) throw new Error("active encryption key missing");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, activeKeyId, b64u(iv), b64u(ct), b64u(tag)].join(".");
}

export function decryptField(ciphertext: string): string {
  const parts = ciphertext.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error("field ciphertext has an unknown format");
  }
  const [, keyId, ivB64, ctB64, tagB64] = parts as [string, string, string, string, string];
  const key = keyring().keys.get(keyId);
  if (!key) throw new Error(`no key for keyId "${keyId}"`);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export const isEncryptedField = (value: string): boolean =>
  value.startsWith(`${VERSION}.`) && value.split(".").length === 5;

/** Constant-time comparison for secrets that pass through here. */
export const secretsEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};
