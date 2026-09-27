import { getLocale, getTranslations } from "next-intl/server";

import { DataTable, Disclosure, SectionCard } from "@/components/semantic";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReportSnapshotTable } from "@/components/time/report-snapshot";
import { MetricTiles, type MetricTileSpec } from "@/components/updates/metric-tiles";
import { dateFormat, formatDay, formatDurationSeconds, formatMoney } from "@/lib/format";
import type { PortalHours, PortalHoursLive, PortalTimeReport } from "@/modules/time";

/**
 * SECTION 7 OF THE ONE-SCREEN PROJECT PAGE — "Hours & retainer" (UI.md
 * §4): the live widget when the project shares hours, the published
 * reports when there are any, both when both. WHETHER TO DRAW IT IS THE
 * PAGE'S DECISION (`hasHours` in `project-view.tsx`, which also feeds the
 * page's empty state) — one rule, in one place; this component draws
 * what it is handed. A collaborator is handed nothing: the projection
 * answers empty for a profile without `portal.hours.view`.
 *
 * THE WIDGET IS THE LIVE TWIN OF A POST'S FROZEN HOURS BLOCK, so it
 * wears the same tiles (`UpdateView`'s `Metrics`): a label, a number, a
 * detail line. "This month" leads because a retainer client asks "how
 * much of this month have we used"; "To date" follows; the amounts join
 * them only when the agency shares amounts; the budget is a FACT on its
 * own tile — hours, or money when amounts are shared — never a meter
 * (the projection's header says why: the row does not know the
 * budget's period). Under the tiles, a month-by-month table, newest
 * first, so a client can see the shape of the work rather than one
 * number.
 *
 * DURATIONS ARE "hm" HERE, fixed — the portal has no preference to
 * read, and `UpdateView` draws the frozen block the same way on this
 * plane. Money is `formatMoney`, which prints the currency CODE in
 * English and the symbol in Swedish (a client who does not know which
 * workspace they are in must not be shown a bare "kr").
 *
 * A REPORT IS A DISCLOSURE, closed: its title, period and total are
 * the row, and the lines open under it. `<details>` rather than state,
 * so the page ships no JavaScript for it and the View-as byte
 * comparison sees the same markup. Under View-as's `inert` wrapper a
 * member cannot open one — the recorded price of look-don't-touch (UI.md
 * §11), which the Reports tab's own preview already pays for.
 */
