import { TriangleAlertIcon } from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import {
  BarList,
  ChartTable,
  ColumnChart,
  MetricTile,
  SectionCard,
  type BarListRow,
  type BarSeries,
} from "@/components/semantic";
import { formatDurationSeconds } from "@/lib/format";
import { cn } from "@/lib/utils";
import { foldTop, TOP_BARS, type ChartPeriod } from "@/modules/reports/chart-shapes";
import type { HourParts, OpenParts, ProjectBar, TeamCharts } from "@/modules/reports/charts";

/**
 * The team charts on `/reports` (Phase 6 slice 117, founder decision C93):
 * the numbers, then four views in a two-column grid — each drawn only when
 * the member's codes reach its source (`readTeamCharts`' `show`), each with
 * its legend and its table twin. Server-rendered, no chart library (design
 * §0: every view is a bar, a column or a meter). Ranked bars show the top
 * eight and fold the rest into "Other"; the twin lists every row. NEVER a
 * per-person view (C93 (e): an hour ranking is on SECURITY.md §9.7.2's
 * never-list; `readTeamCharts` reads no member's hours).
 */

const sumOpen = (rest: readonly { parts: OpenParts }[]): OpenParts =>
  rest.reduce((a, b) => ({ todo: a.todo + b.parts.todo, doing: a.doing + b.parts.doing, late: a.late + b.parts.late }), {
    todo: 0,
    doing: 0,
    late: 0,
  });
const sumHours = (rest: readonly { parts: HourParts }[]): HourParts =>
  rest.reduce((a, b) => ({ billable: a.billable + b.parts.billable, nonBillable: a.nonBillable + b.parts.nonBillable }), {
    billable: 0,
    nonBillable: 0,
  });

