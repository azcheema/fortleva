"use client";

import { TimerIcon } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

import { DataTable, EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDuration, formatMoney, type DurationStyle } from "@/lib/format";

export type TeamLine = {
  memberId: string;
  memberName: string;
  projectId: string | null;
  projectKey: string | null;
  projectName: string | null;
  seconds: number;
  billableSeconds: number;
  amount: string | null;
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

/** Two read-only tables: hours per member × project, and closed-shift day totals. */
export function TeamTable({
  lines,
  shifts,
  durationStyle,
  days,
}: {
  lines: TeamLine[];
  shifts: TeamShiftDay[];
  durationStyle: DurationStyle;
  days: string[];
}) {
  const t = useTranslations("time.team");
  const locale = useLocale();
  const fmt = (seconds: number) => formatDuration(locale, seconds / 60, durationStyle);
  const hasAmounts = lines.some((l) => l.amount !== null);
  const dayFmt = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", timeZone: "UTC" });

  // Per-member totals for the footer-ish rows.
  const byMember = new Map<string, { name: string; seconds: number; billable: number; amount: number }>();
  for (const l of lines) {
    const m = byMember.get(l.memberId) ?? { name: l.memberName, seconds: 0, billable: 0, amount: 0 };
    m.seconds += l.seconds;
    m.billable += l.billableSeconds;
    m.amount += l.amount ? Number(l.amount) : 0;
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
                    <TableCell>{l.memberName}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {l.projectKey ? (
                        <>
                          <span className="num-id">{l.projectKey}</span> {l.projectName}
                        </>
                      ) : (
                        t("hours.internal")
                      )}
                    </TableCell>
                    <TableCell className="num text-right">{fmt(l.seconds)}</TableCell>
                    <TableCell priority="medium" className="num text-right text-muted-foreground">{fmt(l.billableSeconds)}</TableCell>
                    {hasAmounts ? (
                      <TableCell priority="low" className="num text-right text-muted-foreground">
                        {l.amount ? formatMoney(locale, Number(l.amount), "SEK") : "—"}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
                {[...byMember.entries()].map(([id, m]) => (
                  <TableRow key={`total:${id}`} className="bg-muted/40">
                    <TableCell className="font-semibold">{m.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{t("hours.total")}</TableCell>
                    <TableCell className="num text-right font-semibold">{fmt(m.seconds)}</TableCell>
                    <TableCell priority="medium" className="num text-right">{fmt(m.billable)}</TableCell>
                    {hasAmounts ? (
                      <TableCell priority="low" className="num text-right">{formatMoney(locale, m.amount, "SEK")}</TableCell>
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
                  {days.map((d) => (
                    <TableHead key={d} className="num text-right">
                      {dayFmt.format(new Date(`${d}T00:00:00Z`))}
                    </TableHead>
                  ))}
                  <TableHead className="num text-right">{t("shifts.columns.total")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shiftMembers.map((m) => {
                  const row = shiftByMember.get(m.id) ?? new Map<string, TeamShiftDay>();
                  const total = [...row.values()].reduce((s, d) => s + d.workedSeconds, 0);
                  return (
                    <TableRow key={m.id}>
                      <TableCell>{m.name}</TableCell>
                      {days.map((d) => {
                        const cell = row.get(d);
                        return (
                          <TableCell key={d} className="num text-right text-muted-foreground">
                            {cell ? fmt(cell.workedSeconds) : "—"}
                          </TableCell>
                        );
                      })}
                      <TableCell className="num text-right font-semibold">{fmt(total)}</TableCell>
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
