import { addDays, isIsoDate } from "@/lib/week";

/**
 * A REPEATING TASK'S DAYS (slice 127; founder decision C103 (b), (d), (e) —
 * docs/research/2026-10-17-slice-127-repeating-tasks-design.md §3.2–§3.5).
 * Pure — no database, no clock of its own — and ONE module for the three
 * places that ask: the setting's service (`src/modules/work/repeat.ts`), the
 * copier the jobs route runs (`repeat-copies.ts`) and the task panel's
 * Repeat row, which shows the day each rhythm would start on.
 *
 * Days are `YYYY-MM-DD` in the WORKSPACE's zone throughout: `next_on` is a
 * date column, and the caller's `today` is the workspace's (the copier) or
 * the member's (the panel's hint; the service decides again with the
 * workspace's).
 *
 * A MONTH RHYTHM KEEPS ITS DAY. Every step counts whole months and lands on
 * the ANCHOR — the day of the month the member picked — or on that month's
 * last day when the month is shorter: a series on the 31st is next on
 * 28 February and on 31 March again, never drifting to the 28th for good.
 * That is the agreements' rule (`src/services/renewal-dates.ts`
 * `addIntervals`), restated here so this module stays importable by a
 * browser island; `repeat-rules.test.ts` pins the two equal. The database
 * holds it too (`work_item_repeat_anchor_lands`). A week rhythm has no
 * anchor: a step of 7 or 14 days never changes the weekday.
 */

export const REPEAT_RHYTHMS = ["WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"] as const;
export type RepeatRhythm = (typeof REPEAT_RHYTHMS)[number];

export const isRepeatRhythm = (v: unknown): v is RepeatRhythm =>
  typeof v === "string" && (REPEAT_RHYTHMS as readonly string[]).includes(v);

const WEEK_STEP: Partial<Record<RepeatRhythm, number>> = { WEEKLY: 7, BIWEEKLY: 14 };
const MONTH_STEP: Partial<Record<RepeatRhythm, number>> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };

export const isWeekRhythm = (rhythm: RepeatRhythm): boolean => WEEK_STEP[rhythm] !== undefined;

/**
 * How far ahead the next copy may be set: two years from today (design
 * §3.2) — room for a yearly series' first copy a year and some out, and a
 * bound on a typo.
 */
export const REPEAT_MAX_DAYS_AHEAD = 731;

/**
 * The most tasks under a repeating task (its subtasks, and an epic's tasks
 * and theirs): setting a repeat on more is refused, and a copy of one that
 * grew past it takes the first this many (design §3.3).
 */
export const REPEAT_MAX_SUBTASKS = 100;

/**
 * The most description a copy carries, the task's and its subtasks' together,
 * measured as the stored JSON's bytes (the security review's M-1: a hundred
 * descriptions near their 512 KB cap would be ~52 MB in one transaction every
 * period). Setting a repeat past it is refused; a copy of a tree that grew
 * past it leaves the later descriptions out and says so in its audit row.
 */
export const REPEAT_MAX_DESCRIPTION_BYTES = 2 * 1024 * 1024;

/**
 * The most repeat days one copy may skip (§3.5: one copy, for the latest
 * day). Fifty years of weeks: a series further behind than that is a broken
 * row the copier leaves alone rather than looping over.
 */
export const REPEAT_MAX_SKIP = 2600;

const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number, width: number): string => String(n).padStart(width, "0");

function partsOf(day: string): { y: number; m: number; d: number } {
  return { y: Number(day.slice(0, 4)), m: Number(day.slice(5, 7)), d: Number(day.slice(8, 10)) };
}

const isAnchor = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 31;

/**
 * The anchor a series stores when its next day is `day`: the day of the
 * month for a month rhythm, null for a week one (the CHECK's shape).
 */
export function anchorFor(rhythm: RepeatRhythm, day: string): number | null {
  return isWeekRhythm(rhythm) ? null : partsOf(day).d;
}

