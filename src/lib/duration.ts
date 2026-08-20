/**
 * Pure time arithmetic shared by the time module, its server actions
 * and its client components (no database import). Three concerns:
 *
 *  1. Whole-second instants. Every timestamp the time module writes is
 *     truncated to the second, and a duration is floor(stop − start) in
 *     seconds — the `*_duration_exact` CHECKs in the 2T migration pin
 *     exactly that arithmetic, so the app and the database can never
 *     disagree by a rounding mode.
 *  2. Local dates. `TimeEntry.localDate` / `Shift.localDate` is the
 *     calendar date of the START instant in the row's IANA zone (UI.md
 *     rule 9: a midnight-spanning entry stays ONE row, attributed to
 *     its start date). Computed from Intl parts — never from wall-clock
 *     subtraction, which breaks across DST (PLAN.md 2T risk 3).
 *  3. Duration text. `1h 30m` / `90m` / `1,5` / `1:30` → seconds for
 *     manual entries (UI.md rule 9); a bare number is HOURS.
 */

export const SECOND_MS = 1000;

/** Truncate an instant to whole seconds (the only precision we store). */
export const floorToSecond = (d: Date): Date => new Date(Math.floor(d.getTime() / SECOND_MS) * SECOND_MS);

/** Whole seconds between two instants (floor), never negative. */
export const secondsBetween = (start: Date, stop: Date): number =>
  Math.max(0, Math.floor((floorToSecond(stop).getTime() - floorToSecond(start).getTime()) / SECOND_MS));

export const addSeconds = (d: Date, seconds: number): Date => new Date(d.getTime() + seconds * SECOND_MS);
export const addHours = (d: Date, hours: number): Date => addSeconds(d, Math.round(hours * 3600));

/** ISO calendar date ("YYYY-MM-DD") of an instant in an IANA zone. */
export function localDateString(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** A `@db.Date` column value for an ISO date: UTC midnight of that date. */
export const dateColumn = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);

/** Back from a `@db.Date` value (UTC midnight) to its ISO date. */
export const isoDateOf = (dateColumnValue: Date): string => dateColumnValue.toISOString().slice(0, 10);

/** The `localDate` column value for an instant in a zone. */
export const localDateColumn = (instant: Date, timeZone: string): Date =>
  dateColumn(localDateString(instant, timeZone));

/** First day of the month of an ISO date (the ProjectTimeSummary key). */
export const monthStartOf = (isoDate: string): string => `${isoDate.slice(0, 7)}-01`;

/**
 * The instant at which a local calendar date starts (00:00) in a zone.
 * Used to anchor duration-only entries; resolved by probing the zone's
 * offset at that date (DST-safe, no library).
 */
export function startOfLocalDay(isoDate: string, timeZone: string): Date {
  // Guess UTC midnight, then correct by the zone's offset at that instant
  // (one more pass handles a DST transition at midnight itself).
  let guess = new Date(`${isoDate}T00:00:00.000Z`);
  for (let i = 0; i < 2; i += 1) {
    const offsetMinutes = zoneOffsetMinutes(guess, timeZone);
    const corrected = new Date(Date.parse(`${isoDate}T00:00:00.000Z`) - offsetMinutes * 60_000);
    if (corrected.getTime() === guess.getTime()) break;
    guess = corrected;
  }
  return guess;
}

/** Offset of a zone at an instant, in minutes east of UTC. */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - floorToSecond(instant).getTime()) / 60_000);
}

export const MAX_ENTRY_SECONDS = 24 * 3600;

/**
 * Duration text → seconds, or null when unparseable / non-positive /
 * over 24 h. Accepted: `1h 30m`, `1h30m`, `1 h 30 min`, `2h`, `90m`,
 * `45 min`, `1:30` (h:mm), `1,5` / `1.5` / `2` (HOURS — decimal comma
 * or point). Whole minutes only (seconds are dropped) so what the
 * member typed is what the grid shows.
 */
export function parseDurationSeconds(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (s === "") return null;
  let seconds: number | null = null;

  const clock = /^(\d{1,2}):([0-5]\d)$/.exec(s);
  if (clock) {
    seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60;
  } else {
    const hm = /^(?:(\d+(?:[.,]\d+)?) ?(?:h|hours?|tim(?:mar|me)?))? ?(?:(\d+) ?(?:m|min|minutes?|minuter))?$/.exec(s);
    if (hm && (hm[1] !== undefined || hm[2] !== undefined)) {
      const hours = hm[1] !== undefined ? Number(hm[1].replace(",", ".")) : 0;
      const minutes = hm[2] !== undefined ? Number(hm[2]) : 0;
      seconds = Math.round(hours * 3600) + minutes * 60;
    } else {
      const bare = /^(\d+(?:[.,]\d+)?)$/.exec(s);
      if (bare) seconds = Math.round(Number(bare[1]!.replace(",", ".")) * 3600);
    }
  }
  if (seconds === null || !Number.isFinite(seconds)) return null;
  seconds = Math.floor(seconds / 60) * 60;
  if (seconds <= 0 || seconds > MAX_ENTRY_SECONDS) return null;
  return seconds;
}

/** Two half-open intervals intersect (a running interval is open-ended). */
export const intervalsOverlap = (
  aStart: Date,
  aStop: Date | null,
  bStart: Date,
  bStop: Date | null,
): boolean => {
  const aEnd = aStop?.getTime() ?? Number.POSITIVE_INFINITY;
  const bEnd = bStop?.getTime() ?? Number.POSITIVE_INFINITY;
  return aStart.getTime() < bEnd && bStart.getTime() < aEnd;
};
