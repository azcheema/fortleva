import { record } from "@/audit/record";
import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { isUuid } from "@/db/context";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";

import { guarded } from "./db-errors";
import { memberPrincipal, type ContractsCtx } from "./templates";

/**
 * "REMIND BEFORE IT ENDS" (Phase 4 slice 112c3; founder decision C87 (a)) — a
 * SIGNED contract's end is reminded at 60 / 30 / 14 / 7 / 1 days and listed on
 * Renewals (slice 112c2) until someone turns that off: a contract that has
 * been renewed, or will not be. Off stamps `reminders_stopped_at` with the
 * database's clock; on clears it, and the reminders still to come go out again
 * (a band already sent never is — its dedupe row stands).
 *
 * `contract:edit` ("people who can edit contracts", C87 (a)) → the client in
 * DIRECT scope → the contract locked FOR UPDATE (its metadata only, never the
 * body) → SIGNED, else `CONTRACT_NOT_SIGNED` → nothing when it is already so →
 * the UPDATE → `contract.reminders_changed` in the same transaction. The
 * database holds every rule again (`contract_guard`, migration
 * 20261016090000: by a holder of the code, as themselves, on a signed
 * contract, on its own, stamped now).
 */
export async function setContractReminders(ctx: ContractsCtx, rawId: unknown, rawOn: unknown): Promise<void> {
  if (typeof rawId !== "string" || !isUuid(rawId)) return fail("INVALID_INPUT", "contract");
  if (typeof rawOn !== "boolean") return fail("INVALID_INPUT", "on");
  const id: string = rawId;
  const on: boolean = rawOn;
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:edit");
      // The scope FIRST, on an unlocked read (a contract's client never changes).
      const seen = await tx.contract.findFirst({ where: { tenantId: ctx.tenantId, id }, select: { clientId: true } });
      if (!seen) return deny("NOT_FOUND", "contract");
      await assertInScope(tx, ctx.actor, { clientId: seen.clientId });
      const rows = await tx.$queryRaw<{ id: string; client_id: string; status: string; stopped: boolean }[]>`
        SELECT id, client_id, status::text AS status, reminders_stopped_at IS NOT NULL AS stopped
          FROM contract WHERE tenant_id = ${ctx.tenantId} AND id = ${id} FOR UPDATE`;
      const row = rows[0];
      if (!row) return deny("NOT_FOUND", "contract");
      if (row.status !== "SIGNED") fail("CONTRACT_NOT_SIGNED");
      if (row.stopped === !on) return;
      // The database's clock for a stop — the STATEMENT's, which the guard
      // holds it to: `now()` is the transaction's start, and a long wait for
      // the lock above would put it outside the guard's window (the security
      // review's note).
      await tx.$executeRaw`
        UPDATE contract SET reminders_stopped_at = CASE WHEN ${on}::boolean THEN NULL ELSE statement_timestamp() END
         WHERE tenant_id = ${ctx.tenantId} AND id = ${row.id} AND status = 'SIGNED'`;
      await record(tx, {
        action: "contract.reminders_changed",
        targetType: "Contract",
        targetId: row.id,
        metadata: { clientId: row.client_id, on },
      });
    }),
  );
}
