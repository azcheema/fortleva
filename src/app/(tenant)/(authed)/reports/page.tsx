import type { Metadata } from "next";
import { ArchiveIcon, ArchiveRestoreIcon, ChartColumnIcon, ClockAlertIcon } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import {
  DataTable,
  EmptyState,
  EntityChip,
  HealthChip,
  Page,
  PageHeader,
  ProgressMeter,
  SectionCard,
} from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
// From the plain module, never through `table.tsx`: this is a SERVER component (table-rungs.ts).
import { HIDE_FROM } from "@/components/ui/table-rungs";
import { cn } from "@/lib/utils";
import { requireTenantContext } from "@/members/tenant-context";
import { CHART_PERIODS, DEFAULT_CHART_PERIOD, isChartPeriod, type ChartPeriod } from "@/modules/reports/chart-shapes";
import { readTeamCharts, type TeamCharts } from "@/modules/reports/charts";
import { PORTFOLIO_LIMIT, readPortfolio, type Portfolio, type PortfolioRow } from "@/modules/reports/portfolio";

import { ReportsFilter } from "./reports-filter";
import { TeamChartsSection } from "./team-charts";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("reports");
  return { title: t("title") };
}

/** `/reports` with the page's three parameters — changing one keeps the others. */
const reportsHref = (o: { finished: boolean; clientId: string | null; period: ChartPeriod }): string => {
  const params = new URLSearchParams();
  if (o.clientId) params.set("client", o.clientId);
  if (o.finished) params.set("finished", "1");
  if (o.period !== DEFAULT_CHART_PERIOD) params.set("period", o.period);
  const query = params.toString();
  return query === "" ? "/reports" : `/reports?${query}`;
};

