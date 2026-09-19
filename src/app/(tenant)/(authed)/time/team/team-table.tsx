"use client";

import { FileTextIcon, TimerIcon } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

import { DataTable, EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDurationSeconds, formatMoney, type DurationStyle } from "@/lib/format";

export type TeamLine = {
  memberId: string;
  memberName: string;
  projectId: string | null;
  projectKey: string | null;
  projectName: string | null;
  seconds: number;
  billableSeconds: number;
  amount: string | null;
  currency: string | null;
  hoursPerDay: number | null;
};

export type TeamShiftDay = {
  memberId: string;
  memberName: string;
  localDate: string;
  workedSeconds: number;
  breakSeconds: number;
  shifts: number;
};

/**
 * Two read-only tables: hours per member × project, and closed-shift day
 * totals. Day headings arrive pre-formatted from the server: an Intl
 * formatter built in a client component renders once in Node and once in
 * the browser, and their ICU builds can disagree on `weekday: "short"` —
 * a React #418 hydration mismatch (seen on CI). One string, one place.
 */
export function TeamTable({
  lines,
  shifts,
  durationStyle,
  currencyDefault,
  canExport,
  statementMonth,
  statementMonthLabel,
  days,
  dayLabels,
}: {
  lines: TeamLine[];
  shifts: TeamShiftDay[];
  durationStyle: DurationStyle;
  /** The tenant's finance.currencyDefault — the fallback for ad-hoc lines; never a literal. */
  currencyDefault: string;
  /** time:export held — the per-member working-time statement CSV shows in the shifts table. */
  canExport: boolean;
  /** "YYYY-MM" of the viewed week's first day, and its server-formatted label ("August 2026"). */
  statementMonth: string;
  statementMonthLabel: string;
  days: string[];
  /** ISO date → server-formatted heading ("Thu 20"). */
  dayLabels: Record<string, string>;
}) {
  const t = useTranslations("time.team");
  const locale = useLocale();
  const fmt = (seconds: number) => formatDurationSeconds(locale, seconds, durationStyle);
  const hasAmounts = lines.some((l) => l.amount !== null);

  // Per-member totals for the footer-ish rows. Money sums only within
  // ONE currency: a member billed in SEK on one project and EUR on
  // another gets no total (shown as —), never a blended number.
  const currencyOf = (l: TeamLine) => l.currency ?? currencyDefault;
  const byMember = new Map<string, { name: string; seconds: number; billable: number; amount: number; currency: string | null; mixed: boolean }>();
  for (const l of lines) {
    const m = byMember.get(l.memberId) ?? { name: l.memberName, seconds: 0, billable: 0, amount: 0, currency: null, mixed: false };
    m.seconds += l.seconds;
    m.billable += l.billableSeconds;
    if (l.amount) {
      m.amount += Number(l.amount);
      if (m.currency === null) m.currency = currencyOf(l);
      else if (m.currency !== currencyOf(l)) m.mixed = true;
    }
    byMember.set(l.memberId, m);
  }

  const shiftByMember = new Map<string, Map<string, TeamShiftDay>>();
  for (const s of shifts) {
    const m = shiftByMember.get(s.memberId) ?? new Map<string, TeamShiftDay>();
    m.set(s.localDate, s);
    shiftByMember.set(s.memberId, m);
  }
  const shiftMembers = [...new Map(shifts.map((s) => [s.memberId, { id: s.memberId, name: s.memberName }])).values()];

  return (
    <>
      <SectionCard title={t("hours.title")} description={t("hours.description")} contentClassName="p-0">
        {lines.length === 0 ? (
          <div className="p-4">
            <EmptyState
              variant="empty"
              icon={TimerIcon}
              title={t("hours.empty")}
              body={t("hours.emptyBody")}
              action={
                <Button asChild size="sm" variant="outline">
                  <Link href="/time">{t("goToMyTime")}</Link>
                </Button>
              }
              className="mx-auto items-center py-6 text-center"
            />
          </div>
        ) : (
          <DataTable flush scrollLabel={t("hours.scrollLabel")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("hours.columns.member")}</TableHead>
                  <TableHead>{t("hours.columns.project")}</TableHead>
                  <TableHead className="w-[10ch] text-right">{t("hours.columns.hours")}</TableHead>
                  <TableHead priority="medium" className="w-[10ch] text-right">{t("hours.columns.billable")}</TableHead>
                  {hasAmounts ? <TableHead priority="low" className="w-[14ch] text-right">{t("hours.columns.value")}</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l) => (
                  <TableRow key={`${l.memberId}:${l.projectId ?? "adhoc"}`}>
                    {/* THE TWO IDENTITY COLUMNS BOTH YIELD — and both, not
                        just the wider one, because both hold unbounded
                        tenant text in a `whitespace-nowrap` cell and either
                        alone is a column floor (the lesson `/clients`' city
                        span and the time week's badges each taught once).
                        Measured on CI run 35400146183: 13px past a 356px box
                        on the phone walk, and 0 at every other width — a
                        phone renders member + project + hours and nothing
                        else, so two names have to fit whatever the hours
                        column leaves of a 356px box. Containing only
                        the project cell would have fitted TODAY's seed and
                        put the scroll straight back on a longer member name,
                        which nothing would catch: this stop is exempt from
                        the overflow ratchet (`VOLATILE_STOPS`). With both
                        contained the slack spreads across the two instead of
                        piling up behind either, exactly as it does across
                        `/clients`' five columns.
                        SIX REM AND NINE, arithmetic and not a default: at a
                        356px box the hours column takes 73px, so 283px is
                        the budget these two share, and 96 + 144 leaves 43px
                        of it spare — enough that a longer duration string
                        (the member's `durationStyle` is a preference) cannot
                        bring the floors into play. Measured after, at that
                        box: member 113, project 170, hours 73, and 0 of
                        scroll; neither floor binds at any width measured.
                        Project takes the wider one — it is the cell carrying
                        two values. Note that hours was 64px BEFORE this, not
                        73: squeezed to its own min-content by two columns
                        that would not yield. */}
                    <TableCell className="min-w-24">
                      {/* §10.12: an identifying cell that truncates carries
                          the full text as its own `title`. */}
                      <span className="flex w-full min-w-0 items-center contain-inline-size">
                        <span className="truncate" title={l.memberName}>{l.memberName}</span>
                      </span>
                    </TableCell>
                    <TableCell className="min-w-36 text-muted-foreground">
                      <span className="flex w-full min-w-0 items-center gap-1 contain-inline-size">
                        {l.projectKey ? (
                          <>
                            {/* The key never yields — it is the short half and
                                the one that identifies the project; the name
                                truncates around it. */}
                            <span className="num-id shrink-0">{l.projectKey}</span>
                            <span className="truncate" title={l.projectName ?? undefined}>{l.projectName}</span>
                          </>
                        ) : (
                          <span className="truncate">{t("hours.internal")}</span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="num text-right">{fmt(l.seconds)}</TableCell>
                    <TableCell priority="medium" className="num text-right text-muted-foreground">{fmt(l.billableSeconds)}</TableCell>
                    {hasAmounts ? (
                      <TableCell priority="low" className="num text-right text-muted-foreground">
                        {l.amount ? formatMoney(locale, Number(l.amount), currencyOf(l)) : "—"}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
                {[...byMember.entries()].map(([id, m]) => (
                  <TableRow key={`total:${id}`} className="bg-muted/40">
                    {/* A COLUMN IS ONE WIDTH, so the total row's copy of the
                        same name has to be contained too — the backlog found
                        this the hard way, where one uncontained row put the
                        whole column's floor back. */}
                    <TableCell className="min-w-24 font-semibold">
                      <span className="flex w-full min-w-0 items-center contain-inline-size">
                        <span className="truncate" title={m.name}>{m.name}</span>
                      </span>
                    </TableCell>
                    <TableCell className="min-w-36 text-xs text-muted-foreground">{t("hours.total")}</TableCell>
                    <TableCell className="num text-right font-semibold">{fmt(m.seconds)}</TableCell>
                    <TableCell priority="medium" className="num text-right">{fmt(m.billable)}</TableCell>
                    {hasAmounts ? (
                      <TableCell priority="low" className="num text-right">
                        {m.currency !== null && !m.mixed ? formatMoney(locale, m.amount, m.currency) : "—"}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataTable>
        )}
      </SectionCard>

      <SectionCard title={t("shifts.title")} description={t("shifts.description")} contentClassName="p-0">
        {shiftMembers.length === 0 ? (
          <div className="p-4">
            <EmptyState
              variant="empty"
              icon={TimerIcon}
              title={t("shifts.empty")}
              body={t("shifts.emptyBody")}
              action={
                <Button asChild size="sm" variant="outline">
                  <Link href="/time">{t("goToMyTime")}</Link>
                </Button>
              }
              className="mx-auto items-center py-6 text-center"
            />
          </div>
        ) : (
          <DataTable flush density="compact" scrollLabel={t("shifts.scrollLabel")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("shifts.columns.member")}</TableHead>
                  {/* THE SEVEN DAYS ARE `low`, which is the same answer the
                      project month grid's week columns already give
                      (`projects/[key]/time/page.tsx`). A matrix cannot drop
                      SOME of its columns — a week with holes in it is worse
                      than no week — but it can drop all of them and leave
                      the two that still say something, the member and their
                      total. Measured before the rung existed here: this
                      table was 249px past a 356px box on a phone and 111px
                      past the 494px box the rail leaves at 768px, the
                      worst overflow anywhere in the product and invisible
                      because the stop is exempt from the ratchet
                      (`VOLATILE_STOPS`). At `low` the seven come back at a
                      736px box, where member + 7 + total is ~605px. */}
                  {days.map((d) => (
                    <TableHead key={d} priority="low" className="num text-right">
                      {dayLabels[d] ?? d}
                    </TableHead>
                  ))}
                  <TableHead className="num text-right">{t("shifts.columns.total")}</TableHead>
                  {canExport ? (
                    <TableHead pinned className="w-0 text-right">
                      <span className="sr-only">{t("shifts.columns.statement")}</span>
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shiftMembers.map((m) => {
                  const row = shiftByMember.get(m.id) ?? new Map<string, TeamShiftDay>();
                  const total = [...row.values()].reduce((s, d) => s + d.workedSeconds, 0);
                  return (
                    <TableRow key={m.id}>
                      {/* THE SAME CELL, CONTAINED FOR THE SAME REASON — and
                          it sits at 0 today only because this seed's names
                          are short, which is precisely the control case
                          `/clients` and the client Projects tab made in
                          slice 28. At a 356px box this table hides its seven
                          `low` day columns and renders member + total +
                          the pinned statement link, so the member name IS
                          the column that takes the remainder (197px
                          measured); uncontained, a longer one is the
                          column's floor and the sideways scroll is back,
                          and this stop is exempt from the ratchet so
                          nothing would say so. Containment can only give
                          width BACK here: the tightest box measured is the
                          736px one, where the seven days leave the member
                          113px — its own min-content, which is why the
                          floor is six rem and not more. */}
                      <TableCell className="min-w-24">
                        <span className="flex w-full min-w-0 items-center contain-inline-size">
                          <span className="truncate" title={m.name}>{m.name}</span>
                        </span>
                      </TableCell>
                      {days.map((d) => {
                        const cell = row.get(d);
                        return (
                          <TableCell
                            key={d}
                            priority="low"
                            className="num text-right text-muted-foreground"
                          >
                            {cell ? fmt(cell.workedSeconds) : "—"}
                          </TableCell>
                        );
                      })}
                      <TableCell className="num text-right font-semibold">{fmt(total)}</TableCell>
                      {canExport ? (
                        <TableCell pinned className="text-right">
                          {/* The row's one everyday verb (UI.md §10.15 #8): the member's monthly statement as a CSV download — a plain anchor, not a navigation. */}
                          <Button asChild variant="ghost" size="icon-sm" aria-label={t("statementFor", { name: m.name, month: statementMonthLabel })}>
                            <a href={`/time/export?kind=statement&member=${m.id}&month=${statementMonth}`} data-testid="team-statement-csv">
                              <FileTextIcon aria-hidden="true" />
                            </a>
                          </Button>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </DataTable>
        )}
      </SectionCard>
    </>
  );
}
