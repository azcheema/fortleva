import { withPlatform } from "@/db";
import { DIGEST_SENDING_TENANT_STATUSES } from "@/notify/digest";
import { moveRenewalDatesOn } from "@/services/renewals";

/**
 * The agreements' renewals (Phase 4 slice 113; founder decision C88): once
 * a running recurring agreement's renewal day has passed, its date moves on
 * to the next renewal. The per-tenant body — what moves, where to, the
 * audit row — is the services module's (`moveRenewalDatesOn`); this file
 * only finds the tenants worth opening. Slice 113b adds the renewal
 * invoices, drafted before the dates move.
 *
 * Discovery is the one audited cross-tenant read (`withPlatform`, read-only)
 * and carries ids only: SENDING tenants (not suspended, offboarding or
 * closed — the digests' set) holding a running recurring agreement whose
 * renewal date is before tomorrow in UTC — a day's slack, since which day it
 * is for a tenant is decided inside its own transaction, from its own
 * preferences. Each tenant then runs under its OWN system principal with
 * RLS live, so nothing here can mix two tenants' rows.
 *
 * ONE TENANT'S FAILURE DOES NOT SKIP THE REST: it is counted and logged —
 * the tenant's id and the error's name and code, never its message, which
 * for a Prisma error prints the query's arguments — and the next tenant
 * runs. Idempotent: a date already moved is no longer due. BOUNDED: a minute
 * a run across every workspace, at most `MOVE_CAP` agreements per workspace,
 * workspaces in a fresh random order each run — so one workspace with
 * thousands of old-dated agreements can neither hold the route past the
 * backstops after it nor starve the others (the security review). Invoked by
 * `POST /api/jobs/run` until Vercel Cron exists — so that route now writes
 * agreements in every tenant of the database it runs against (AGENTS.md).
 */

const DAY_MS = 86_400_000;
/** The time one run may spend, across every workspace (slice 113's security review). */
export const RENEWALS_BUDGET_MS = 60_000;

/** A fair order: no workspace always goes first, and none can starve the rest run after run. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export async function runAgreementRenewals(
  now: Date = new Date(),
  opts: { readonly budgetMs?: number } = {},
): Promise<{ tenants: number; moved: number; agreementsFailed: number; failed: number; outOfTime: boolean }> {
  const deadline = Date.now() + (opts.budgetMs ?? RENEWALS_BUDGET_MS);
  const tenantIds = await withPlatform(
    { type: "system", job: "agreement-renewals" },
    "list tenants with a running recurring agreement whose renewal date has passed",
    async (tx) => {
      const due = await tx.service.findMany({
        where: {
          status: "ACTIVE",
          kind: "RECURRING",
          billingInterval: { not: null },
          renewsAt: { lt: new Date(now.getTime() + DAY_MS) },
          // One whose end has passed never renews again: not worth opening its
          // tenant for (two days' slack, for zones).
          OR: [{ endsAt: null }, { endsAt: { gte: new Date(now.getTime() - 2 * DAY_MS) } }],
          tenant: { status: { in: [...DIGEST_SENDING_TENANT_STATUSES] } },
        },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      return due.map((r) => r.tenantId);
    },
  );

  const out = { tenants: tenantIds.length, moved: 0, agreementsFailed: 0, failed: 0, outOfTime: false };
  for (const tenantId of shuffled(tenantIds)) {
    if (Date.now() >= deadline) {
      out.outOfTime = true; // the rest move on the next run
      break;
    }
    try {
      const r = await moveRenewalDatesOn(tenantId, now, { deadline });
      out.moved += r.moved;
      out.agreementsFailed += r.failed;
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`agreement-renewals: tenant ${tenantId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  return out;
}
