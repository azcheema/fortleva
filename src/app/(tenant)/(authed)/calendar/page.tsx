import type { Metadata } from "next";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { resolvePreferences, resolveTimeZone } from "@/i18n/resolve";
import { CALENDAR_ENTRY_CAP, calendarHref, calendarPeriod, parseCalendarParams, type CalendarParams } from "@/lib/calendar-plan";
import { todayIn } from "@/lib/due-date";
import { dateColumn } from "@/lib/duration";
import { dateFormat, formatDay } from "@/lib/format";
import { addDays } from "@/lib/week";
import { itemReturnTo } from "@/lib/work-view";
import { requireTenantContext } from "@/members/tenant-context";
import { readCalendar } from "@/modules/work";

import { CalendarBoard, type CalendarDay, type CalendarGhost, type CalendarTask, type MoveChoice } from "./calendar-board";
import { CalendarProjectFilter } from "./calendar-filter";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("calendar");
  return { title: t("title") };
}

/** "Move to…"'s days: today and the fortnight after. */
const MOVE_DAYS = 15;

/**
 * /calendar (slice 128; founder decision C105 — design
 * docs/research/2026-10-17-slice-128-task-calendar-design.md). Every task
 * with a due date in the projects the member reaches (C105 (b)), a month or a
 * week at a time, with the copies repeating tasks will make drawn faintly on
 * their days (C105 (c)), and a task dragged — or moved with "Move…" — to
 * another day (C105 (d)).
 *
 * EVERY WORD AND DATE IS FORMATTED HERE, on the server, in UTC (a due date is
 * a `@db.Date`): the client island receives strings, so no label can differ
 * between Node's and the browser's ICU on hydration. "Today" is the member's
 * day (`resolveTimeZone`); the week order is the workspace's (`ui.weekStart`).
 * The parameters are read strictly (`parseCalendarParams`) and every link is
 * built from the parsed values, never from the raw query.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const [t, tCommon, tRepeat, locale, prefs, timeZone, raw] = await Promise.all([
    getTranslations("calendar"),
    getTranslations("common"),
    getTranslations("projects.item.repeat"),
    getLocale(),
    resolvePreferences(),
    resolveTimeZone(),
    searchParams,
  ]);
  const today = todayIn(timeZone);
  const params = parseCalendarParams(raw, today);
  const period = calendarPeriod(params.view, params.date, prefs?.weekStart ?? "MONDAY");
  const read = await readCalendar(ctx, {
    from: period.from,
    to: period.to,
    today,
    projectKey: params.project,
    mine: params.mine,
  });

  if (!read) {
    return (
      <Page>
        <PageHeader title={t("title")} />
        <div className="mt-6">
          <SectionCard>
            <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("forbidden")} />
          </SectionCard>
        </div>
      </Page>
    );
  }

  // The links keep the filter AS APPLIED — a key outside the member's scope
  // was no filter, and is not carried on.
  const applied: CalendarParams = { ...params, project: read.projectKey };
  const href = (over: Partial<CalendarParams>) => calendarHref({ ...applied, ...over }, today);

  const at = (iso: string) => dateColumn(iso);
  const longDay = dateFormat(locale, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const shortDay = dateFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const weekday = dateFormat(locale, { weekday: "short", timeZone: "UTC" });
  const monthTitle = dateFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" });

  const weeks: CalendarDay[][] = period.weeks.map((week) =>
    week.map((iso) => ({
      iso,
      dayNumber: String(Number(iso.slice(8, 10))),
      label: longDay.format(at(iso)),
      inPeriod: period.month === null || iso.slice(0, 7) === period.month,
      isToday: iso === today,
    })),
  );
  const weekdayLabels = period.weeks[0]!.map((iso) => weekday.format(at(iso)));

  const tasks: CalendarTask[] = read.entries.map((e) => ({
    id: e.id,
    key: `${e.projectKey}-${e.number}`,
    projectKey: e.projectKey,
    title: e.title,
    href: itemReturnTo("page", e.projectKey, e.number),
    done: e.stateCategory === "DONE",
    dueOn: e.dueOn,
    repeatWords: e.repeatRhythm ? tRepeat("marker", { rhythm: tRepeat(`inSentence.${e.repeatRhythm}`) }) : null,
  }));
  const ghosts: CalendarGhost[] = read.copies.map((c) => ({
    key: c.key,
    title: c.title,
    href: itemReturnTo("page", c.projectKey, c.holderNumber),
    words: t("nextCopy", { title: c.title, key: `${c.projectKey}-${c.holderNumber}`, date: shortDay.format(at(c.appearsOn)) }),
    dueOn: c.dueOn,
  }));
  const moreHrefs = Object.fromEntries(period.weeks.flat().map((iso) => [iso, href({ view: "week", date: iso })]));
  const moveChoices: MoveChoice[] = Array.from({ length: MOVE_DAYS }, (_, i) => {
    const iso = addDays(today, i);
    const date = shortDay.format(at(iso));
    return { iso, label: i === 0 ? t("moveToday", { date }) : i === 1 ? t("moveTomorrow", { date }) : date };
  });

  const periodTitle =
    period.month !== null
      ? monthTitle.format(at(`${period.month}-01`))
      : t("weekTitle", { from: formatDay(locale, at(period.from)), to: formatDay(locale, at(period.to)) });
  const prevLabel = params.view === "month" ? t("previousMonth") : t("previousWeek");
  const nextLabel = params.view === "month" ? t("nextMonth") : t("nextWeek");

  return (
    <Page width="wide">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {read.projects.length > 1 ? (
              <CalendarProjectFilter
                label={t("projectFilter")}
                value={read.projectKey ?? ""}
                options={[{ value: "", label: t("allProjects") }, ...read.projects.map((p) => ({ value: p.key, label: p.name }))]}
              />
            ) : null}
            <Button asChild variant="outline" size="sm">
              <Link href={href({ mine: !params.mine })} data-testid="calendar-mine">
                {params.mine ? t("everyone") : t("onlyMine")}
              </Link>
            </Button>
          </div>
        }
      />

      <div className="mt-6">
        <SectionCard
          title={periodTitle}
          contentClassName="p-0"
          actions={
            <div className="flex flex-wrap items-center gap-1.5" data-testid="calendar-nav">
              <Button asChild variant={params.view === "month" ? "secondary" : "ghost"} size="sm">
                <Link href={href({ view: "month" })} aria-current={params.view === "month" ? "page" : undefined} data-testid="calendar-view-month">
                  {t("viewMonth")}
                </Link>
              </Button>
              <Button asChild variant={params.view === "week" ? "secondary" : "ghost"} size="sm">
                <Link href={href({ view: "week" })} aria-current={params.view === "week" ? "page" : undefined} data-testid="calendar-view-week">
                  {t("viewWeek")}
                </Link>
              </Button>
              <Button asChild variant="outline" size="icon-sm">
                <Link href={href({ date: period.prev })} aria-label={prevLabel} title={prevLabel} data-testid="calendar-prev">
                  <ChevronLeftIcon aria-hidden="true" />
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={href({ date: today })} data-testid="calendar-today">
                  {t("today")}
                </Link>
              </Button>
              <Button asChild variant="outline" size="icon-sm">
                <Link href={href({ date: period.next })} aria-label={nextLabel} title={nextLabel} data-testid="calendar-next">
                  <ChevronRightIcon aria-hidden="true" />
                </Link>
              </Button>
            </div>
          }
        >
          {read.truncated ? (
            <p className="border-b border-border px-4 py-2 text-sm text-muted-foreground" data-testid="calendar-truncated">
              {t("truncated", { count: CALENDAR_ENTRY_CAP })}
            </p>
          ) : null}
          {read.copiesTruncated ? (
            <p className="border-b border-border px-4 py-2 text-sm text-muted-foreground">{t("copiesTruncated")}</p>
          ) : null}
          {read.copiesBeyondHorizon ? (
            <p className="border-b border-border px-4 py-2 text-sm text-muted-foreground" data-testid="calendar-beyond-horizon">
              {t("copiesBeyondHorizon")}
            </p>
          ) : null}
          <CalendarBoard
            view={params.view}
            weeks={weeks}
            weekdayLabels={weekdayLabels}
            tasks={tasks}
            ghosts={ghosts}
            canEdit={read.canEdit}
            today={today}
            moreHrefs={moreHrefs}
            moveChoices={moveChoices}
          />
        </SectionCard>
      </div>
    </Page>
  );
}
