import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import { getPlatformClient, runtimeClient } from "./client";
import { isUuid, tenantContextStorage, type Principal } from "./context";

/**
 * The unit-of-work seam (TENANCY.md §4). One interactive transaction on
 * the pooled app_runtime connection; GUCs set transaction-locally as
 * the FIRST statement (is_local = true is load-bearing: Neon's pooler
 * is PgBouncer in transaction mode — a session-scoped GUC would leak
 * tenant identity to the next borrower of the server connection).
 */

export type TenantDb = Omit<
  typeof runtimeClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * Interactive-transaction budgets. 5 s is right next to the database
 * (Vercel Frankfurt ↔ Neon EU); a caller 100 ms away per round trip
 * blows it on ordinary multi-statement work, so DB_TX_TIMEOUT_MS widens
 * it. Every budget scales by the same LINK FACTOR: the default, a
 * caller's explicit `timeoutMs` (stated for the fast path — LOCKED_TX
 * 15 s was 223 ms short for 8 serialised starts across that link), and
 * Prisma's `maxWait` (2 s to acquire a connection — 25 parallel
 * transactions exhaust it on the slow link). Factor 1 wherever the
 * variable is unset.
 *
 * WHO SETS IT (amended 2026-09-01): nothing in the ordinary CI pipeline
 * any more. Both db jobs run against a Postgres service container on
 * the runner (~0.1 ms), so they exercise these DEFAULTS — the first
 * time the shipped budgets have been under test at all. The widened
 * factor-4 values survive only in `.github/workflows/neon-smoke.yml`,
 * the manual job that still crosses the Atlantic to the real Neon.
 */
const BASE_TX_TIMEOUT_MS = 5000;
const BASE_TX_MAX_WAIT_MS = 2000;
const DEFAULT_TX_TIMEOUT_MS = Number(process.env["DB_TX_TIMEOUT_MS"]) || BASE_TX_TIMEOUT_MS;
const LINK_FACTOR = DEFAULT_TX_TIMEOUT_MS / BASE_TX_TIMEOUT_MS;
const txOptions = (timeoutMs?: number): { timeout: number; maxWait: number } => ({
  timeout: timeoutMs ? Math.round(timeoutMs * LINK_FACTOR) : DEFAULT_TX_TIMEOUT_MS,
  maxWait: Math.round(BASE_TX_MAX_WAIT_MS * LINK_FACTOR),
});

/**
 * `lockTimeoutMs` — how long a statement in this transaction may WAIT
 * for a row lock before Postgres cancels it (SQLSTATE 55P03). Distinct
 * from `timeoutMs`, and NOT covered by it — measured, because assuming
 * otherwise is what left the portal switch exposed. `timeoutMs` becomes
 * Prisma's interactive-transaction timeout, which is enforced around
 * the queries the client ISSUES, not inside one the DATABASE has parked
 * on a lock: a blocked statement under a 3 s transaction budget was
 * still waiting past 30 s (`src/projects/portal-contention.dbtest.ts`).
 * So a blocked writer that does not ask for this has no reliable end to
 * its wait at all, while holding every lock it had already taken; with
 * it, contention ends at a known bound, in an error its caller can tell
 * apart and retry.
 *
 * IT IS EMITTED ONLY WHEN ASKED FOR, and that is deliberate rather than
 * tidy (review). The first cut sent `'0'` for every caller on the
 * grounds that 0 is Postgres's own default, which is true of this
 * datasource today and was checked — but it would have PINNED the
 * unbounded case into the one seam all tenant work passes through. A
 * later `ALTER ROLE app_runtime SET lock_timeout = '10s'`, the textbook
 * hardening against exactly the hang this exists to end, would have
 * been silently reset to "wait forever" by the first statement of every
 * transaction in the product, and no test could have seen it: with the
 * server default at 0 the pin is invisible. A caller that says nothing
 * now gets whatever the operator configured.
 *
 * It scales by the same LINK FACTOR as the rest: the wait needed
 * depends on how long the HOLDER takes, and the holder is as far from
 * the database as we are. Clamped to at least 1 ms, because a rounded-
 * down 0 does not mean "no wait" to Postgres — it means "wait forever",
 * so the arithmetic must not be able to reach it.
 *
 * NOTE FOR FUTURE CALLERS: `lock_timeout` covers ADVISORY locks too. A
 * caller that passes this AND takes `lockProjectRanks` or the
 * `milestone_rank:` queue bounds its wait in that queue as well — and
 * that queue is designed to wait.
 */
