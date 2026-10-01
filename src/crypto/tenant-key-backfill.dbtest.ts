import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "@/db";
import { setupTenant } from "@/members/dbtest-fixture";

import { decryptFieldV2, encryptFieldV2 } from "./field-encryption";
import { activeRootKeyId, encryptField, resetKeyringCache } from "./root-keyring";
import { backfillTenantKeys } from "./tenant-key-backfill";
import { getActiveTenantDek, resetTenantDekCache } from "./tenant-key";

/**
 * THE TENANT-KEY BACK-FILL (PLAN Phase 3V's first line) against the real
 * database. It is driven by `prisma/seed.ts` for every tenant when a
 * release asks; here it is driven for THIS suite's own tenants only — the
 * `tenantIds` narrowing is itself under test, because the shared dev
 * database holds the founder's tenant (AGENTS.md) — and its keyring proof
 * samples only this suite's tenants (`sampleTenantIds`), because another
 * run on the shared database may have left keys under another root key.
 *
 * Three tenants: `proof` holds a key the APPLICATION minted (the lazy path,
 * under this process's root key), `foreign` holds one wrapped under a
 * DIFFERENT root key, and `bare` holds none — the tenant to back-fill.
 */

let bare: Awaited<ReturnType<typeof setupTenant>>;
let proof: Awaited<ReturnType<typeof setupTenant>>;
let foreign: Awaited<ReturnType<typeof setupTenant>>;

/** A wrapped DEK under another root key — what a wrong shell's database would hold. */
function wrappedUnderAnotherKey(): string {
  const names = ["FIELD_ENCRYPTION_KEY", "FIELD_ENCRYPTION_KEY_PREVIOUS"] as const;
  const saved = names.map((n) => process.env[n]);
  process.env["FIELD_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
  delete process.env["FIELD_ENCRYPTION_KEY_PREVIOUS"];
  resetKeyringCache();
  try {
    return encryptField(randomBytes(32).toString("base64"));
  } finally {
    names.forEach((n, i) => {
      const v = saved[i];
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    });
    resetKeyringCache();
  }
}

beforeAll(async () => {
  bare = await setupTenant("vkey");
  proof = await setupTenant("vkey");
  foreign = await setupTenant("vkey");
  // The application's own key: minted by the lazy path, as a first encrypt would.
  await withTenant(proof.tenantId, { type: "system" }, (tx) => getActiveTenantDek(tx, proof.tenantId));
  await foreign.platform.tenantKey.create({
    data: { tenantId: foreign.tenantId, keyId: "t1", rootKeyId: activeRootKeyId(), wrappedDek: wrappedUnderAnotherKey(), status: "ACTIVE" },
  });
}, 120_000);

afterAll(async () => {
  for (const t of [bare, proof, foreign]) await t?.platform.tenantKey.deleteMany({ where: { tenantId: t.tenantId } });
  resetTenantDekCache();
  await foreign?.cleanup();
  await proof?.cleanup();
  await bare?.cleanup();
}, 120_000);

describe("backfillTenantKeys", () => {
  it("an empty tenant list touches nothing — never read as 'every tenant'", async () => {
    expect(await backfillTenantKeys(bare.platform, { tenantIds: [] })).toEqual({ scanned: 0, created: 0, keyring: "none" });
    expect(await bare.platform.tenantKey.count({ where: { tenantId: bare.tenantId } })).toBe(0);
  });

  it("with nothing to prove against it REFUSES — an empty sample list is nothing, not everything", async () => {
    await expect(backfillTenantKeys(bare.platform, { tenantIds: [bare.tenantId], sampleTenantIds: [] })).rejects.toThrow(
      /no existing tenant key to prove/,
    );
    await expect(backfillTenantKeys(bare.platform, { tenantIds: [bare.tenantId], sampleTenantIds: [bare.tenantId] })).rejects.toThrow(
      /no existing tenant key to prove/,
    );
    expect(await bare.platform.tenantKey.count({ where: { tenantId: bare.tenantId } })).toBe(0);
  });

  it("when the database's keys were wrapped under ANOTHER root key it refuses, and mints nothing", async () => {
    await expect(
      backfillTenantKeys(bare.platform, { tenantIds: [bare.tenantId], sampleTenantIds: [foreign.tenantId] }),
    ).rejects.toThrow(/does not unwrap the database's existing tenant key #1/);
    expect(await bare.platform.tenantKey.count({ where: { tenantId: bare.tenantId } })).toBe(0);
    expect(await bare.audits("tenant_key.created")).toEqual([]);
  });

  it("proved against the application's own key, it mints one ACTIVE key, audited with key ids only; a second pass is a no-op", async () => {
    const first = await backfillTenantKeys(bare.platform, { tenantIds: [bare.tenantId], sampleTenantIds: [proof.tenantId] });
    expect(first).toEqual({ scanned: 1, created: 1, keyring: "verified" });
    const keys = await bare.platform.tenantKey.findMany({ where: { tenantId: bare.tenantId } });
    expect(keys.map((k) => [k.keyId, k.status])).toEqual([["t1", "ACTIVE"]]);
    expect(keys[0]?.wrappedDek.startsWith("v1.")).toBe(true);

    const audit = await bare.audits("tenant_key.created");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorType).toBe("SYSTEM");
    expect(audit[0]?.targetId).toBe(keys[0]?.id);
    expect(audit[0]?.metadata).toEqual({ keyId: "t1", rootKeyId: keys[0]?.rootKeyId, reason: "backfill" });

    expect(await backfillTenantKeys(bare.platform, { tenantIds: [bare.tenantId] })).toEqual({ scanned: 0, created: 0, keyring: "none" });
    expect(await bare.platform.tenantKey.count({ where: { tenantId: bare.tenantId } })).toBe(1);
    expect(await bare.audits("tenant_key.created")).toHaveLength(1);
  });

  it("the back-filled key is the one the first v2 encrypt uses — the lazy path mints no second key", async () => {
    resetTenantDekCache();
    const ctx = { tenantId: bare.tenantId, model: "credential_secret", rowId: "probe", field: "secret" };
    const ct = await withTenant(bare.tenantId, { type: "system" }, (tx) => encryptFieldV2(tx, ctx, "hello"));
    expect(ct.split(".")[2]).toBe("t1");
    expect(await withTenant(bare.tenantId, { type: "system" }, (tx) => decryptFieldV2(tx, ctx, ct))).toBe("hello");
    expect(await bare.platform.tenantKey.count({ where: { tenantId: bare.tenantId } })).toBe(1);
    expect(await bare.audits("tenant_key.created")).toHaveLength(1);
  });
});
