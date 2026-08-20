import { ChevronLeftIcon, ChevronRightIcon, FileTextIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { DataTable, EmptyState, MetricTile, ProgressMeter, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { withTenant } from "@/db";
import { resolveTimeZone } from "@/i18n/resolve";
import { localDateString } from "@/lib/duration";
import { formatDuration, formatMoney } from "@/lib/format";
import { isIsoDate, monthContaining } from "@/lib/week";
import { requireTenantContext } from "@/members/tenant-context";
import { getProjectBudget, projectRollup, type RollupLine } from "@/modules/time";
import { readPreferences } from "@/preferences/service";

import { loadProject } from "../data";
import { BudgetCard } from "./budget-card";

/**
 * /projects/[key]/time (UI.md §3.1; PLAN.md 2T screens): a month range,
 * the totals strip (logged / billable / value / estimate), the budget
 * burn, and the flat rollups — by member (× ISO week), by task/epic, by
 * agreement, by work type. time:view_team + scope; money columns only
 * with rate:view_bill; cost never here (the finance page is separate).
 * Reports (D3) live in the sub-view.
 */
export default async function ProjectTimePage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { key } = await params;
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("projects.time");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();
  const timezone = await resolveTimeZone();
  const sp = await searchParams;
  const prefs = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
    readPreferences(tx, membership.tenantId),
  );
  const today = localDateString(new Date(), timezone);
  const month = monthContaining(today);
  const range = { from: isIsoDate(sp.from) ? sp.from : month.from, to: isIsoDate(sp.to) ? sp.to : month.to };

  let rollup: Awaited<ReturnType<typeof projectRollup>> | null = null;
  let budget: Awaited<ReturnType<typeof getProjectBudget>> = null;
  let canManageBudget = false;
  try {
    rollup = await projectRollup(ctx, project.id, range);
    try {
      budget = await getProjectBudget(ctx, project.id);
    } catch (e) {
      if (!(e instanceof AuthzError)) throw e;
    }
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (rollup) {
    canManageBudget = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, async (tx) => {
      const { isAuthorized } = await import("@/authz/authorize");
      return isAuthorized(tx, actor, "budget:manage");
    });
  }

  if (!rollup) {
    return (
      <SectionCard>
        <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("noPermission")} />
      </SectionCard>
    );
  }

  const fmt = (seconds: number) => formatDuration(locale, seconds / 60, prefs.durationStyle);
  const money = (amount: string | null) =>
    amount !== null && rollup.currency ? formatMoney(locale, Number(amount), rollup.currency) : null;
  const weeks = [...new Set(rollup.byMember.flatMap((m) => Object.keys(m.weeks)))].sort();
  const prevMonth = monthContaining(shiftMonth(range.from, -1));
  const nextMonth = monthContaining(shiftMonth(range.from, 1));
  const estimateSeconds = rollup.totals.estimateMinutes !== null ? rollup.totals.estimateMinutes * 60 : null;
  const remaining = estimateSeconds !== null ? Math.max(0, estimateSeconds - rollup.totals.seconds) : null;

  // A render helper, not a component: called as a function so React keeps no state for it.
  const lineTable = (title: string, lines: RollupLine[], labelHeader: string) => (
    <SectionCard title={title} contentClassName="p-0">
      {lines.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{t("noRows")}</p>
      ) : (
        <DataTable flush density="compact" scrollLabel={title}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{labelHeader}</TableHead>
                <TableHead className="w-[10ch] text-right">{t("columns.hours")}</TableHead>
                <TableHead priority="medium" className="w-[10ch] text-right">{t("columns.billable")}</TableHead>
                {rollup.totals.amount !== null ? <TableHead priority="low" className="w-[14ch] text-right">{t("columns.value")}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={l.key}>
                  <TableCell>{l.label || t("unassigned")}</TableCell>
                  <TableCell className="num text-right">{fmt(l.seconds)}</TableCell>
                  <TableCell priority="medium" className="num text-right text-muted-foreground">{fmt(l.billableSeconds)}</TableCell>
                  {rollup.totals.amount !== null ? (
                    <TableCell priority="low" className="num text-right text-muted-foreground">{money(l.amount) ?? "—"}</TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DataTable>
      )}
    </SectionCard>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("range", { from: range.from, to: range.to })}</p>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="icon-sm" aria-label={t("prevMonth")}>
            <Link href={`/projects/${project.key}/time?from=${prevMonth.from}&to=${prevMonth.to}`}>
              <ChevronLeftIcon aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${project.key}/time`}>{t("thisMonth")}</Link>
          </Button>
          <Button asChild variant="outline" size="icon-sm" aria-label={t("nextMonth")}>
            <Link href={`/projects/${project.key}/time?from=${nextMonth.from}&to=${nextMonth.to}`}>
              <ChevronRightIcon aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${project.key}/time/reports`}>
              <FileTextIcon aria-hidden="true" />
              {t("reportsLink")}
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricTile label={t("tiles.logged")} value={fmt(rollup.totals.seconds)} />
        <MetricTile label={t("tiles.billable")} value={fmt(rollup.totals.billableSeconds)} />
        {rollup.totals.amount !== null ? (
          <MetricTile label={t("tiles.value")} value={money(rollup.totals.amount) ?? "—"} />
        ) : (
          <MetricTile label={t("tiles.nonBillable")} value={fmt(rollup.totals.seconds - rollup.totals.billableSeconds)} />
        )}
        <MetricTile label={t("tiles.estimateRemaining")} value={remaining !== null ? fmt(remaining) : "—"} />
      </div>

      {budget ? (
        <SectionCard
          title={t("budget.title")}
          description={t("budget.description", { kind: t(`budget.kinds.${budget.budget.kind}`), period: t(`budget.periods.${budget.budget.period}`) })}
        >
          <ProgressMeter
            value={budget.budget.kind === "HOURS" ? budget.burn.seconds / 3600 : Number(budget.burn.amount ?? 0)}
            total={Number(budget.budget.amount)}
            label={t("budget.burn", {
              used:
                budget.budget.kind === "HOURS"
                  ? fmt(budget.burn.seconds)
                  : (money(budget.burn.amount) ?? "—"),
              total:
                budget.budget.kind === "HOURS"
                  ? fmt(Number(budget.budget.amount) * 3600)
                  : (money(budget.budget.amount) ?? budget.budget.amount),
              percent: String(budget.burn.percent),
            })}
          />
        </SectionCard>
      ) : null}
      {canManageBudget ? (
        <BudgetCard projectId={project.id} projectKey={project.key} budget={budget?.budget ?? null} currency={rollup.currency} />
      ) : null}

      <SectionCard title={t("byMember.title")} contentClassName="p-0">
        {rollup.byMember.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t("noRows")}</p>
        ) : (
          <DataTable flush density="compact" scrollLabel={t("byMember.title")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.member")}</TableHead>
                  {weeks.map((w) => (
                    <TableHead key={w} priority="low" className="num text-right">
                      {w.slice(5)}
                    </TableHead>
                  ))}
                  <TableHead className="w-[10ch] text-right">{t("columns.hours")}</TableHead>
                  {rollup.totals.amount !== null ? <TableHead priority="medium" className="w-[14ch] text-right">{t("columns.value")}</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rollup.byMember.map((m) => (
                  <TableRow key={m.key}>
                    <TableCell>{m.label}</TableCell>
                    {weeks.map((w) => (
                      <TableCell key={w} priority="low" className="num text-right text-muted-foreground">
                        {m.weeks[w] ? fmt(m.weeks[w]) : "—"}
                      </TableCell>
                    ))}
                    <TableCell className="num text-right font-semibold">{fmt(m.seconds)}</TableCell>
                    {rollup.totals.amount !== null ? (
                      <TableCell priority="medium" className="num text-right text-muted-foreground">{money(m.amount) ?? "—"}</TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataTable>
        )}
      </SectionCard>

      {lineTable(t("byItem.title"), rollup.byItem, t("columns.task"))}
      {lineTable(t("byEpic.title"), rollup.byEpic, t("columns.epic"))}
      {lineTable(t("byAgreement.title"), rollup.byAgreement, t("columns.agreement"))}
      {lineTable(t("byWorkType.title"), rollup.byWorkType, t("columns.workType"))}
    </div>
  );
}

/** First day of the month `delta` months away from `isoDate`'s month. */
const shiftMonth = (isoDate: string, delta: number): string => {
  const [y, m] = isoDate.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 10);
};
