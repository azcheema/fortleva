import type { NextRequest } from "next/server";

import { csvFileStem } from "@/lib/csv";
import { badRequest, crossSiteRefusal, csvResponse, downloadFailure } from "@/lib/http-download";
import { isIsoDate } from "@/lib/week";
import { requireTenantContext } from "@/members/tenant-context";
import { entriesCsv, exportEntries, exportStatement, isMonth, statementCsv } from "@/modules/time";

/**
 * GET /time/export — the time module's CSV downloads (PLAN.md 2T
 * "CSV exports" + D1 statement; SECURITY.md §9.7.3):
 *
 *   ?kind=entries&from=YYYY-MM-DD&to=YYYY-MM-DD            own rows (time:track)
 *   ?kind=team&from&to[&member=<id>][&project=<id>]         team rows (time:export + time:view_team, in scope)
 *   ?kind=statement&month=YYYY-MM[&member=<id>]             working-time statement (own: time:track;
 *                                                           another member: time:view_team + time:export)
 *
 * Tenant and member come from the session (requireTenantContext), never
 * from the query; the service authorises, scopes and audits
 * (`time.exported`). Cost is never here — the only cost-bearing export
 * is the project rollup behind its ✦ reveal (projects/[key]/time/export).
 * A same-origin attachment, `no-store` (ARC-25: nothing tenant-scoped is
 * ever cached).
 */
export async function GET(request: NextRequest): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const sp = request.nextUrl.searchParams;
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const kind = sp.get("kind") ?? "entries";
  const idOf = (name: string): string | undefined => {
    const v = sp.get(name);
    return v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined;
  };

  try {
    if (kind === "statement") {
      const month = sp.get("month");
      if (!isMonth(month)) return badRequest("month");
      const memberId = idOf("member");
      const statement = await exportStatement(ctx, { month, ...(memberId ? { memberId } : {}) });
      return csvResponse(statementCsv(statement), `${csvFileStem("working-time", statement.memberName, statement.month)}.csv`);
    }

    const from = sp.get("from");
    const to = sp.get("to");
    if (!isIsoDate(from) || !isIsoDate(to)) return badRequest("range");
    const range = { from, to };

    if (kind === "team") {
      const memberId = idOf("member");
      const projectId = idOf("project");
      const e = await exportEntries(ctx, range, {
        scope: "team",
        ...(memberId ? { memberId } : {}),
        ...(projectId ? { projectId } : {}),
      });
      return csvResponse(entriesCsv(e), `${csvFileStem("time-entries-team", from, to)}.csv`);
    }

    const e = await exportEntries(ctx, range, { scope: "own" });
    return csvResponse(entriesCsv(e), `${csvFileStem("time-entries", from, to)}.csv`);
  } catch (e) {
    return downloadFailure(e, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  }
}
