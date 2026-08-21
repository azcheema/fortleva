import type { NextRequest } from "next/server";

import { csvFileStem } from "@/lib/csv";
import { badRequest, crossSiteRefusal, csvResponse, downloadFailure } from "@/lib/http-download";
import { isIsoDate } from "@/lib/week";
import { requireTenantContext } from "@/members/tenant-context";
import { entriesCsv, exportEntries, exportProjectRollup, rollupCsv } from "@/modules/time";

import { loadProject } from "../../data";

/**
 * GET /projects/[key]/time/export — one project's CSV (time:export +
 * time:view_team + scope; PLAN.md 2T "CSV (raw hours, no cost by
 * default)"):
 *
 *   ?from&to                 the project's closed entries (rate/amount columns with rate:view_bill)
 *   ?from&to&kind=rollup     the Time-tab rollup lines (member / task / epic / agreement / work type + total)
 *   …&cost=1                 the ✦ ask: cost + margin columns ONLY when the audited reveal passes
 *                            (rate:view_cost + the tenant's cost layer + a fresh factor — a stale
 *                            factor is step-up and back to this URL; no permission = no cost, silently)
 *
 * The project resolves through the same loader as its pages (out of
 * scope ⇒ not found); the service audits `time.exported` with
 * `includesCost` stating what the file actually contains.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const { key } = await params;
  const project = await loadProject(key);
  const sp = request.nextUrl.searchParams;
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const from = sp.get("from");
  const to = sp.get("to");
  if (!isIsoDate(from) || !isIsoDate(to)) return badRequest("range");
  const range = { from, to };

  try {
    if (sp.get("kind") === "rollup") {
      const e = await exportProjectRollup(ctx, project.id, range, { includeCost: sp.get("cost") === "1" });
      const stem = csvFileStem("time-rollup", project.key, from, to, e.includesCost ? "with-cost" : null);
      return csvResponse(rollupCsv(e), `${stem}.csv`);
    }
    const e = await exportEntries(ctx, range, { scope: "team", projectId: project.id });
    return csvResponse(entriesCsv(e), `${csvFileStem("time-entries", project.key, from, to)}.csv`);
  } catch (e) {
    return downloadFailure(e, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  }
}