export async function TeamChartsSection({ charts, period }: { charts: TeamCharts; period: ChartPeriod }) {
  const t = await getTranslations("reports.charts");
  const format = await getFormatter();
  const locale = await getLocale();
  const hours = (seconds: number) => formatDurationSeconds(locale, seconds, charts.durationStyle);
  const days = (value: number) => format.number(value, { maximumFractionDigits: 1 });
  /** "day" when the value READS as 1, else "days" — never an ICU plural (the parity test's trap). */
  const dayUnit = (value: number) => (days(value) === days(1) ? t("numbers.day") : t("numbers.days"));
  const count = (value: number) => format.number(value);
  const monthLabel = (month: string, style: "short" | "long") =>
    format.dateTime(new Date(`${month}-01T00:00:00Z`), {
      month: style,
      ...(style === "long" ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
  const projectName = (b: ProjectBar<unknown>) => (b.id === null ? t("hours.noProject") : `${b.key} · ${b.name}`);
  const truncating = (label: string) => (
    <span className="truncate" title={label}>
      {label}
    </span>
  );

  const openSeries: BarSeries[] = [
    { key: "todo", label: t("tasks.todo"), fill: "bg-(--chart-neutral)" },
    { key: "doing", label: t("tasks.doing"), fill: "bg-(--chart-active)" },
    {
      key: "late",
      label: t("tasks.late"),
      fill: "bg-(--chart-late)",
      icon: <TriangleAlertIcon aria-hidden="true" className="size-3 text-(--tone-danger-fg)" />,
    },
  ];
  const hourSeries: BarSeries[] = [
    { key: "billable", label: t("hours.billable"), fill: "bg-(--chart-active)" },
    { key: "nonBillable", label: t("hours.nonBillable"), fill: "bg-(--chart-neutral)" },
  ];
  const openRow = (key: string, label: string, p: OpenParts): BarListRow => ({
    key,
    label: truncating(label),
    values: [p.todo, p.doing, p.late],
    titles: [`${t("tasks.todo")}: ${count(p.todo)}`, `${t("tasks.doing")}: ${count(p.doing)}`, `${t("tasks.late")}: ${count(p.late)}`],
    totalText: count(p.todo + p.doing + p.late),
  });
  const hourRow = (key: string, label: string, p: HourParts): BarListRow => ({
    key,
    label: truncating(label),
    values: [p.billable, p.nonBillable],
    titles: [`${t("hours.billable")}: ${hours(p.billable)}`, `${t("hours.nonBillable")}: ${hours(p.nonBillable)}`],
    totalText: hours(p.billable + p.nonBillable),
  });
  const hourColumns = (first: string) => [first, t("hours.billable"), t("hours.nonBillable"), t("columns.total")];
  const hourCells = (name: string, p: HourParts) => [name, hours(p.billable), hours(p.nonBillable), hours(p.billable + p.nonBillable)];

  const tasks = charts.tasks;
  const openFold = tasks ? foldTop(tasks.byProject, TOP_BARS, sumOpen) : null;
  const openRows: BarListRow[] = openFold
    ? [
        ...openFold.shown.map((b) => openRow(b.id!, projectName(b), b.parts)),
        ...(openFold.other ? [openRow("other", t("other"), openFold.other)] : []),
      ]
    : [];

  const hoursData = charts.hours;
  const projectFold = hoursData ? foldTop(hoursData.byProject, TOP_BARS, sumHours) : null;
  const projectRows: BarListRow[] = projectFold
    ? [
        ...projectFold.shown.map((b) => hourRow(b.id ?? "none", projectName(b), b.parts)),
        ...(projectFold.other ? [hourRow("other", t("other"), projectFold.other)] : []),
      ]
    : [];

  const showTable = t("showTable");
  const inPeriod = t(`in.${period}`);
  const empty = (text: string) => <p className="text-sm text-muted-foreground">{text}</p>;

  return (
    <div className="flex flex-col gap-6" data-testid="team-charts">
      {tasks ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="chart-numbers">
          <MetricTile label={t("numbers.open")} value={count(tasks.open)} />
          <MetricTile label={t("numbers.late")} value={count(tasks.late)} />
          <MetricTile label={t(`numbers.done.${period}`)} value={count(tasks.done)} />
          <MetricTile
            label={t("numbers.typical")}
            value={tasks.medianDays === null ? "—" : days(tasks.medianDays)}
            unit={tasks.medianDays === null ? undefined : dayUnit(tasks.medianDays)}
          />
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {tasks ? (
          <SectionCard title={t("tasks.title")} description={t("tasks.description")} className="min-w-0">
            {openRows.length === 0 ? (
              empty(t("tasks.empty"))
            ) : (
              <>
                <BarList label={t("tasks.title")} series={openSeries} rows={openRows} />
                <ChartTable
                  label={showTable}
                  scrollLabel={t("tasks.title")}
                  columns={[t("columns.project"), t("tasks.todo"), t("tasks.doing"), t("tasks.late"), t("columns.total")]}
                  rows={tasks.byProject.map((b) => ({
                    key: b.id!,
                    cells: [projectName(b), count(b.parts.todo), count(b.parts.doing), count(b.parts.late), count(b.parts.todo + b.parts.doing + b.parts.late)],
                  }))}
                />
              </>
            )}
          </SectionCard>
        ) : null}

        {tasks ? (
          <SectionCard title={t("speed.title")} description={t("speed.description")} className="min-w-0">
            {/* Six columns of dashes is an empty plot pretending to be a
                chart: no month with a timed task says so in words. */}
            {tasks.months.every((m) => m.medianDays === null) ? (
              empty(t("speed.empty"))
            ) : (
              <>
                <ColumnChart
                  label={t("speed.title")}
                  columns={tasks.months.map((m) => ({
                    key: m.month,
                    label: monthLabel(m.month, "short"),
                    value: m.medianDays,
                    valueText: m.medianDays === null ? "—" : days(m.medianDays),
                    unitText: m.medianDays === null ? undefined : dayUnit(m.medianDays),
                    emphasis: m.inPeriod,
                  }))}
                  emphasis={{ key: "period", label: t("speed.inPeriod"), fill: "bg-(--chart-active)" }}
                  rest={{ key: "earlier", label: t("speed.otherMonths"), fill: "bg-(--chart-neutral)" }}
                />
                <ChartTable
                  label={showTable}
                  scrollLabel={t("speed.title")}
                  columns={[t("columns.month"), t("speed.median"), t("speed.done"), t("speed.timed")]}
                  rows={tasks.months.map((m) => ({
                    key: m.month,
                    cells: [monthLabel(m.month, "long"), m.medianDays === null ? "—" : days(m.medianDays), count(m.done), count(m.timed)],
                  }))}
                />
              </>
            )}
          </SectionCard>
        ) : null}

        {hoursData ? (
          <SectionCard
            title={t("hours.byProject")}
            description={t("hours.description", { total: hours(hoursData.total.billable + hoursData.total.nonBillable), period: inPeriod })}
            className="min-w-0"
          >
            {projectRows.length === 0 ? (
              empty(t("hours.empty"))
            ) : (
              <>
                <BarList label={t("hours.byProject")} series={hourSeries} rows={projectRows} />
                <ChartTable
                  label={showTable}
                  scrollLabel={t("hours.byProject")}
                  columns={hourColumns(t("columns.project"))}
                  rows={hoursData.byProject.map((b) => ({ key: b.id ?? "none", cells: hourCells(projectName(b), b.parts) }))}
                />
              </>
            )}
          </SectionCard>
        ) : null}

        {charts.budgets ? (
          <SectionCard title={t("budget.title")} description={t("budget.description")} className="min-w-0">
            {charts.budgets.length === 0 ? (
              empty(t("budget.empty"))
            ) : (
              <ul aria-label={t("budget.title")} className="flex flex-col" data-testid="chart-budgets">
                {charts.budgets.map((b) => {
                  // The meter form: the fill carries severity — brand, caution
                  // from 80 %, danger with an icon and its words from 100 %.
                  const over = b.percent >= 100;
                  const near = !over && b.percent >= 80;
                  const label = `${b.key} · ${b.name}`;
                  return (
                    <li key={b.id} className="flex h-8 min-w-0 items-center gap-3">
                      <span className="w-28 min-w-0 shrink-0 truncate text-sm sm:w-40" title={label}>
                        {label}
                      </span>
                      <span aria-hidden="true" className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className={cn(
                            "block h-full rounded-full",
                            over ? "bg-(--tone-danger-line)" : near ? "bg-(--tone-caution-line)" : "bg-(--tone-brand-line)",
                          )}
                          style={{ inlineSize: `${Math.min(100, b.percent)}%` }}
                        />
                      </span>
                      <span className="flex w-20 shrink-0 items-center justify-end gap-1 text-sm">
                        {over ? <TriangleAlertIcon aria-hidden="true" className="size-3.5 text-(--tone-danger-fg)" /> : null}
                        <span className="num">{format.number(Math.floor(b.percent) / 100, { style: "percent" })}</span>
                        {over ? <span className="sr-only">{t("budget.over")}</span> : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>
        ) : null}
      </div>
    </div>
  );
}
