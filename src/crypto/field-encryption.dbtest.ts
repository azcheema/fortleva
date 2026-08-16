import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest cleanup uses the raw layer */
import { getPlatformClient, runtimeClient } from "@/db/client";
import { withPlatform, withTenant } from "@/db";
import { newId } from "@/lib/ids";

import {
  decryptAnyField,
  decryptFieldV2,
  encryptField,
  encryptFieldV2,
  isEncryptedField,
  isEncryptedFieldV2,
  type EncryptionContext,
} from "./field-encryption";
import { getActiveTenantDek, resetTenantDekCache } from "./tenant-key";

/**
 * v2 field encryption against the real app_runtime role: per-tenant DEK
 * lifecycle in tenant_key (class A), AAD binding, v1 compatibility.
 */

const run = randomUUID().slice(0, 8);
const A = { id: randomUUID(), slug: `enc-a-${run}` };
const B = { id: randomUUID(), slug: `enc-b-${run}` };
const sys = { type: "system" } as const;

beforeAll(async () => {
  await withPlatform(
    { type: "system", job: "field-encryption-dbtest-seed" },
    "seed field-encryption fixtures",
    async (tx) => {
      for (const t of [A, B]) {
        await tx.tenant.create({ data: { id: t.id, name: t.slug, slug: t.slug, entitlements: {} } });
      }
    },
    { readOnly: false },
  );
});

afterAll(async () => {
  const platform = getPlatformClient();
  await platform.$transaction(async (tx) => {
    const ids = [A.id, B.id];
    await tx.tenantKey.deleteMany({ where: { tenantId: { in: ids } } });
    await tx.tenant.deleteMany({ where: { id: { in: ids } } });
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    await tx.auditEvent.deleteMany({ where: { tenantId: { in: ids } } });
  });
  await platform.$disconnect();
  await runtimeClient.$disconnect();
});

const ctxA = (over: Partial<EncryptionContext> = {}): EncryptionContext => ({
  tenantId: A.id,
  model: "CredentialSecret",
  rowId: newId(),
  field: "password",
  ...over,
});

describe("TenantKey lifecycle", () => {
  it("10 concurrent first-callers create exactly one ACTIVE tenant_key row", async () => {
    resetTenantDekCache();
    const deks = await Promise.all(
      Array.from({ length: 10 }, () =>
        withTenant(A.id, sys, (tx) => getActiveTenantDek(tx, A.id), { timeoutMs: 20_000 }),
      ),
    );
    const rows = await withTenant(A.id, sys, (tx) => tx.tenantKey.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: A.id, keyId: "t1", status: "ACTIVE" });
    expect(isEncryptedField(rows[0]!.wrappedDek)).toBe(true);
    for (const d of deks) {
      expect(d.keyId).toBe("t1");
      expect(d.dek.equals(deks[0]!.dek)).toBe(true);
    }
    // Exactly one tenant_key.created audit row, key ids only in metadata.
    const audits = await withTenant(A.id, sys, (tx) =>
      tx.auditEvent.findMany({ where: { action: "tenant_key.created" } }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toEqual({ keyId: "t1", rootKeyId: rows[0]!.rootKeyId });
  });

  it("the tenantId argument must match the withTenant() context", async () => {
    await expect(
      withTenant(B.id, sys, (tx) => getActiveTenantDek(tx, A.id)),
    ).rejects.toThrow(/does not match/);
  });

  it("a contact principal cannot read tenant_key rows", async () => {
    await withTenant(
      A.id,
      { type: "contact", id: randomUUID(), clientId: randomUUID() },
      async (tx) => {
        expect(await tx.tenantKey.count()).toBe(0);
        const raw = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant_key`;
        expect(raw[0]?.n).toBe(0);
      },
    );
  });
});

describe("v2 encrypt / decrypt", () => {
  it("round-trips in the v2.<rootKeyId>.<tenantKeyId>.<iv>.<ct>.<tag> format", async () => {
    const ctx = ctxA();
    const ct = await withTenant(A.id, sys, (tx) => encryptFieldV2(tx, ctx, "hunter2"));
    const parts = ct.split(".");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("v2");
    expect(parts[1]).toBe(process.env["FIELD_ENCRYPTION_KEY_ID"] ?? "k1");
    expect(parts[2]).toBe("t1");
    expect(isEncryptedFieldV2(ct)).toBe(true);
    expect(isEncryptedField(ct)).toBe(false);
    expect(await withTenant(A.id, sys, (tx) => decryptFieldV2(tx, ctx, ct))).toBe("hunter2");
    expect(await withTenant(A.id, sys, (tx) => decryptAnyField(tx, ctx, ct))).toBe("hunter2");
  });

  it("decrypts after the process cache is cleared (unwraps from the row)", async () => {
    const ctx = ctxA();
    const ct = await withTenant(A.id, sys, (tx) => encryptFieldV2(tx, ctx, "persisted"));
    resetTenantDekCache();
    expect(await withTenant(A.id, sys, (tx) => decryptFieldV2(tx, ctx, ct))).toBe("persisted");
  });

  it("AAD mismatch (rowId / field / model / tenantId) fails authentication", async () => {
    const ctx = ctxA();
    const ct = await withTenant(A.id, sys, (tx) => encryptFieldV2(tx, ctx, "bound"));
    for (const wrong of [
      { rowId: newId() },
      { field: "username" },
      { model: "CredentialVersion" },
    ]) {
      await expect(
        withTenant(A.id, sys, (tx) => decryptFieldV2(tx, { ...ctx, ...wrong }, ct)),
        JSON.stringify(wrong),
      ).rejects.toThrow();
    }
    // Wrong tenantId in ctx: rejected before any crypto (context mismatch)
    await expect(
      withTenant(A.id, sys, (tx) => decryptFieldV2(tx, { ...ctx, tenantId: B.id }, ct)),
    ).rejects.toThrow();
  });

  it("tenant B cannot decrypt tenant A's ciphertext even holding the string", async () => {
    const ctx = ctxA();
    const ct = await withTenant(A.id, sys, (tx) => encryptFieldV2(tx, ctx, "a-only"));
    // B has its own DEK under the same keyId "t1" — different key, auth fails.
    await withTenant(B.id, sys, (tx) => getActiveTenantDek(tx, B.id));
    await expect(
      withTenant(B.id, sys, (tx) => decryptFieldV2(tx, { ...ctx, tenantId: B.id }, ct)),
    ).rejects.toThrow();
    // Claiming A's context from inside B's unit of work is refused too.
    await expect(
      withTenant(B.id, sys, (tx) => decryptFieldV2(tx, ctx, ct)),
    ).rejects.toThrow(/does not match/);
  });

  it("v1 ciphertext still decrypts through decryptAnyField", async () => {
    const v1 = encryptField("legacy-secret");
    expect(await withTenant(A.id, sys, (tx) => decryptAnyField(tx, ctxA(), v1))).toBe(
      "legacy-secret",
    );
  });

  it("rejects unknown formats", async () => {
    await expect(
      withTenant(A.id, sys, (tx) => decryptAnyField(tx, ctxA(), "v3.a.b.c.d.e")),
    ).rejects.toThrow(/unknown format/);
    await expect(
      withTenant(A.id, sys, (tx) => decryptFieldV2(tx, ctxA(), "v1.k1.a.b.c")),
    ).rejects.toThrow(/unknown format/);
  });
});