/**
 * /reports (Phase 6 slice 116; founder decision C92) — THE PROJECT HEALTH
 * TABLE: every project in the member's scope, most worrying first (C92
 * (c)), its newest published health, when that was and whether the next
 * one is late, how many of its tasks are done, and how much of its budget
 * is used. `report:view_portfolio` and `project:view`, both on all four
 * gates (`readPortfolio`); a column the member's codes do not reach is not
 * drawn at all. Read-only: there is no verb here.
 *
 * ONE-LINE ROWS at the row token (the visual walk's audit), columns pinned
 * (`table-fixed`) and joining as the TABLE widens: below `medium` a row is
 * the project and its health — the late flag rides in the health cell as an
 * icon, the client after the project's name — then the key and the last
 * update, then Done, then the budget and the client's own column. NO CELL
 * CAN OVERFLOW ITS WIDTH, by construction rather than by the walk (no seeded
 * project can be late — the schedule's start is the database's to stamp):
 * the health cell's late cue is a 14px icon beside the widest chip, and the
 * last update's date truncates before its badge, which never shrinks (the
 * code review's MEDIUM, measured in Swedish).
 *
 * Below the table, THE TEAM CHARTS (slice 117, founder decision C93): a
 * "Team" heading with the charts' own period select (`?period=`, calendar
 * months — it scopes only what is under it), then `TeamChartsSection`. The
 * client filter in the header scopes both; "Show finished" the table only.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ finished?: string; client?: string; period?: string }>;
}) {
  const { membership, actor } = await requireTenantContext();
  const params = await searchParams;
  const finished = params.finished === "1";
  const period: ChartPeriod = isChartPeriod(params.period) ? params.period : DEFAULT_CHART_PERIOD;
  const t = await getTranslations("reports");
  const tCommon = await getTranslations("common");

  let portfolio: Portfolio | null = null;
  try {
    portfolio = await readPortfolio(
      { tenantId: membership.tenantId, actor },
      { finished, clientId: typeof params.client === "string" ? params.client : null },
    );
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!portfolio) {
    return (
      <Page>
        <PageHeader title={t("title")} />
        <div className="mt-6">
          <SectionCard>
            <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("noPermission")} />
          </SectionCard>
        </div>
      </Page>
    );
  }

  const { rows, clients, capped, show } = portfolio;
  // The server's reading of the filter: a client the list does not span is "all".
  const clientId =
    typeof params.client === "string" && clients.some((c) => c.id === params.client) ? params.client : null;
  // In sequence after the table, with the table's reading of the client. Its
  // own transaction asks the door again: refused in between (a role changed
  // that second), the charts are left out rather than the page failing.
  let charts: TeamCharts | null = null;
  try {
    charts = await readTeamCharts({ tenantId: membership.tenantId, actor }, { period, clientId });
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  const tCharts = await getTranslations("reports.charts");

  return (
    <Page width="wide">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {clients.length > 1 ? (
              <ReportsFilter
                id="portfolio-filter"
                param="client"
                label={t("health.filter")}
                value={clientId ?? ""}
                fallback=""
                options={[
                  { value: "", label: t("health.allClients") },
                  ...clients.map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
            ) : null}
            <Button asChild variant="outline" size="sm">
              <Link href={reportsHref({ finished: !finished, clientId, period })} data-testid="portfolio-finished">
                {finished ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                {finished ? t("health.hideFinished") : t("health.showFinished")}
              </Link>
            </Button>
          </div>
        }
      />

      <div className="mt-6">
        <SectionCard title={t("health.title")} description={t("health.legend")} contentClassName="p-0">
          {rows.length === 0 ? (
            <EmptyState
              variant="empty"
              icon={ChartColumnIcon}
              title={finished ? t("health.emptyFinished") : t("health.empty")}
              body={finished ? t("health.emptyFinishedBody") : t("health.emptyBody")}
              action={
                <Button asChild variant="outline" size="sm">
                  {finished ? (
                    <Link href="/projects">{t("health.openProjects")}</Link>
                  ) : (
                    <Link href={reportsHref({ finished: true, clientId, period })}>{t("health.showFinished")}</Link>
                  )}
                </Button>
              }
            />
          ) : (
            <>
              {capped ? (
                <p className="border-b px-4 py-2 text-sm text-(--tone-caution-fg)" data-testid="portfolio-capped">
                  {t("health.capped", { count: PORTFOLIO_LIMIT })}
                </p>
              ) : null}
              <PortfolioTable rows={rows} show={show} />
            </>
          )}
        </SectionCard>
      </div>

      {charts && (charts.show.tasks || charts.show.hours || charts.show.budget) ? (
        <section aria-labelledby="team-charts-heading" className="mt-10 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="team-charts-heading" className="text-lg font-semibold">
              {tCharts("heading")}
            </h2>
            {/* Only where a view has a period — the budget meters have their own. */}
            {charts.show.tasks || charts.show.hours ? (
              <ReportsFilter
                id="chart-period"
                param="period"
                label={tCharts("periodLabel")}
                value={period}
                fallback={DEFAULT_CHART_PERIOD}
                options={CHART_PERIODS.map((p) => ({ value: p, label: tCharts(`period.${p}`) }))}
              />
            ) : null}
          </div>
          <TeamChartsSection charts={charts} period={period} />
        </section>
      ) : null}
    </Page>
  );
}

