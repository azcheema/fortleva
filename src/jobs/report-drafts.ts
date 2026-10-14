import { withPlatform } from "@/db";
import { draftMonthlyReports } from "@/documents/report-drafts";
import { DIGEST_SENDING_TENANT_STATUSES } from "@/notify/digest";

/**
 * REPORTS DRAFTED BY THEMSELVES ON THE 1ST (Phase 7 slice 120; founder
 * decision C96): for the month that just ended in each workspace's zone,
 * every client with someone in the portal and something to show gets the
 * monthly report the Make a report button would make — private, waiting
 * for a person to add the team's words and publish it. The per-tenant body
 * — the gates, the ledger, the drawing, who is told — is the documents
 * module's (`draftMonthlyReports`); this file only finds the tenants worth
 * opening.
 *
 * Discovery is the one audited cross-tenant read (`withPlatform`, read-only)
 * and carries ids only: SENDING tenants (not suspended, offboarding or
 * closed — the digests' set) holding a contact with portal access (an
 * audience exists somewhere). Which month it is for a tenant, whether its
 * switch is on and its reports module open, is decided inside its own
 * transaction, from its own preferences. Each tenant then runs under its
 * OWN system principal with RLS live, so nothing here can mix two tenants'
 * rows.
 *
 * ONE TENANT'S FAILURE DOES NOT SKIP THE REST: it is counted and logged —
 * the tenant's id and the error's name and code, never its message — and
 * the next tenant runs. Idempotent and hourly-safe: a (client, month) is
 * decided once (the ledger). BOUNDED: 45 seconds a kick across every
 * workspace, workspaces in a fresh random order each kick, at most 100
 * clients a workspace a kick. Invoked by `POST /api/jobs/run` until Vercel
 * Cron exists — so that route now DRAFTS REPORTS, uploading a PDF per
 * client per month, in every sending tenant of the database it runs against
 * whose switch is on (AGENTS.md).
 */

/** The time one kick may spend, across every workspace. */
export const REPORT_DRAFTS_BUDGET_MS = 45_000;

/** A fair order: no workspace always goes first, and none can starve the rest kick after kick. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export async function runReportDrafts(
  now: Date = new Date(),
  opts: { readonly budgetMs?: number } = {},
): Promise<{ tenants: number; considered: number; drafted: number; failed: number; outOfTime: boolean }> {
  const deadline = Date.now() + (opts.budgetMs ?? REPORT_DRAFTS_BUDGET_MS);
  const tenantIds = await withPlatform(
    { type: "system", job: "report-drafts" },
    "list sending tenants with a contact who has portal access",
    async (tx) => {
      const rows = await tx.contact.findMany({
        where: { portalStatus: "ACTIVE", tenant: { status: { in: [...DIGEST_SENDING_TENANT_STATUSES] } } },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      return rows.map((r) => r.tenantId);
    },
  );

  const out = { tenants: tenantIds.length, considered: 0, drafted: 0, failed: 0, outOfTime: false };
  for (const tenantId of shuffled(tenantIds)) {
    if (Date.now() >= deadline) {
      out.outOfTime = true; // the rest are considered next kick
      break;
    }
    try {
      const r = await draftMonthlyReports(tenantId, now, { deadline });
      out.considered += r.considered;
      out.drafted += r.drafted;
      out.failed += r.byOutcome.FAILED;
      if (r.outOfTime) out.outOfTime = true;
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`report-drafts: tenant ${tenantId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  return out;
}
