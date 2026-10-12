/**
 * AN AGREEMENT'S RENEWAL DATES (Phase 4 slice 113; founder decision C88).
 * Pure — no database, no clock of its own — so the two judgements the
 * renewal job makes, "where does this date move on to" and (slice 113b)
 * "which days does this renewal bill", are pinned by a unit test
 * (`renewal-dates.test.ts`).
 *
 * Days are `YYYY-MM-DD` throughout, as `reminder-bands.ts`: an agreement's
 * `renews_at` is written as UTC midnight by every form, so its UTC day is
 * the agreement's day, and the tenant's today is the caller's.
 *
 * A MONTH-END RENEWAL KEEPS ITS DAY. Every step counts whole months from the
 * date it starts at and lands on the ANCHOR day — the day the agreement
 * renews on (`service.renewal_day`, or the day of its date when that is
 * NULL) — or on that month's last day when the month is shorter: an
 * agreement renewing on the 31st renews on 28 February and on 31 March
 * again, never drifting to the 28th for good.
 */

export type RenewalInterval = "MONTHLY" | "QUARTERLY" | "YEARLY";

const MONTHS: Record<RenewalInterval, number> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };

/**
 * The most steps one move may take: fifty years of months. A date further
 * behind than that is a typo nobody should be billed by — the move refuses
 * it rather than looping.
 */
export const MAX_RENEWAL_STEPS = 600;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Year, month (1–12) and day of a real `YYYY-MM-DD`, or null (a rolled-over `02-30` included). */
function partsOf(day: string): { y: number; m: number; d: number } | null {
  const match = typeof day === "string" ? DAY.exec(day) : null;
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/** The number of days in month `m` (1–12) of year `y`. */
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** True for a whole anchor day of a month (1–31). */
export const isAnchorDay = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 31;

/** The anchor an agreement renews on: its stored `renewal_day`, else the day of its date. Null for a malformed day. */
export function anchorOf(day: string, renewalDay: number | null): number | null {
  const p = partsOf(day);
  if (!p) return null;
  return renewalDay !== null && isAnchorDay(renewalDay) ? renewalDay : p.d;
}

/**
 * `steps` intervals after `day`'s month, on `anchorDay` or that month's last
 * day. Null for a malformed day, a bad anchor or a negative step count.
 */
export function addIntervals(day: string, interval: RenewalInterval, steps: number, anchorDay: number): string | null {
  const p = partsOf(day);
  if (!p || !isAnchorDay(anchorDay) || !Number.isInteger(steps) || steps < 0) return null;
  const months = p.y * 12 + (p.m - 1) + steps * MONTHS[interval];
  const y = Math.floor(months / 12);
  const m = (months % 12) + 1;
  if (y > 9999) return null;
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(Math.min(anchorDay, daysInMonth(y, m)), 2)}`;
}

/**
 * Where a renewal date that has PASSED moves on to: the first renewal
 * strictly after `today` reached from `current` in whole intervals. Null
 * when `current` is not before `today` (nothing to move — a date due today
 * stays, so Renewals can still say "renews today"), for a malformed day or
 * anchor, or when it would take more than `MAX_RENEWAL_STEPS`.
 */
export function nextRenewal(
  current: string,
  today: string,
  interval: RenewalInterval,
  anchorDay: number,
): { readonly next: string; readonly steps: number } | null {
  if (!partsOf(current) || !partsOf(today) || !isAnchorDay(anchorDay)) return null;
  if (!(current < today)) return null;
  for (let steps = 1; steps <= MAX_RENEWAL_STEPS; steps++) {
    const next = addIntervals(current, interval, steps, anchorDay);
    if (next === null) return null;
    if (next > today) return { next, steps };
  }
  return null;
}

/** `day` moved by `days` whole days (UTC). */
function shiftDays(day: string, days: number): string {
  const p = partsOf(day)!;
  return new Date(Date.UTC(p.y, p.m - 1, p.d + days)).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`, both included (`a` ≤ `b`). */
export function daysCovered(a: string, b: string): number {
  const pa = partsOf(a);
  const pb = partsOf(b);
  if (!pa || !pb) return Number.NaN;
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000) + 1;
}

/**
 * The days one renewal bills (slice 113b; C88 (b)): from the renewal day to
 * the day before the next renewal. Null for a malformed day or anchor.
 */
export function periodOf(start: string, interval: RenewalInterval, anchorDay: number): { readonly start: string; readonly end: string } | null {
  const next = addIntervals(start, interval, 1, anchorDay);
  if (next === null) return null;
  return { start, end: shiftDays(next, -1) };
}