async function PortfolioTable({ rows, show }: { rows: readonly PortfolioRow[]; show: Portfolio["show"] }) {
  const t = await getTranslations("reports.health");
  const format = await getFormatter();
  // The year only when it is not this one ("6 Oct", "6 Oct 2025") — in the
  // formatter's zone, the member's.
  const yearOf = (d: Date) => format.dateTime(d, { year: "numeric" });
  const thisYear = yearOf(new Date());
  const dateOf = (d: Date) =>
    format.dateTime(d, { day: "numeric", month: "short", ...(yearOf(d) === thisYear ? {} : { year: "numeric" }) });
  return (
    <DataTable flush scrollLabel={t("title")}>
      <Table className="table-fixed" data-testid="portfolio-table">
        <TableHeader>
          <TableRow>
            <TableHead priority="medium" className="w-[10ch]">
              {t("columns.key")}
            </TableHead>
            <TableHead>{t("columns.project")}</TableHead>
            <TableHead className="w-32">{t("columns.health")}</TableHead>
            {show.updates ? (
              <TableHead priority="medium" className="w-44">
                {t("columns.lastUpdate")}
              </TableHead>
            ) : null}
            {show.tasks ? (
              <TableHead priority="low" className="w-28 text-right">
                {t("columns.done")}
              </TableHead>
            ) : null}
            {show.budget ? (
              <TableHead priority="lower" className="w-28 text-right">
                {t("columns.budget")}
              </TableHead>
            ) : null}
            <TableHead priority="lower" className="w-44">
              {t("columns.client")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const late = r.schedule?.state === "late";
            const due = r.schedule?.state === "due";
            return (
              <TableRow key={r.id} data-testid="portfolio-row" data-project={r.key}>
                <TableCell priority="medium" className="num-id w-[10ch] font-mono text-xs text-muted-foreground">
                  {r.key}
                </TableCell>
                <TableCell>
                  <span className="flex w-full min-w-0 items-center gap-2 contain-inline-size">
                    <EntityChip
                      id={r.id}
                      name={r.name}
                      kind="project"
                      href={`/projects/${r.key}`}
                      className="min-w-0 font-medium"
                    />
                    {/* The client, while its own column (`lower`) is hidden —
                        every row names its client (C92 (c)). `basis-0`: it
                        takes only the room the project's name leaves. */}
                    <span className={cn("min-w-0 flex-1 basis-0 truncate text-sm text-muted-foreground", HIDE_FROM.lower)}>
                      {r.clientName}
                    </span>
                  </span>
                </TableCell>
                <TableCell>
                  <span className="flex min-w-0 items-center gap-1.5">
                    {r.health ? (
                      <HealthChip value={r.health} />
                    ) : (
                      <span className="text-muted-foreground" title={t("noUpdate")}>
                        {"—"}
                        <span className="sr-only">{t("noUpdate")}</span>
                      </span>
                    )}
                    {/* Late, while the Last update column (`medium`) is
                        hidden — an icon, so the widest chip still fits. */}
                    {late ? (
                      <span className={cn("shrink-0 text-(--tone-caution-fg)", HIDE_FROM.medium)} title={t("lateLong")}>
                        <ClockAlertIcon aria-hidden="true" className="size-3.5" />
                        <span className="sr-only">{t("lateLong")}</span>
                      </span>
                    ) : null}
                  </span>
                </TableCell>
                {show.updates ? (
                  <TableCell priority="medium">
                    <span className="flex min-w-0 items-center gap-2 whitespace-nowrap">
                      {r.lastUpdateAt ? (
                        <span className="num min-w-0 truncate text-sm">{dateOf(r.lastUpdateAt)}</span>
                      ) : (
                        <span className="text-muted-foreground" title={t("noUpdate")}>
                          {"—"}
                          <span className="sr-only">{t("noUpdate")}</span>
                        </span>
                      )}
                      {late ? (
                        <Badge variant="caution" className="shrink-0" data-testid="portfolio-late" title={t("lateLong")}>
                          {t("late")}
                        </Badge>
                      ) : due ? (
                        <Badge variant="outline" className="shrink-0" data-testid="portfolio-due">
                          {t("due")}
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                ) : null}
                {show.tasks ? (
                  <TableCell priority="low" className="text-right" data-testid="portfolio-done">
                    <ProgressMeter
                      value={r.tasks?.done ?? 0}
                      total={r.tasks?.total ?? 0}
                      label={
                        r.tasks && r.tasks.total > 0
                          ? format.number(Math.floor((r.tasks.done * 100) / r.tasks.total) / 100, { style: "percent" })
                          : t("noTasks")
                      }
                    />
                  </TableCell>
                ) : null}
                {show.budget ? (
                  <TableCell priority="lower" className="text-right whitespace-nowrap" data-testid="portfolio-budget">
                    {r.budget === null ? (
                      <span className="text-muted-foreground" title={t("noBudget")}>
                        {"—"}
                        <span className="sr-only">{t("noBudget")}</span>
                      </span>
                    ) : r.budget.percent >= 100 ? (
                      <Badge variant="caution" className="num">
                        {format.number(Math.floor(r.budget.percent) / 100, { style: "percent" })}
                      </Badge>
                    ) : (
                      <span className="num text-sm">
                        {format.number(Math.floor(r.budget.percent) / 100, { style: "percent" })}
                      </span>
                    )}
                  </TableCell>
                ) : null}
                <TableCell priority="lower">
                  <EntityChip
                    id={r.clientId}
                    name={r.clientName}
                    kind="client"
                    href={`/clients/${r.clientId}`}
                    className="max-w-full"
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </DataTable>
  );
}