/**
 * The repeat day after `day`. Null for a malformed day, a month rhythm
 * without a whole anchor, or a year past 2100 (`isIsoDate`'s range — the
 * calendar's own).
 */
export function repeatAfter(day: string, rhythm: RepeatRhythm, anchor: number | null): string | null {
  if (!isIsoDate(day)) return null;
  const week = WEEK_STEP[rhythm];
  if (week !== undefined) {
    const next = addDays(day, week);
    return isIsoDate(next) ? next : null;
  }
  if (!isAnchor(anchor)) return null;
  const p = partsOf(day);
  const months = p.y * 12 + (p.m - 1) + MONTH_STEP[rhythm]!;
  const y = Math.floor(months / 12);
  const m = (months % 12) + 1;
  const next = `${pad(y, 4)}-${pad(m, 2)}-${pad(Math.min(anchor, daysInMonth(y, m)), 2)}`;
  return isIsoDate(next) ? next : null;
}

/**
 * Where a repeat that STARTS on `today` is first copied: one period from
 * today — the same weekday next week (or in two), the same day next month,
 * in three months or next year, clamped to a shorter month's end (design
 * §3.2). The member moves it with the Next copy row.
 */
export function firstRepeatDay(rhythm: RepeatRhythm, today: string): string | null {
  if (!isIsoDate(today)) return null;
  return repeatAfter(today, rhythm, anchorFor(rhythm, today));
}

/** True when `day` may be a series' next day on `today`: a real day after today, at most two years ahead. */
export function nextDayAllowed(day: string, today: string): boolean {
  if (!isIsoDate(day) || !isIsoDate(today)) return false;
  return day > today && day <= addDays(today, REPEAT_MAX_DAYS_AHEAD);
}

/**
 * The copy a series next on `nextOn` owes on `today` (C103 (b), design
 * §3.5): ONE copy, for the LATEST repeat day on or before today — the days
 * before it that passed while no kick ran are not made later — and the
 * series' next day after it, which is after today. Null when nothing is
 * owed yet (`nextOn` is after today), for a malformed row, or a series more
 * than `REPEAT_MAX_SKIP` days behind.
 */
export function owedCopy(
  nextOn: string,
  today: string,
  rhythm: RepeatRhythm,
  anchor: number | null,
): { readonly madeFor: string; readonly nextOn: string; readonly skipped: number } | null {
  if (!isIsoDate(nextOn) || !isIsoDate(today) || nextOn > today) return null;
  let madeFor = nextOn;
  for (let skipped = 0; skipped <= REPEAT_MAX_SKIP; skipped++) {
    const after = repeatAfter(madeFor, rhythm, anchor);
    if (after === null) return null;
    if (after > today) return { madeFor, nextOn: after, skipped };
    madeFor = after;
  }
  return null;
}

/**
 * A copy's due date (C103 (d)): the day before the repeat day after the one
 * it was made for — a monthly copy made for 1 November is due 30 November.
 */
export function copyDueDate(madeFor: string, rhythm: RepeatRhythm, anchor: number | null): string | null {
  const after = repeatAfter(madeFor, rhythm, anchor);
  return after === null ? null : addDays(after, -1);
}

/** The text a history row stores for a setting: `RHYTHM:YYYY-MM-DD`, or null for none. */
export const repeatValue = (s: { readonly rhythm: RepeatRhythm; readonly nextOn: string } | null): string | null =>
  s === null ? null : `${s.rhythm}:${s.nextOn}`;

/** A history row's value read back — strictly, or null (activity-copy's rule: never format what it cannot read). */
export function parseRepeatValue(v: string | null): { rhythm: RepeatRhythm; nextOn: string } | null {
  if (v === null) return null;
  const at = v.indexOf(":");
  if (at < 0) return null;
  const rhythm = v.slice(0, at);
  const nextOn = v.slice(at + 1);
  return isRepeatRhythm(rhythm) && isIsoDate(nextOn) ? { rhythm, nextOn } : null;
}
