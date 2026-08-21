import type { Metadata } from "next";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { DataTable, EmptyState, MetricTile, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { resolveLocale, resolvePreferences, resolveTimeZone } from "@/i18n/resolve";
import { dateColumn, localDateString } from "@/lib/duration";
import { dateFormat, formatDurationSeconds, formatNumber } from "@/lib/format";
import { shiftMonth } from "@/lib/week";
import { requireTenantContext } from "@/members/tenant-context";
import { isMonth, workingTimeStatement, type WorkingTimeStatement } from "@/modules/time";

import { PrintButton } from "./print-button";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("time.statement");
  return { title: t("pageTitle") };
}

/**
 * /time/statement?month=YYYY-MM — the member's OWN monthly working-time
 * statement (PLAN.md 2T D1: "monthly working-time statement export (CSV
 * + print; ATL §11 journal evidence)"; UI.md §3.1 /time; SECURITY.md
 * §9.7.3 self-access). Every calendar day of the month, the closed shifts
 * with their breaks and worked time, the member's tracked task time and
 * the unallocated remainder, totals and an indicative "expected" line.
 * The page IS the print layout: the shell chrome and the controls hide
 * on paper (`print:hidden`); the CSV is the same data from /time/export.
 * Another member's statement is a CSV on /time/team (time:export), not a
 * page — row-level detail of a colleague's day is an explicit, audited
 * export, never an ambient view.
 */