export async function ProjectHours({ hours }: { hours: PortalHours }) {
  const t = await getTranslations("portal.hours");
  const locale = await getLocale();
  const { live, reports, reportsTruncated } = hours;
  const fmt = (seconds: number) => formatDurationSeconds(locale, seconds, "hm");
  return (
    <SectionCard title={t("title")} description={t("description")} contentClassName="p-0">
      <div data-slot="portal-hours" className="flex flex-col">
        {live ? <LiveHours live={live} fmt={fmt} locale={locale} /> : null}
        {reports.length > 0 ? (
          <div data-slot="portal-time-reports" className={live ? "flex flex-col gap-3 border-t border-border p-4" : "flex flex-col gap-3 p-4"}>
            <p className="eyebrow text-muted-foreground">{t("reports")}</p>
            <ul className="flex flex-col gap-2">
              {reports.map((report) => (
                <PortalReport key={report.id} report={report} fmt={fmt} locale={locale} />
              ))}
            </ul>
            {reportsTruncated ? (
              <p className="text-xs text-muted-foreground">{t("reportsTruncated", { count: reports.length })}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}

async function LiveHours({ live, fmt, locale }: { live: PortalHoursLive; fmt: (s: number) => string; locale: string }) {
  const t = await getTranslations("portal.hours");
  const currency = live.currency;
  // A missing figure is a zero, never a blank: a BILLABLE_AMOUNT month
  // with no billable time has a NULL column (a SUM over no rows), and
  // the client reads "0" for it. Only ever called when `showAmounts`.
  const amount = (value: string | null): string => (currency ? formatMoney(locale, Number(value ?? "0"), currency) : "");
  const monthName = (month: string): string =>
    dateFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
  const showAmounts = live.mode === "BILLABLE_AMOUNT" && currency !== null;

  const tiles: MetricTileSpec[] = [
    {
      key: "thisMonth",
      label: t("thisMonth"),
      value: fmt(live.thisMonth.seconds),
      detail: showAmounts ? t("billed", { amount: amount(live.thisMonth.amount) }) : null,
    },
    {
      key: "toDate",
      label: t("toDate"),
      value: fmt(live.toDate.seconds),
      detail: showAmounts ? t("billed", { amount: amount(live.toDate.amount) }) : null,
    },
  ];
  if (live.budgetSeconds !== null || (showAmounts && live.budgetAmount !== null)) {
    // One budget tile: hours when the agency set an hours budget, money
    // when it set a money one and shares amounts — both when both, as
    // the number and its detail.
    const hoursText = live.budgetSeconds !== null ? fmt(live.budgetSeconds) : null;
    const moneyText = showAmounts && live.budgetAmount !== null ? amount(live.budgetAmount) : null;
    tiles.push({
      key: "budget",
      label: t("budget"),
      value: hoursText ?? moneyText ?? "",
      detail: hoursText && moneyText ? moneyText : null,
    });
  }

  return (
    // THE TABLE IS FLUSH AND OUTSIDE THE PADDING (UI.md §10.15.1, the
    // visual walk's hairline rule): a bordered table inside a padded card
    // draws two hairlines 16px apart, so the tiles keep the padding and
    // the months run edge to edge under a single rule.
    <div data-slot="portal-hours-live" className="flex flex-col">
      <div className="p-4">
        <MetricTiles tiles={tiles} />
      </div>
      {live.months.length > 0 ? (
        <div className="border-t border-border">
          <DataTable flush density="compact" scrollLabel={t("byMonth")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("month")}</TableHead>
                  <TableHead className="w-[10ch] text-right">{t("hours")}</TableHead>
                  {showAmounts ? (
                    <TableHead className="w-[14ch] text-right">
                      {t("amount")}
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {live.months.map((m) => (
                  <TableRow key={m.month} data-slot="portal-hours-month" data-month={m.month}>
                    <TableCell>{monthName(m.month)}</TableCell>
                    <TableCell className="num text-right">{fmt(m.seconds)}</TableCell>
                    {showAmounts ? (
                      <TableCell className="num text-right">
                        {amount(m.amount)}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataTable>
        </div>
      ) : null}
      {live.truncated ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">{t("truncated", { count: live.months.length })}</p>
      ) : null}
    </div>
  );
}

async function PortalReport({ report, fmt, locale }: { report: PortalTimeReport; fmt: (s: number) => string; locale: string }) {
  const t = await getTranslations("portal.hours");
  const period = t("period", { from: formatDay(locale, report.periodStart), to: formatDay(locale, report.periodEnd) });
  const total =
    report.billableAmount !== null && report.currency
      ? t("reportTotalWithAmount", { hours: fmt(report.totalSeconds), amount: formatMoney(locale, Number(report.billableAmount), report.currency) })
      : t("reportTotal", { hours: fmt(report.totalSeconds) });
  return (
    <li data-slot="portal-time-report" className="flex flex-col gap-1 rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm font-medium text-foreground">{report.title}</span>
        <span className="num text-sm text-muted-foreground">{total}</span>
      </div>
      <p className="text-xs text-muted-foreground">{period}</p>
      <Disclosure label={t("showLines")} contentClassName="-mx-3 -mb-3 border-t border-border">
        <ReportSnapshotTable snapshot={report.snapshot} fmt={fmt} locale={locale} scrollLabel={report.title} />
      </Disclosure>
    </li>
  );
}
