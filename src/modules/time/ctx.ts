import type { MemberActor } from "@/authz/authorize";
import type { TenantDb } from "@/db";
import { DomainError, type DomainErrorCode } from "@/lib/domain-error";
import { readPreferences, type TenantPreferences } from "@/preferences/service";

/**
 * Shared plumbing of the time module (ARC-16 module vocabulary;
 * DATA_MODEL.md §6.15). Every service takes a TimeCtx whose actor comes
 * from requireTenantContext() — never from a form.
 */
export type TimeCtx = { readonly tenantId: string; readonly actor: MemberActor };

export const principalOf = (ctx: TimeCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

/**
 * Transactions that take the member lock may queue behind each other
 * (a double-click, a pill and a hotkey racing): the critical section is
 * kept to a handful of statements — every read runs BEFORE the lock —
 * and the transaction is allowed longer than the 5 s default so a
 * waiter on a slow link still lands instead of expiring mid-lock.
 */
export const LOCKED_TX = { timeoutMs: 15_000 } as const;

/**
 * Serialise one member's timer / shift / break writes: the pinned
 * `pg_advisory_xact_lock(hashtext(tenant || member))` (plan §3.3). A
 * transaction-scoped lock is the only kind that is safe behind Neon's
 * transaction-mode pooler (spike 2026-08-20).
 */
export async function lockMember(tx: TenantDb, tenantId: string, memberId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${memberId}`}))`;
}

/** The zone a row is written in: Member.timezone → tenant `ui.timezone`. */
export async function resolveZone(
  tx: TenantDb,
  tenantId: string,
  memberId: string,
): Promise<{ timezone: string; prefs: TenantPreferences }> {
  const [member, prefs] = await Promise.all([
    tx.member.findFirst({ where: { tenantId, id: memberId }, select: { timezone: true } }),
    readPreferences(tx, tenantId),
  ]);
  return { timezone: member?.timezone ?? prefs.timezone, prefs };
}

/**
 * Database-raised invariants → DomainError. The 2T migration's triggers
 * RAISE with a stable leading token; partial uniques and the EXCLUDE
 * surface as Prisma P2002 / raw errors whose message names the index.
 * Anything else is rethrown untouched (a bug, not a business rule).
 */
const TOKENS: readonly (readonly [string, DomainErrorCode])[] = [
  ["ENTRY_LOCKED", "ENTRY_LOCKED"],
  ["SERVICE_CLIENT_MISMATCH", "SERVICE_CLIENT_MISMATCH"],
  ["RATE_CARD_IMMUTABLE", "RATE_CARD_IMMUTABLE"],
  ["REPORT_IMMUTABLE", "REPORT_IMMUTABLE"],
  ["BREAK_OUT_OF_BOUNDS", "BREAK_OUT_OF_BOUNDS"],
  ["SHIFT_SHRINK", "SHIFT_SHRINK"],
  ["time_entry_one_running", "TIMER_ALREADY_RUNNING"],
  ["shift_one_open", "SHIFT_ALREADY_OPEN"],
  ["shift_break_one_open", "BREAK_ALREADY_OPEN"],
  ["rate_card_no_overlap", "RATE_OVERLAP"],
  ["work_type_name_live", "WORK_TYPE_TAKEN"],
];

export function mapDbError(e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  // Prisma 7 + the pg adapter: for a hand-written partial unique the
  // top-level message says "Unique constraint failed on the (not
  // available)" and `meta.target` is absent — the constraint name is
  // only in meta.driverAdapterError.cause.originalMessage. Scan the whole
  // meta rather than one field, so every token above is found wherever
  // the adapter happens to put it.
  let meta = "";
  try {
    meta = JSON.stringify((e as { meta?: unknown } | null)?.meta ?? "");
  } catch {
    meta = "";
  }
  for (const [token, code] of TOKENS) {
    if (message.includes(token) || meta.includes(token)) throw new DomainError(code);
  }
  throw e;
}

/** Run a transaction body and translate DB-raised invariants. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    return mapDbError(e);
  }
}

/** Metadata helper: ids only — never names, never amounts (SECURITY.md §9.7.4). */
export const idsOnly = (o: Record<string, string | number | boolean | null | undefined>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Record<
    string,
    string | number | boolean
  >;