export default async function StatementPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("time.statement");
  const tCommon = await getTranslations("common");
  const locale = await resolveLocale();
  const timezone = await resolveTimeZone();
  const prefs = (await resolvePreferences())!; // one read per request, shared with resolveTimeZone
  const sp = await searchParams;
  const today = localDateString(new Date(), timezone);
  const month = isMonth(sp.month) ? sp.month : today.slice(0, 7);

  let s: WorkingTimeStatement | null = null;
  try {
    s = await workingTimeStatement(ctx, { month });
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!s) {
    return (
      <Page>
        <PageHeader title={t("pageTitle")} />
        <div className="mt-6">
          <SectionCard>
            <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={tCommon("noPermission")} />
          </SectionCard>
        </div>
      </Page>
    );
  }

  const fmt = (seconds: number) => formatDurationSeconds(locale, seconds, prefs.durationStyle);
  const monthLabel = dateFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(dateColumn(`${month}-01`));
  const dayLabel = dateFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const clockIn = (d: Date, zone: string) => dateFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }).format(d);
  const generated = dateFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(s.generatedAt);
  const prevMonth = shiftMonth(month, -1);
  const nextMonth = shiftMonth(month, 1);
  const delta = s.expectedSeconds !== null ? s.totals.workedSeconds - s.expectedSeconds : null;
  const statement = s;
  const period = `${statement.from} – ${statement.to}`;
  const spanLabel = (r: { startedAt: Date; stoppedAt: Date; timezone: string }) =>
    `${clockIn(r.startedAt, r.timezone)}–${clockIn(r.stoppedAt, r.timezone)}`;
  // Unallocated is signed: negative = more task time tracked than the shift holds ("over"); the formatter clamps at 0, so the sign is ours.
  const signed = (seconds: number) => (seconds < 0 ? `−${fmt(-seconds)}` : fmt(seconds));

  return (
    <Page>
      <PageHeader
        title={t("pageTitle")}
        description={t("heading", { name: statement.memberName, month: monthLabel })}
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Button asChild variant="outline" size="icon-sm" aria-label={t("prevMonth")}>
              <Link href={`/time/statement?month=${prevMonth}`}>
                <ChevronLeftIcon aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/time/statement">{t("thisMonth")}</Link>
            </Button>
            <Button asChild variant="outline" size="icon-sm" aria-label={t("nextMonth")}>
              <Link href={`/time/statement?month=${nextMonth}`}>
                <ChevronRightIcon aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={`/time/export?kind=statement&month=${month}`} data-testid="statement-csv">
                <DownloadIcon aria-hidden="true" />
                {t("csv")}
              </a>
            </Button>
            <PrintButton />
          </div>
        }
      />

      <div className="mt-6 flex flex-col gap-4">
        <SectionCard size="sm">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">{t("meta.workspace")}</dt>
              <dd>{statement.tenantName}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("meta.member")}</dt>
              <dd>{statement.memberName}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("meta.period")}</dt>
              <dd className="num">{period}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("meta.timezone")}</dt>
              <dd>{statement.timezone ?? timezone}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("meta.hoursPerDay")}</dt>
              <dd className="num">{statement.hoursPerDay !== null ? formatNumber(locale, statement.hoursPerDay) : tCommon("notSet")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("meta.generated")}</dt>
              <dd className="num">{generated}</dd>
            </div>
          </dl>
        </SectionCard>

        <SectionCard contentClassName="p-0">
          <DataTable flush density="compact" scrollLabel={t("pageTitle")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[12ch]">{t("columns.date")}</TableHead>
                  <TableHead>{t("columns.shift")}</TableHead>
                  <TableHead priority="medium" className="w-[9ch] text-right">{t("columns.breaks")}</TableHead>
                  <TableHead className="w-[9ch] text-right">{t("columns.worked")}</TableHead>
                  <TableHead priority="medium" className="w-[9ch] text-right">{t("columns.tracked")}</TableHead>
                  <TableHead priority="low" className="w-[10ch] text-right">{t("columns.unallocated")}</TableHead>
                  <TableHead priority="low">{t("columns.flags")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statement.days.map((d) => {
                  const empty = d.shifts.length === 0 && (d.trackedSeconds ?? 0) === 0;
                  const flags = [
                    ...(d.shifts.some((r) => r.provisional) ? [t("flags.provisional")] : []),
                    ...(d.shifts.some((r) => r.noBreak) ? [t("flags.noBreak")] : []),
                  ];
                  return (
                    <TableRow key={d.date} data-testid="statement-day" data-empty={empty ? "1" : "0"} className={empty ? "text-muted-foreground" : undefined}>
                      <TableCell className="whitespace-nowrap">{dayLabel.format(dateColumn(d.date))}</TableCell>
                      {/* One line per row (the table's row pitch is its --row-h): a two-shift day reads "08:00–12:00 · 13:00–17:00". */}
                      <TableCell className="num whitespace-nowrap">{d.shifts.length === 0 ? "—" : d.shifts.map(spanLabel).join(" · ")}</TableCell>
                      <TableCell priority="medium" className="num text-right">{d.shifts.length ? fmt(d.breakSeconds) : "—"}</TableCell>
                      <TableCell className="num text-right font-semibold">{d.shifts.length ? fmt(d.workedSeconds) : "—"}</TableCell>
                      <TableCell priority="medium" className="num text-right">{d.trackedSeconds ? fmt(d.trackedSeconds) : "—"}</TableCell>
                      {/* Keyed on `empty`, not on shifts: a tracked-only day has a (negative) unallocated value that the TOTAL includes — the column must foot. */}
                      <TableCell priority="low" className="num text-right">{empty ? "—" : signed(d.unallocatedSeconds ?? 0)}</TableCell>
                      <TableCell priority="low" className="text-xs text-muted-foreground">{flags.join(" · ")}</TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="bg-muted/40 font-semibold" data-testid="statement-total">
                  <TableCell>{t("totals.title")}</TableCell>
                  <TableCell className="text-xs font-normal text-muted-foreground">{t("totals.shifts", { count: statement.totals.shifts })}</TableCell>
                  <TableCell priority="medium" className="num text-right">{fmt(statement.totals.breakSeconds)}</TableCell>
                  <TableCell className="num text-right">{fmt(statement.totals.workedSeconds)}</TableCell>
                  <TableCell priority="medium" className="num text-right">{fmt(statement.totals.trackedSeconds ?? 0)}</TableCell>
                  <TableCell priority="low" className="num text-right">{signed(statement.totals.unallocatedSeconds ?? 0)}</TableCell>
                  <TableCell priority="low" />
                </TableRow>
              </TableBody>
            </Table>
          </DataTable>
        </SectionCard>

        {statement.totals.shifts === 0 ? <p className="text-sm text-muted-foreground">{t("empty")}</p> : null}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <MetricTile label={t("totals.worked")} value={fmt(statement.totals.workedSeconds)} />
          <MetricTile label={t("totals.tracked")} value={fmt(statement.totals.trackedSeconds ?? 0)} />
          <MetricTile
            label={t("totals.expected")}
            value={statement.expectedSeconds !== null ? fmt(statement.expectedSeconds) : "—"}
            unit={
              statement.hoursPerDay !== null
                ? t("totals.expectedHint", { hours: formatNumber(locale, statement.hoursPerDay), days: statement.weekdays })
                : undefined
            }
          />
          <MetricTile label={t("totals.delta")} value={delta !== null ? `${delta < 0 ? "−" : "+"}${fmt(Math.abs(delta))}` : "—"} />
        </div>

        <p className="max-w-prose text-xs text-muted-foreground">{t("legal")}</p>
        <div className="print:hidden">
          <Button asChild variant="link" size="sm" className="px-0">
            <Link href="/time">{t("back")}</Link>
          </Button>
        </div>
      </div>
    </Page>
  );
}
