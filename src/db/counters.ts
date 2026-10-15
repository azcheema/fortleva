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

/**
 * Take one counter's row lock WITHOUT drawing a number — the same upsert,
 * `+ 0` (a missing row is created at 0, so the next draw is 1, exactly as
 * `nextCounter` would have made it). For a writer that must hold the counter
 * BEFORE another lock because every other writer takes the two in that
 * order: an import batch takes `work_item:<projectId>` before the project's
 * rank queue, as `createItem` and a portal request do (`rank-lock.ts`, THE
 * ONE ORDER; the slice-121 code review's MEDIUM — the opposite order
 * deadlocked an import against a hand-made task). Re-entrant: a later
 * `nextCounters` on the same key in the same transaction waits on nothing.
 */
export async function lockCounter(tx: TenantDb, key: string): Promise<void> {
  const ctx = tenantContextStorage.getStore();
  if (!ctx) throw new Error("lockCounter: must run inside withTenant()");
  await tx.$executeRaw`
    INSERT INTO tenant_counter (tenant_id, key, value)
    VALUES (${ctx.tenantId}, ${key}, 0)
    ON CONFLICT (tenant_id, key)
    DO UPDATE SET value = tenant_counter.value`;
}

/**
 * `n` consecutive numbers from one counter in ONE statement — the same
 * upsert, `+ n` instead of `+ 1` — for a writer that makes many rows at once
 * (an import batch: Phase 6 slice 121). The row lock serialises it with
 * every `nextCounter` on the same key exactly as before, so the block is
 * the caller's alone: `[last − n + 1, …, last]`, ascending.
 */
export async function nextCounters(tx: TenantDb, key: string, n: number): Promise<number[]> {
  if (!Number.isInteger(n) || n < 1) throw new Error("nextCounters: n must be a positive integer");
  const ctx = tenantContextStorage.getStore();
  if (!ctx) throw new Error("nextCounters: must run inside withTenant()");
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO tenant_counter (tenant_id, key, value)
    VALUES (${ctx.tenantId}, ${key}, ${n}::int)
    ON CONFLICT (tenant_id, key)
    DO UPDATE SET value = tenant_counter.value + ${n}::int
    RETURNING value`;
  const last = rows[0]?.value;
  if (last === undefined) throw new Error("nextCounters: upsert returned no row");
  return Array.from({ length: n }, (_, i) => last - n + 1 + i);
}
