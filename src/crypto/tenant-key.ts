import { randomBytes } from "node:crypto";

import type { TenantDb } from "@/db";
// context.ts is the pure AsyncLocalStorage helper, not the client: a
// value import from "@/db" would construct the runtime client at load,
// which the DB-free v1 unit tests (and any auth-only path) must not do.
import { currentTenantId } from "@/db/context";

import { record } from "@/audit/record";

import { activeRootKeyId, decryptField, encryptField } from "./root-keyring";

/**
 * Per-tenant envelope keys (SECURITY.md §6, DATA_MODEL.md §4/§6.17).
 * TenantKey holds a 32-byte DEK wrapped by the env root keyring (v1
 * field-encryption format); v2 ciphertext is encrypted under the DEK.
 * Created lazily on a tenant's first encrypt. Unwrapped DEKs are cached
 * per process for a bounded time; RETIRED keys stay decryptable.
 */

export type TenantDek = { keyId: string; rootKeyId: string; dek: Buffer };

const DEK_BYTES = 32;
const FIRST_KEY_ID = "t1";
const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = { value: TenantDek; expiresAt: number };
const cache = new Map<string, CacheEntry>();

const cacheKey = (tenantId: string, keyId: string) => `${tenantId}:${keyId}`;

const cached = (tenantId: string, keyId: string): TenantDek | undefined => {
  const hit = cache.get(cacheKey(tenantId, keyId));
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(cacheKey(tenantId, keyId));
    return undefined;
  }
  return hit.value;
};

const remember = (tenantId: string, value: TenantDek): TenantDek => {
  cache.set(cacheKey(tenantId, value.keyId), { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
};

/** Test seam — drops every cached DEK. */
export const resetTenantDekCache = (): void => {
  cache.clear();
};

/** The tenantId argument must be the enclosing withTenant() tenant —
 * the cache is keyed by it, so a mismatch is rejected, never trusted. */
function assertContextTenant(tenantId: string): void {
  const ctx = currentTenantId();
  if (!ctx) throw new Error("tenant-key: must run inside withTenant()");
  if (ctx !== tenantId) {
    throw new Error("tenant-key: tenantId does not match the withTenant() context");
  }
}

const unwrap = (row: { keyId: string; rootKeyId: string; wrappedDek: string }): TenantDek => {
  const dek = Buffer.from(decryptField(row.wrappedDek), "base64");
  if (dek.length !== DEK_BYTES) {
    throw new Error(`tenant-key: unwrapped DEK for "${row.keyId}" has the wrong size`);
  }
  return { keyId: row.keyId, rootKeyId: row.rootKeyId, dek };
};

/**
 * The tenant's ACTIVE DEK, creating the first TenantKey if none exists.
 * Concurrent first-callers race on @@unique([tenantId, keyId]); the
 * insert skips duplicates (ON CONFLICT DO NOTHING — a raised unique
 * violation would abort the enclosing transaction) and the winner's row
 * is re-read.
 */
export async function getActiveTenantDek(tx: TenantDb, tenantId: string): Promise<TenantDek> {
  assertContextTenant(tenantId);

  const active = await tx.tenantKey.findFirst({ where: { status: "ACTIVE" } });
  if (active) return cached(tenantId, active.keyId) ?? remember(tenantId, unwrap(active));

  const dek = randomBytes(DEK_BYTES);
  const rootKeyId = activeRootKeyId();
  const created = await tx.tenantKey.createMany({
    data: [
      {
        tenantId, // == context tenant (asserted above); where-injection re-checks
        keyId: FIRST_KEY_ID,
        wrappedDek: encryptField(dek.toString("base64")),
        rootKeyId,
        status: "ACTIVE",
      },
    ],
    skipDuplicates: true,
  });
  const row = await tx.tenantKey.findFirst({ where: { status: "ACTIVE" } });
  if (!row) throw new Error("tenant-key: no ACTIVE key after create");
  if (created.count === 1) {
    await record(tx, {
      action: "tenant_key.created",
      targetType: "TenantKey",
      targetId: row.id,
      metadata: { keyId: row.keyId, rootKeyId },
    });
  }
  return cached(tenantId, row.keyId) ?? remember(tenantId, unwrap(row));
}

/** A specific tenant key by keyId, ACTIVE or RETIRED (decrypt path). */
export async function getTenantDek(
  tx: TenantDb,
  tenantId: string,
  keyId: string,
): Promise<TenantDek> {
  assertContextTenant(tenantId);
  const hit = cached(tenantId, keyId);
  if (hit) return hit;
  const row = await tx.tenantKey.findFirst({ where: { keyId } });
  if (!row) throw new Error(`tenant-key: no key "${keyId}" for this tenant`);
  return remember(tenantId, unwrap(row));
}
