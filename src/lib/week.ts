/**
 * Calendar-week arithmetic on ISO date strings (no Date objects cross a
 * zone boundary here — every input is already the member's local date).
 * The grid starts on the tenant's `ui.weekStart`; the label is the ISO
 * week of the grid's Thursday-side, so a Sunday-start grid still reads
 * as the ISO week most of its days fall in (UI.md §8).
 */
export type WeekStart = "MONDAY" | "SUNDAY" | "SATURDAY";

const DAY_MS = 86_400_000;
const WEEK_START_INDEX: Record<WeekStart, number> = { MONDAY: 1, SUNDAY: 0, SATURDAY: 6 };

const utc = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);
const iso = (d: Date): string => d.toISOString().slice(0, 10);

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (s: string | null | undefined): s is string =>
  typeof s === "string" && ISO_DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export const addDays = (isoDate: string, days: number): string => iso(new Date(utc(isoDate).getTime() + days * DAY_MS));

/** Every date from `from` to `to` inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** ISO-8601 week number + ISO year of a date. */
export function isoWeekOf(isoDate: string): { year: number; week: number } {
  const d = utc(isoDate);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

export type WeekRange = { from: string; to: string; days: string[]; isoYear: number; isoWeek: number };

/** The grid week containing `isoDate`, starting on `weekStart`. */
export function weekContaining(isoDate: string, weekStart: WeekStart): WeekRange {
  const d = utc(isoDate);
  const offset = (d.getUTCDay() - WEEK_START_INDEX[weekStart] + 7) % 7;
  const from = addDays(isoDate, -offset);
  const to = addDays(from, 6);
  const { year, week } = isoWeekOf(addDays(from, 3));
  return { from, to, days: daysBetween(from, to), isoYear: year, isoWeek: week };
}

/** The month containing a date as an inclusive range. */
export function monthContaining(isoDate: string): { from: string; to: string } {
  const [y, m] = isoDate.split("-").map(Number) as [number, number];
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const to = iso(new Date(Date.UTC(y, m, 0)));
  return { from, to };
}
