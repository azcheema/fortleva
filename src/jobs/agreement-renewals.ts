import { withPlatform } from "@/db";
import { LINE_TEXT_MAX } from "@/modules/invoicing/drafts";
import { readFixed } from "@/modules/invoicing/money";
import { agreementHoldsDate } from "@/modules/invoicing/renewal-plan";
import { draftRenewalInvoices } from "@/modules/invoicing/renewals";
import { DIGEST_SENDING_TENANT_STATUSES } from "@/notify/digest";
import { moveRenewalDatesOn, type MoveHold } from "@/services/renewals";

/**
 * The agreements' renewals (Phase 4 slice 113; founder decision C88): once
 * a running recurring agreement's renewal day has passed, its date moves on
 * to the next renewal — and (slice 113b, C88 (a)) 14 days before it renews,
 * its invoice is DRAFTED, per tenant BEFORE its dates move (so a period that
 * starts today is drafted before its date moves on). The per-tenant bodies
 * are the invoicing module's (`draftRenewalInvoices`) and the services
 * module's (`moveRenewalDatesOn`); this file only finds the tenants worth
 * opening. While its invoicing is open, a tenant's dates move under a HOLD
 * per agreement (`agreementHoldsDate`): one whose started period is still
 * owed a draft — its group failed, the time budget or a cap cut it — keeps
 * its date and is drafted late on a later run (`renewal-plan.ts`); every
 * other agreement moves (the reviews of 113b: never a whole workspace held).
 *
 * Discovery is the one audited cross-tenant read (`withPlatform`, read-only)
 * and carries ids only: SENDING tenants (not suspended, offboarding or
 * closed — the digests' set) holding a running recurring agreement whose
 * renewal date is within the next 16 days in UTC (14 to draft, a day either
 * side for zones) or already passed — which day it is for a tenant is
 * decided inside its own transaction, from its own preferences. Each tenant then runs under its OWN system principal with
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
/** Drafting's 14 days, plus a day either side for zones (slice 113b). */
const LOOK_AHEAD_DAYS = 16;
/** How long after an end its tenant is still opened — for a period owed late. */
const ENDED_SLACK_DAYS = 62;
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
): Promise<{
  tenants: number;
  drafted: number;
  invoices: number;
  moved: number;
  held: number;
  agreementsFailed: number;
  failed: number;
  outOfTime: boolean;
}> {
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
          renewsAt: { lt: new Date(now.getTime() + LOOK_AHEAD_DAYS * DAY_MS) },
          // One whose end passed long ago never renews again: not worth opening
          // its tenant for. Two months' slack, not two days' (the re-check's
          // low): a period owed LATE — an outage, a group that failed — may end
          // inside it, and its tenant must still be opened to draft it.
          OR: [{ endsAt: null }, { endsAt: { gte: new Date(now.getTime() - ENDED_SLACK_DAYS * DAY_MS) } }],
          tenant: { status: { in: [...DIGEST_SENDING_TENANT_STATUSES] } },
        },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      return due.map((r) => r.tenantId);
    },
  );

  const out = { tenants: tenantIds.length, drafted: 0, invoices: 0, moved: 0, held: 0, agreementsFailed: 0, failed: 0, outOfTime: false };
  for (const tenantId of shuffled(tenantIds)) {
    if (Date.now() >= deadline) {
      out.outOfTime = true; // the rest move on the next run
      break;
    }
    try {
      // Drafting's own failure never stops the dates moving: with the hold, an
      // agreement still owed keeps its date whatever went wrong (an unknown
      // module state counts as open — holding is the safe side).
      let closed = false;
      try {
        const d = await draftRenewalInvoices(tenantId, now, { deadline });
        out.drafted += d.drafted;
        out.invoices += d.invoices;
        out.agreementsFailed += d.failed;
        closed = d.closed;
      } catch (e) {
        out.failed += 1;
        const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
        console.error(`agreement-renewals: tenant ${tenantId} drafting failed: ${e instanceof Error ? e.name : typeof e}${code}`);
      }
      // Its invoicing open, a started period still owed holds its agreement's date.
      const hold: MoveHold | undefined = closed
        ? undefined
        : (facts, today) =>
            agreementHoldsDate(
              { ...facts, price: facts.price === null ? null : readFixed(facts.price, 2) },
              today,
              LINE_TEXT_MAX.description,
            );
      const r = await moveRenewalDatesOn(tenantId, now, { deadline, hold });
      out.moved += r.moved;
      out.held += r.held;
      out.agreementsFailed += r.failed;
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`agreement-renewals: tenant ${tenantId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  return out;
}
