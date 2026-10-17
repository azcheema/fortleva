import { ChartNoAxesGanttIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import type { MemberActor } from "@/authz/authorize";
import { EmptyState, EntityTile, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { withTenant } from "@/db";
import { resolveTimeZone } from "@/i18n/resolve";
import { todayIn } from "@/lib/due-date";
import { dateColumn } from "@/lib/duration";
import { dateFormat } from "@/lib/format";
import {
  barGeometry,
  dayOffset,
  lineupWindow,
  monthTicks,
  projectsHref,
  weekLines,
} from "@/lib/lineup-plan";
import { isIsoDate } from "@/lib/week";
import { readPreferences } from "@/preferences/service";
import { LINEUP_PROJECT_CAP, readProjectLineup } from "@/projects/lineup";

import { ProjectLineup, type LineupRow } from "./project-lineup";

/** A month name sits at the window's left edge only when the first month change leaves it room. */
const LEAD_MONTH_MIN_GAP = 12;

/**
 * The Projects page's Timeline view (slice 130; founder decision C107 (a),
 * (d) — design §3.6): every planned, active or paused project in scope as a
 * bar from its start day to its launch day across 13 weeks, its milestones on
 * it, today marked; Earlier, Today and Later move the window. Projects missing
 * a date, or whose launch is before their start, are listed underneath, each a
 * link to its Overview where the dates are set.
 *
 * Every word and date is formatted here, in UTC — the days are stored as UTC
 * midnight — so no label can differ between Node's and the browser's ICU.
 * "Today" is the member's day; the weeks start on the workspace's day.
 */
export async function ProjectsTimeline({
  ctx,
  from,
}: {
  ctx: { readonly tenantId: string; readonly actor: MemberActor };
  /** The requested first day (already strictly parsed), or null for the default window. */
  from: string | null;
}) {
  const [t, locale, timeZone] = await Promise.all([getTranslations("projects.lineup"), getLocale(), resolveTimeZone()]);
  const prefs = await withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, (tx) => readPreferences(tx, ctx.tenantId));
  const today = todayIn(timeZone);
  const w = lineupWindow(from, today, prefs.weekStart);
  const lineup = await readProjectLineup(ctx, { timeZone });

  const thisYear = today.slice(0, 4);
  const short = dateFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const long = dateFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const day = (iso: string) => (iso.slice(0, 4) === thisYear ? short : long).format(dateColumn(iso));
  const monthShort = dateFormat(locale, { month: "short", timeZone: "UTC" });
  const monthYear = dateFormat(locale, { month: "short", year: "numeric", timeZone: "UTC" });
  // January says its year, so a window across New Year reads right.
  const monthText = (iso: string) => (iso.slice(5, 7) === "01" ? monthYear : monthShort).format(dateColumn(iso));

  const rows: LineupRow[] = [];
  const undated: { id: string; key: string; name: string; reason: string }[] = [];
  for (const p of lineup.projects) {
    if (p.start === null || p.launch === null || p.start > p.launch) {
      undated.push({
        id: p.id,
        key: p.key,
        name: p.name,
        reason:
          p.start === null && p.launch === null
            ? t("missingBoth")
            : p.start === null
              ? t("missingStart")
              : p.launch === null
                ? t("missingLaunch")
                : t("reversed"),
      });
      continue;
    }
    const start = p.start;
    const launch = p.launch;
    const bar = barGeometry(start, launch, w);
    const datesText = t("dates", { start: day(start), launch: day(launch) });
    const dated = p.milestones.filter((m): m is typeof m & { day: string } => m.day !== null);
    const milestoneWords = (m: { name: string; done: boolean; day: string }) =>
      m.done ? t("milestoneDone", { name: m.name, date: day(m.day) }) : t("milestoneOpen", { name: m.name, date: day(m.day) });
    rows.push({
      id: p.id,
      key: p.key,
      name: p.name,
      href: `/projects/${p.key}`,
      clientName: p.clientName,
      datesText,
      srText: [
        t("srDates", { start: day(start), launch: day(launch) }),
        dated.length > 0 ? t("srMilestones", { list: dated.map(milestoneWords).join("; ") }) : null,
      ]
        .filter(Boolean)
        .join(" "),
      status: p.status,
      late: launch < today,
      bar,
      barTitle: t("barTitle", { name: p.name, dates: datesText }),
      edgeText: bar.kind === "before" ? t("endedBefore", { date: day(launch) }) : bar.kind === "after" ? t("startsAfter", { date: day(start) }) : null,
      milestones: dated.flatMap((m) => {
        const left = dayOffset(m.day, w);
        return left === null ? [] : [{ id: m.id, left, done: m.done, title: milestoneWords(m) }];
      }),
    });
  }

  const ticks = monthTicks(w);
  const months = [
    ...(ticks.length === 0 || ticks[0]!.left >= LEAD_MONTH_MIN_GAP ? [{ key: "lead", left: 0, text: monthText(w.from) }] : []),
    ...ticks.map((tick) => ({ key: tick.day, left: tick.left, text: monthText(tick.day) })),
  ];
  const todayLeft = dayOffset(today, w);
  const nav = (date: string | null) => projectsHref({ view: "timeline", archived: false, from: date });

  return (
    <div className="mt-6 flex flex-col gap-6">
      <SectionCard
        title={t("rangeTitle", { from: long.format(dateColumn(w.from)), to: long.format(dateColumn(w.to)) })}
        contentClassName="p-0"
        actions={
          <div className="flex flex-wrap items-center gap-1.5" data-testid="lineup-nav">
            {/* Not drawn past the dates the page accepts (1970–2100): such a
                link would land on the default window, a jump to today. */}
            {isIsoDate(w.prev) ? (
              <Button asChild variant="outline" size="icon-sm">
                <Link href={nav(w.prev)} aria-label={t("earlier")} title={t("earlier")} data-testid="lineup-earlier">
                  <ChevronLeftIcon aria-hidden="true" />
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="outline" size="sm">
              <Link href={nav(null)} data-testid="lineup-today">
                {t("today")}
              </Link>
            </Button>
            {isIsoDate(w.next) ? (
              <Button asChild variant="outline" size="icon-sm">
                <Link href={nav(w.next)} aria-label={t("later")} title={t("later")} data-testid="lineup-later">
                  <ChevronRightIcon aria-hidden="true" />
                </Link>
              </Button>
            ) : null}
          </div>
        }
      >
        {lineup.truncated ? (
          <p className="border-b border-border px-4 py-2 text-sm text-muted-foreground">{t("truncated", { count: LINEUP_PROJECT_CAP })}</p>
        ) : null}
        {rows.length === 0 ? (
          <EmptyState
            variant="empty"
            icon={ChartNoAxesGanttIcon}
            title={t("empty.title")}
            body={undated.length > 0 ? t("empty.bodyUndated") : t("empty.body")}
            action={
              // Projects that only need dates are listed below; with none, the
              // list is where a project is made.
              <Button asChild size="sm">
                <Link href={undated.length > 0 ? "#lineup-undated" : projectsHref({ view: "list", archived: false, from: null })}>
                  {undated.length > 0 ? t("empty.toUndated") : t("empty.toList")}
                </Link>
              </Button>
            }
          />
        ) : (
          <ProjectLineup
            label={t("listLabel")}
            rows={rows}
            months={months}
            weekLines={weekLines()}
            today={todayLeft === null ? null : { left: todayLeft, title: t("todayTitle", { date: day(today) }) }}
            lateLabel={t("late")}
            legend={{ today: t("legendToday"), done: t("legendDone"), open: t("legendOpen") }}
          />
        )}
      </SectionCard>

      {undated.length > 0 ? (
        <SectionCard id="lineup-undated" className="scroll-mt-16" title={t("undated.title")} description={t("undated.description")}>
          <ul className="flex flex-col gap-2" data-testid="lineup-undated">
            {undated.map((p) => (
              <li key={p.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-project-key={p.key}>
                <Link
                  href={`/projects/${p.key}`}
                  className="flex min-w-0 items-center gap-2 rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <EntityTile id={p.id} name={p.name} />
                  <span className="num-id shrink-0 font-mono text-xs text-muted-foreground">{p.key}</span>
                  <span className="min-w-0 truncate">{p.name}</span>
                </Link>
                <span className="text-muted-foreground">{p.reason}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
