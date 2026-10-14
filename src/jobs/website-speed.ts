import { withPlatform } from "@/db";
import { cruxTransport } from "@/integrations/crux";
import { fetchWebsiteSpeed } from "@/modules/reports/speed-fetch";
import { DIGEST_SENDING_TENANT_STATUSES } from "@/notify/digest";

/**
 * THE WEEKLY SPEED FETCH (Phase 6 slice 118; founder decision C94 (c)) —
 * every measured site asked of Google and the answers kept as Fortleva's
 * own copy. The per-workspace body is the reports module's
 * (`fetchWebsiteSpeed`, `src/modules/reports/speed-fetch.ts`); this file
 * only finds the workspaces worth opening.
 *
 * NOTHING AT ALL while `CRUX_TRANSPORT` is off — the default everywhere.
 *
 * Discovery is the one audited cross-tenant read (`withPlatform`, read-only)
 * and carries ids only: SENDING tenants (not suspended, offboarding or
 * closed — the digests' set) with at least one not-archived project carrying
 * a Production URL. Each workspace then runs under its OWN system principal
 * with RLS live, and decides the rest itself (the module open, which
 * projects are due this week).
 *
 * ONE WORKSPACE'S FAILURE DOES NOT SKIP THE REST: counted and logged — the
 * tenant's id and the error's name and code, never its message. BOUNDED:
 * 45 seconds a run across every workspace, in a fresh random order; Google's
 * per-minute quota, once met, ends the run for every workspace (it is per
 * Google project, shared). Invoked by `POST /api/jobs/run` — so that route
 * ASKS GOOGLE about every measured site of the database it runs against
 * whenever the transport is live (AGENTS.md).
 */

export const SPEED_BUDGET_MS = 45_000;

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export type WebsiteSpeedJob = {
  readonly tenants: number;
  readonly projects: number;
  readonly weeks: number;
  readonly noData: number;
  readonly refused: number;
  readonly failed: number;
  readonly skipped: number;
  readonly outOfTime: boolean;
  readonly outOfQuota: boolean;
};

export async function runWebsiteSpeed(now: Date = new Date(), opts: { readonly budgetMs?: number } = {}): Promise<WebsiteSpeedJob | { readonly off: true }> {
  const transport = cruxTransport();
  if (!transport) return { off: true };
  const deadline = Date.now() + (opts.budgetMs ?? SPEED_BUDGET_MS);
  const tenantIds = await withPlatform(
    { type: "system", job: "website-speed" },
    "list workspaces with a measured site",
    async (tx) => {
      const rows = await tx.project.findMany({
        where: {
          archivedAt: null,
          productionUrl: { not: null },
          tenant: { status: { in: [...DIGEST_SENDING_TENANT_STATUSES] } },
        },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      return rows.map((r) => r.tenantId);
    },
  );

  const out = { tenants: tenantIds.length, projects: 0, weeks: 0, noData: 0, refused: 0, failed: 0, skipped: 0, outOfTime: false, outOfQuota: false };
  for (const tenantId of shuffled(tenantIds)) {
    if (Date.now() >= deadline) {
      out.outOfTime = true; // the rest go on the next run
      break;
    }
    try {
      const r = await fetchWebsiteSpeed(tenantId, { transport, now, deadline });
      if (r.skipped !== null) out.skipped += 1;
      out.projects += r.projects;
      out.weeks += r.weeks;
      out.noData += r.noData;
      out.refused += r.refused;
      out.failed += r.failed;
      if (r.outOfTime) out.outOfTime = true;
      // The quota and the key are per Google project: either ends the run.
      if (r.outOfQuota || r.keyRefused) {
        out.outOfQuota = true;
        break;
      }
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`website-speed: tenant ${tenantId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  return out;
}
