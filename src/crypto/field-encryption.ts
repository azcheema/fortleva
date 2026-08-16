import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

import type { TenantDb } from "@/db";

import { decryptField, isEncryptedField } from "./root-keyring";
import { getActiveTenantDek, getTenantDek } from "./tenant-key";

// v1 primitives live next to the root keyring (they ARE root-key
// operations); re-exported here so callers have one import.
export { decryptField, encryptField, isEncryptedField, resetKeyringCache } from "./root-keyring";

/**
 * Field-level encryption service (SECURITY.md §6, DATA_MODEL.md §4).
 * AES-256-GCM in two formats:
 *   v1 `v1.<keyId>.<iv>.<ct>.<tag>` — directly under an env root key,
 *      no AAD. Kept for the closed Phase-1 inventory (TwoFactor
 *      secret/backupCodes, Tenant bank fields, Tenant.databaseUrl) and
 *      for wrapping per-tenant DEKs. Still decryptable forever.
 *   v2 `v2.<rootKeyId>.<tenantKeyId>.<iv>.<ct>.<tag>` — under the
 *      tenant's DEK (src/crypto/tenant-key.ts) with MANDATORY AAD
 *      `tenantId:model:rowId:field`: a ciphertext moved to another row,
 *      tenant, model or column fails authentication. New app data is v2.
 * All parts base64url.
 */

const V2 = "v2";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

const b64u = (b: Buffer): string => b.toString("base64url");
const fromB64u = (s: string): Buffer => Buffer.from(s, "base64url");

// ── v2 ──────────────────────────────────────────────────────────────

/** Binds a ciphertext to exactly one (tenant, model, row, field). */
export type EncryptionContext = {
  tenantId: string;
  model: string;
  rowId: string;
  field: string;
};

const aadOf = (ctx: EncryptionContext): Buffer =>
  Buffer.from(`${ctx.tenantId}:${ctx.model}:${ctx.rowId}:${ctx.field}`, "utf8");

export async function encryptFieldV2(
  tx: TenantDb,
  ctx: EncryptionContext,
  plaintext: string,
): Promise<string> {
  const { keyId, rootKeyId, dek } = await getActiveTenantDek(tx, ctx.tenantId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, dek, iv);
  cipher.setAAD(aadOf(ctx));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [V2, rootKeyId, keyId, b64u(iv), b64u(ct), b64u(tag)].join(".");
}

export async function decryptFieldV2(
  tx: TenantDb,
  ctx: EncryptionContext,
  ciphertext: string,
): Promise<string> {
  const parts = ciphertext.split(".");
  if (parts.length !== 6 || parts[0] !== V2) {
    throw new Error("field ciphertext has an unknown format");
  }
  const [, , tenantKeyId, ivB64, ctB64, tagB64] = parts as [
    string, string, string, string, string, string,
  ];
  // The row's rootKeyId is not checked against the ciphertext's: a root
  // re-wrap changes the row, never the data. Whatever root wrapped the
  // DEK at unwrap time is what decryptField() resolves.
  const { dek } = await getTenantDek(tx, ctx.tenantId, tenantKeyId);
  const decipher = createDecipheriv(ALGO, dek, fromB64u(ivB64));
  decipher.setAAD(aadOf(ctx));
  decipher.setAuthTag(fromB64u(tagB64));
  return Buffer.concat([decipher.update(fromB64u(ctB64)), decipher.final()]).toString("utf8");
}

export const isEncryptedFieldV2 = (value: string): boolean =>
  value.startsWith(`${V2}.`) && value.split(".").length === 6;

/** Dispatches on the version prefix: v1 (root key, no AAD) or v2. */
export async function decryptAnyField(
  tx: TenantDb,
  ctx: EncryptionContext,
  ciphertext: string,
): Promise<string> {
  if (isEncryptedField(ciphertext)) return decryptField(ciphertext);
  if (isEncryptedFieldV2(ciphertext)) return decryptFieldV2(tx, ctx, ciphertext);
  throw new Error("field ciphertext has an unknown format");
}

/** Constant-time comparison for secrets that pass through here. */
export const secretsEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};
