import { monthGrid } from "@/lib/calendar";
import { REPEAT_MAX_SKIP, copyDueDate, owedCopy, repeatAfter, type RepeatRhythm } from "@/lib/repeat-rules";
import { addDays, isIsoDate, shiftMonth, weekContaining, type WeekStart } from "@/lib/week";

/**
 * THE CALENDAR'S PURE HALF (slice 128; founder decision C105 — design
 * docs/research/2026-10-17-slice-128-task-calendar-design.md). No database,
 * no clock: the period a view shows, the page's parameters read strictly, the
 * repeat copies a series will make inside a period, and a day's entries cut
 * to what a month cell holds. Shared by the read (`src/modules/work/calendar.ts`)
 * and the page; pinned by `calendar-plan.test.ts`.
 *
 * Days are `YYYY-MM-DD` throughout. A task's due date is a `@db.Date`, so its
 * UTC day IS its day; "today" is the caller's (the member's zone).
 */

export const CALENDAR_VIEWS = ["month", "week"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

/** Entries a month cell draws before "+N more" (design §3.1). */
export const CALENDAR_DAY_LIMIT = 3;
/** Tasks one period draws at most (design §3.2) — past it the page says so. */
export const CALENDAR_ENTRY_CAP = 500;
/** Projected repeat copies one period draws at most (design §3.3). */
export const CALENDAR_PROJECTION_CAP = 500;
/** Copy days walked per series at most (design §3.3): a weekly series over a six-week month is six. */
export const CALENDAR_SERIES_STEPS = 60;

/**
 * How far ahead copies are projected: three years from today (both reviews'
 * LOW). Past it a period draws no copies — the walk to a date decades ahead
 * would cost thousands of steps per series in one render — and says so.
 */
export const CALENDAR_PROJECTION_HORIZON_DAYS = 3 * 366;

export const isCalendarView = (v: unknown): v is CalendarView =>
  typeof v === "string" && (CALENDAR_VIEWS as readonly string[]).includes(v);

const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** A project key as the page accepts it (the projects service's own shape: a letter, then letters or digits, ≤ 8). */
const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,7}$/;

export type CalendarParams = {
  readonly view: CalendarView;
  /** A day inside the period shown. */
  readonly date: string;
  /** A project key to narrow to — still to be found in the member's scope. */
  readonly project: string | null;
  readonly mine: boolean;
};

/** The page's search parameters, read strictly: anything unknown falls back, nothing is echoed. */
export function parseCalendarParams(params: Readonly<Record<string, string | string[] | undefined>>, today: string): CalendarParams {
  const view = one(params["view"]);
  const date = one(params["date"]);
  const project = one(params["project"]);
  return {
    view: isCalendarView(view) ? view : "month",
    date: isIsoDate(date) ? date : today,
    project: project !== undefined && PROJECT_KEY.test(project) ? project : null,
    mine: one(params["mine"]) === "1",
  };
}

/** `/calendar` with these parameters — the defaults written as no parameter. */
export function calendarHref(p: CalendarParams, today: string): string {
  const q = new URLSearchParams();
  if (p.view !== "month") q.set("view", p.view);
  if (p.date !== today) q.set("date", p.date);
  if (p.project) q.set("project", p.project);
  if (p.mine) q.set("mine", "1");
  const s = q.toString();
  return s === "" ? "/calendar" : `/calendar?${s}`;
}

export type CalendarPeriod = {
  readonly view: CalendarView;
  /** The grid's weeks, each seven days, in the workspace's week order. */
  readonly weeks: readonly (readonly string[])[];
  /** The first and last day drawn (inclusive) — the read's range. */
  readonly from: string;
  readonly to: string;
  /** `YYYY-MM` for a month view (the days outside it are muted), null for a week. */
  readonly month: string | null;
  /** A day inside the previous and the next period. */
  readonly prev: string;
  readonly next: string;
};

/**
 * The days a view draws. A MONTH is its weeks in the workspace's week order —
 * `monthGrid`'s six rows less any that hold no day of the month — and a WEEK
 * is the seven days containing `date`. Days outside 1970–2100 never occur:
 * `isIsoDate` bounds the parameter, and the grid's edge rows are dropped.
 */
export function calendarPeriod(view: CalendarView, date: string, weekStart: WeekStart): CalendarPeriod {
  if (view === "week") {
    const w = weekContaining(date, weekStart);
    return { view, weeks: [w.days], from: w.from, to: w.to, month: null, prev: addDays(date, -7), next: addDays(date, 7) };
  }
  const month = date.slice(0, 7);
  const weeks = monthGrid(month, weekStart)
    .map((r) => r.days)
    .filter((days) => days.some((d) => d !== null && d.slice(0, 7) === month) && days.every((d) => d !== null)) as string[][];
  return {
    view,
    weeks,
    from: weeks[0]![0]!,
    to: weeks[weeks.length - 1]![6]!,
    month,
    prev: `${shiftMonth(month, -1)}-01`,
    next: `${shiftMonth(month, 1)}-01`,
  };
}

/** A copy a repeating task WILL make: the day it appears and the day it is due. */
export type ProjectedCopy = { readonly appearsOn: string; readonly dueOn: string };

/**
 * The copies a series will make whose DUE day falls in `[from, to]` (C105 (c),
 * design §3.3). The walk starts at the series' next day — or, when that day
 * has come and the copier has not run yet, at the copy it owes now (it will
 * exist within the hour) — skips the copies due before the range (at most
 * `REPEAT_MAX_SKIP` steps), then collects at most `CALENDAR_SERIES_STEPS`
 * until the range's end. A copy already made has appeared on today or before
 * and is a real task: the walk starts after it, so never draws it twice.
 */
export function projectCopies(
  series: { readonly nextOn: string; readonly rhythm: RepeatRhythm; readonly anchorDay: number | null },
  today: string,
  from: string,
  to: string,
): ProjectedCopy[] {
  const owed = owedCopy(series.nextOn, today, series.rhythm, series.anchorDay);
  let day: string | null = owed ? owed.madeFor : series.nextOn;
  // Skip the copies due before the range — cheap date steps, bounded like the
  // copier's own skip — so a period years ahead still finds its copies.
  for (let skipped = 0; day !== null && skipped <= REPEAT_MAX_SKIP; skipped++) {
    const due = copyDueDate(day, series.rhythm, series.anchorDay);
    if (due === null || due >= from) break;
    day = repeatAfter(day, series.rhythm, series.anchorDay);
  }
  const out: ProjectedCopy[] = [];
  for (let step = 0; step < CALENDAR_SERIES_STEPS && day !== null; step++) {
    const due = copyDueDate(day, series.rhythm, series.anchorDay);
    if (due === null || due > to) break;
    if (due >= from) out.push({ appearsOn: day, dueOn: due });
    day = repeatAfter(day, series.rhythm, series.anchorDay);
  }
  return out;
}

/** A day's entries cut to what a month cell draws, and how many more there are. */
export function cutForCell<T>(entries: readonly T[], limit: number = CALENDAR_DAY_LIMIT): { shown: readonly T[]; more: number } {
  return entries.length <= limit ? { shown: entries, more: 0 } : { shown: entries.slice(0, limit), more: entries.length - limit };
}
