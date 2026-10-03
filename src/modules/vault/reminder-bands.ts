/**
 * THE REMINDER BANDS (Phase 3V slice 89; PLAN Phase 3V "reminders at
 * 60/30/14/7/1 days"). Pure — no database, no clock of its own — so the
 * job's one judgement, "which reminder is due today, if any", is pinned by
 * a unit test (`reminder-bands.test.ts`).
 *
 * ONE REMINDER PER BAND, AND ONLY THE SMALLEST BAND THE DATE HAS ENTERED.
 * A date 10 days out has entered the 60-, 30- and 14-day bands; the 14-day
 * reminder is the one due. An asset added 10 days before its renewal is
 * told once, at 14, and never gets the 60- and 30-day reminders after the
 * fact; a job that missed a day still sends the band it skipped into. The
 * dedupe table says whether that band already went (`reminders.ts`).
 *
 * A DATE THAT HAS PASSED SENDS NOTHING: a lapsed domain is the Renewals
 * page's business ("Past their date"), and "expires within 1 day" about
 * something that expired last week would be false. A date due TODAY is
 * inside the 1-day band.
 */

/** The bands, smallest first — the order `bandFor` relies on. */
export const REMINDER_BANDS = [1, 7, 14, 30, 60] as const;

export type ReminderBand = (typeof REMINDER_BANDS)[number];

/** The furthest a reminder looks ahead, in days. */
export const REMINDER_HORIZON_DAYS = REMINDER_BANDS[4];

export const isReminderBand = (n: unknown): n is ReminderBand =>
  typeof n === "number" && (REMINDER_BANDS as readonly number[]).includes(n);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Midnight UTC of a real `YYYY-MM-DD`, or NaN (a rolled-over `02-30` included). */
export function dayStart(day: string): number {
  if (typeof day !== "string" || !DAY.test(day)) return Number.NaN;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== day ? Number.NaN : t;
}

/** The UTC day of an instant, `YYYY-MM-DD` — the feed's `dayOf`. */
export const utcDayOf = (d: Date): string => d.toISOString().slice(0, 10);

/** `day` moved by `days` whole days. */
export const addDays = (day: string, days: number): string =>
  new Date(dayStart(day) + days * 86_400_000).toISOString().slice(0, 10);

/** Whole days from `today` to `due` (negative once `due` has passed); NaN for a malformed day. */
export function daysUntil(today: string, due: string): number {
  return Math.round((dayStart(due) - dayStart(today)) / 86_400_000);
}

/**
 * The expiry INSTANTS a login told in a reminder decided on `from` (the
 * tenant's day) in `band` could have had: the job reminds about a login
 * whose UTC expiry day is 0..band days after `from`, so its expiry lies in
 * [from 00:00Z, from + band + 1 00:00Z), as epoch milliseconds. Null for a
 * day that is not a real one. The inbox counts a login reminder's logins
 * by this (`reminder-subjects.ts`); `reminder-bands.test.ts` probes both
 * edges against `bandFor`.
 */
export function loginWindowOf(from: string, band: number): { start: number; end: number } | null {
  const start = dayStart(from);
  if (Number.isNaN(start) || !isReminderBand(band)) return null;
  return { start, end: start + (band + 1) * 86_400_000 };
}

/**
 * The band whose reminder is due when `daysLeft` days remain: the smallest
 * band at least `daysLeft` — or null when the date has passed, is further
 * out than the horizon, or is not a whole number of days.
 */
export function bandFor(daysLeft: number): ReminderBand | null {
  if (!Number.isInteger(daysLeft) || daysLeft < 0) return null;
  for (const band of REMINDER_BANDS) if (daysLeft <= band) return band;
  return null;
}