const lockTimeoutSetting = (lockTimeoutMs: number): string =>
  String(Math.max(1, Math.round(lockTimeoutMs * LINK_FACTOR)));

export async function withTenant<T>(
  tenantId: string,
  principal: Principal,
  fn: (tx: TenantDb) => Promise<T>,
  opts?: { timeoutMs?: number; lockTimeoutMs?: number },
): Promise<T> {
  if (!isUuid(tenantId)) {
    throw new Error("withTenant: tenantId is not a UUID");
  }
  if (principal.type === "contact" && !isUuid(principal.clientId)) {
    throw new Error("withTenant: contact principal requires a client UUID");
  }

  const clientId = principal.type === "contact" ? principal.clientId : "";
  // app.principal_id (TENANCY.md §4.1): the member/contact id so
  // RESTRICTIVE policies can pin a row to THIS principal; empty for
  // system / platform_admin (fail-closed: '' matches no id).
  const principalId =
    principal.type === "member" || principal.type === "contact" ? principal.id : "";

  return tenantContextStorage.run({ tenantId, principal }, () =>
    runtimeClient.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT set_config('app.tenant_id', ${tenantId}, true),
                 set_config('app.principal', ${principal.type}, true),
                 set_config('app.client_id', ${clientId}, true),
                 set_config('app.principal_id', ${principalId}, true)`;
        // Its own statement, and only for a caller that asked: see
        // lockTimeoutSetting. One extra round trip for the one caller
        // that wants a bound, and a byte-identical preamble for every
        // caller that does not.
        if (opts?.lockTimeoutMs !== undefined) {
          await tx.$queryRaw`
            SELECT set_config('lock_timeout', ${lockTimeoutSetting(opts.lockTimeoutMs)}, true)`;
        }
        return fn(tx as unknown as TenantDb);
      },
      txOptions(opts?.timeoutMs),
    ),
  );
}

/**
 * The sanctioned, audited cross-tenant entry point (TENANCY.md §12).
 * Runs as app_platform (BYPASSRLS). Read-only by default; every
 * invocation writes an AuditEvent with a MANDATORY reason in the same
 * transaction. Impersonation does NOT use this — it runs withTenant()
 * as the impersonated member with RLS fully active.
 */
export type PlatformActor =
  | { type: "platform_admin"; userId: string }
  | { type: "system"; job: string };

export async function withPlatform<T>(
  actor: PlatformActor,
  reason: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts?: { readOnly?: boolean; targetTenantId?: string; timeoutMs?: number },
): Promise<T> {
  if (!reason.trim()) {
    throw new Error("withPlatform: a reason is mandatory");
  }
  const readOnly = opts?.readOnly ?? true;
  const platform: PrismaClient = getPlatformClient();

  const auditData = {
    tenantId: opts?.targetTenantId ?? null,
    actorType: (actor.type === "system" ? "SYSTEM" : "PLATFORM_ADMIN") as
      | "SYSTEM"
      | "PLATFORM_ADMIN",
    actorId: actor.type === "platform_admin" ? actor.userId : null,
    action: actor.type === "system" ? "platform.system_job" : "platform.tenant_access",
    metadata: {
      reason,
      readOnly,
      ...(actor.type === "system" ? { job: actor.job } : {}),
    },
    // Access touching a specific tenant appears in THAT tenant's own
    // log (TENANCY.md §12); pure platform events stay PLATFORM.
    visibility: (opts?.targetTenantId ? "TENANT" : "PLATFORM") as "TENANT" | "PLATFORM",
  };

  const result = await platform.$transaction(
    async (tx) => {
      if (readOnly) {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return fn(tx);
      }
      // Writes: audit row in the SAME transaction as the mutation.
      const value = await fn(tx);
      await tx.auditEvent.create({ data: auditData });
      return value;
    },
    txOptions(opts?.timeoutMs),
  );

  // A READ ONLY transaction cannot hold its own audit row; every
  // invocation is still audited — immediately after commit.
  if (readOnly) {
    await platform.auditEvent.create({ data: auditData });
  }

  return result;
}
