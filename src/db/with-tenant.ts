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
 * Interactive-transaction budget. 5 s is right next to the database
 * (Vercel Frankfurt ↔ Neon EU); a caller 100 ms away per round trip —
 * the GitHub-hosted runner in the US — blows it on ordinary multi-
 * statement work, so CI widens it through DB_TX_TIMEOUT_MS. Callers
 * with a known longer critical section still pass `timeoutMs`.
 */
const DEFAULT_TX_TIMEOUT_MS = Number(process.env["DB_TX_TIMEOUT_MS"]) || 5000;

export async function withTenant<T>(
  tenantId: string,
  principal: Principal,
  fn: (tx: TenantDb) => Promise<T>,
  opts?: { timeoutMs?: number },
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
        return fn(tx as unknown as TenantDb);
      },
      { timeout: opts?.timeoutMs ?? DEFAULT_TX_TIMEOUT_MS },
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
    { timeout: opts?.timeoutMs ?? DEFAULT_TX_TIMEOUT_MS },
  );

  // A READ ONLY transaction cannot hold its own audit row; every
  // invocation is still audited — immediately after commit.
  if (readOnly) {
    await platform.auditEvent.create({ data: auditData });
  }

  return result;
}
