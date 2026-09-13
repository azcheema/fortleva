import { addDays, isoWeekOf, MAX_YEAR, MIN_YEAR, monthContaining, shiftMonth, weekContaining, type WeekStart } from "./week";

/**
 * The due-date calendar's arithmetic, pure (no React, no directive, no
 * Date crossing a zone): every value is an ISO date string, and the grid
 * is built on `week.ts` — the same week path `/time` already ships — so
 * a week number here can never disagree with a weekly total there.
 *
 * The range is `isIsoDate`'s: a day outside [1970, 2100] is not a date
 * the server accepts, so the grid renders it as an inert spacer rather
 * than a button that could only fail.
 */

export const CALENDAR_MIN = `${MIN_YEAR}-01-01`;
export const CALENDAR_MAX = `${MAX_YEAR}-12-31`;

export const clampDate = (iso: string): string =>
  iso < CALENDAR_MIN ? CALENDAR_MIN : iso > CALENDAR_MAX ? CALENDAR_MAX : iso;

/**
 * A day of null = outside [CALENDAR_MIN, CALENDAR_MAX]: rendered as an
 * inert spacer, never a disabled day. `isoWeek` is null exactly when
 * EVERY day of the row is: a week with no day in it has no number.
 */
export type CalendarRow = { isoWeek: number | null; days: readonly (string | null)[] };

const GRID_ROWS = 6;

/**
 * ALWAYS 6 rows × 7 (a month needs 4–6), so the modal popover never
 * resizes while the member pages through months.
 *
 * A row's week number follows `weekContaining`'s convention — the ISO
 * week of the row's start + 3 — and is computed from the RAW day before
 * any nulling, so a row that straddles the range bound still has one.
 * A row wholly past the bound has none: December 2100 always ends in a
 * sixth row of January 2101 days, under every week start, and a "1"
 * beside seven spacers would be a week that does not exist here. The
 * lower bound has no such row — 1970-01-01 is always in the first.
 */
export function monthGrid(yearMonth: string, weekStart: WeekStart): CalendarRow[] {
  const from = weekContaining(`${yearMonth}-01`, weekStart).from;
  return Array.from({ length: GRID_ROWS }, (_, r) => {
    const rowStart = addDays(from, r * 7);
    const days = Array.from({ length: 7 }, (_, c) => {
      const day = addDays(rowStart, c);
      return day < CALENDAR_MIN || day > CALENDAR_MAX ? null : day;
    });
    const isoWeek = days.every((d) => d === null) ? null : isoWeekOf(addDays(rowStart, 3)).week;
    return { isoWeek, days };
  });
}

export type CalendarMove =
  | "prevDay"
  | "nextDay"
  | "prevWeek"
  | "nextWeek"
  | "weekStart"
  | "weekEnd"
  | "prevMonth"
  | "nextMonth"
  | "prevYear"
  | "nextYear";

/**
 * The keys a focused day OWNS, and nothing else.
 *
 * null for any Ctrl/Meta/Alt chord (⌘K must still reach the window
 * dispatcher), for Shift with anything but PageUp/PageDown, and for
 * every key the grid does not own — Enter and Space stay the native
 * button click, Tab stays Radix's focus loop, Escape stays Radix's.
 * The caller preventDefaults exactly the keys this names.
 */
export function calendarMoveOf(e: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): CalendarMove | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.shiftKey) {
    if (e.key === "PageUp") return "prevYear";
    if (e.key === "PageDown") return "nextYear";
    return null;
  }
  switch (e.key) {
    case "ArrowLeft":
      return "prevDay";
    case "ArrowRight":
      return "nextDay";
    case "ArrowUp":
      return "prevWeek";
    case "ArrowDown":
      return "nextWeek";
    case "Home":
      return "weekStart";
    case "End":
      return "weekEnd";
    case "PageUp":
      return "prevMonth";
    case "PageDown":
      return "nextMonth";
    default:
      return null;
  }
}

/** "YYYY-MM-DD" moved by whole months, the day clamped to the target month's length (2026-01-31 +1 → 2026-02-28); always in range. */
export function addMonthsClamped(iso: string, delta: number): string {
  const yearMonth = shiftMonth(iso.slice(0, 7), delta);
  const lastDay = Number(monthContaining(`${yearMonth}-01`).to.slice(8, 10));
  const day = Math.min(Number(iso.slice(8, 10)), lastDay);
  return clampDate(`${yearMonth}-${String(day).padStart(2, "0")}`);
}

/**
 * Where a move lands. Pure and always clamped. Home/End are the grid
 * week's first/last day under `weekStart`; months and years keep the
 * day of the month, clamped to the target month's length.
 */
export function moveDate(iso: string, move: CalendarMove, weekStart: WeekStart): string {
  switch (move) {
    case "prevDay":
      return clampDate(addDays(iso, -1));
    case "nextDay":
      return clampDate(addDays(iso, 1));
    case "prevWeek":
      return clampDate(addDays(iso, -7));
    case "nextWeek":
      return clampDate(addDays(iso, 7));
    case "weekStart":
      return clampDate(weekContaining(iso, weekStart).from);
    case "weekEnd":
      return clampDate(weekContaining(iso, weekStart).to);
    case "prevMonth":
      return addMonthsClamped(iso, -1);
    case "nextMonth":
      return addMonthsClamped(iso, 1);
    case "prevYear":
      return addMonthsClamped(iso, -12);
    case "nextYear":
      return addMonthsClamped(iso, 12);
  }
}

const YEAR_MONTH_RE = /^\d{4}-\d{2}$/;

/** Whether a "YYYY-MM" month may be shown: 1970-01 … 2100-12. */
export const canShowMonth = (yearMonth: string): boolean =>
  YEAR_MONTH_RE.test(yearMonth) &&
  yearMonth >= CALENDAR_MIN.slice(0, 7) &&
  yearMonth <= CALENDAR_MAX.slice(0, 7);
