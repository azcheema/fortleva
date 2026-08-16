import { tenantContextStorage } from "./context";
import type { TenantDb } from "./with-tenant";

/**
 * Monotonic per-tenant counters for human-facing numbers with NO
 * legal gap-free requirement (DATA_MODEL.md TenantCounter; invoices use
 * InvoiceSeries, never this). One atomic upsert: concurrent callers
 * serialise on the (tenant_id, key) row lock and never see a duplicate.
 * The tenant id comes from the withTenant() context, never a parameter.
 */
export async function nextCounter(tx: TenantDb, key: string): Promise<number> {
  const ctx = tenantContextStorage.getStore();
  if (!ctx) throw new Error("nextCounter: must run inside withTenant()");
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO tenant_counter (tenant_id, key, value)
    VALUES (${ctx.tenantId}, ${key}, 1)
    ON CONFLICT (tenant_id, key)
    DO UPDATE SET value = tenant_counter.value + 1
    RETURNING value`;
  const value = rows[0]?.value;
  if (value === undefined) throw new Error("nextCounter: upsert returned no row");
  return value;
}
