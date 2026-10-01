import type { MemberActor } from "@/authz/authorize";
import { dbErrorMapper, type DbErrorTokens } from "@/lib/db-error-map";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { retryOnContention } from "@/lib/retry";

/**
 * Shared plumbing of the vault module (DATA_MODEL.md §6.17). Every service
 * takes a VaultCtx whose actor comes from requireTenantContext() — never
 * from a form — and runs under the member's own principal, so RLS is live
 * on every statement.
 */
export type VaultCtx = { readonly tenantId: string; readonly actor: MemberActor };

export const principalOf = (ctx: VaultCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

/** Database-raised invariants → DomainError (migration 20261001120000). */
const TOKENS: DbErrorTokens = [["CREDENTIAL_CLIENT_MISMATCH", "CLIENT_MISMATCH"]];

export const { guarded } = dbErrorMapper(TOKENS);

/**
 * An id from a caller, held to the one shape it may have before it can
 * reach a `where`. Prisma DROPS an `undefined` filter silently, so a
 * missing id must never get as far as `findFirst({ where: { id } })`,
 * where it would match some row rather than none (the 2026-08-31
 * incident; PLAN's "guard every server-action id with typeof string").
 */
export function idOf(raw: unknown, what: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) {
    throw new TypeError(`vault: ${what} must be a non-empty string`);
  }
  return raw;
}

/** How long a vault write waits for a row or advisory lock before it gives up. */
export const VAULT_LOCK_WAIT_MS = 3000;

/**
 * A lock wait bounded by `VAULT_LOCK_WAIT_MS`, retried a bounded number of
 * times, then a typed refusal — the request broker's and the download's
 * shape. Without the bound a statement parked on a lock ignores the
 * transaction's own timeout and holds its pooled connection until the
 * holder commits (the measured trap in `with-tenant.ts`).
 */
export async function boundedVaultWrite<T>(run: (opts: { lockTimeoutMs: number }) => Promise<T>): Promise<T> {
  try {
    return await retryOnContention(() => run({ lockTimeoutMs: VAULT_LOCK_WAIT_MS }));
  } catch (e) {
    if (isLockTimeout(e) || isDeadlock(e)) return fail("VAULT_BUSY", "lock waits spent");
    throw e;
  }
}
