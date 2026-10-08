import { localDateString, localHourInstant, startOfLocalDay, zoneOffsetMinutes } from "@/lib/duration";
import { addDays } from "@/lib/week";

/**
 * QUIET HOURS (Phase 5 slice 105, founder decision C73 (e), (f)): the hours of
 * a member's own day — and, if they tick it, the whole weekend — in which
 * Fortleva sends them no email about work. Pure: no database, no clock of its
 * own, so the enqueue (`notify.emit`), the drain (`src/jobs/outbox.ts`) and the
 * settings save all ask the same question of the same rule.
 *
 * The hours are WHOLE LOCAL HOURS, `from` inclusive and `to` exclusive, read on
 * the member's wall clock: 19 → 7 is quiet from 19:00 to 07:00 the next
 * morning, 12 → 14 is a quiet lunch. `from === to` is not a setting (the
 * column's CHECK refuses it), and either both are set or neither. The weekend
 * is Saturday and Sunday on the same wall clock, midnight to midnight.
 */
export type QuietHours = {
  readonly from: number | null;
  readonly to: number | null;
  readonly weekends: boolean;
};

export const NO_QUIET_HOURS: QuietHours = { from: null, to: null, weekends: false };

/** What a member gets when they switch quiet hours on without choosing hours. */
export const DEFAULT_QUIET_FROM = 19;
export const DEFAULT_QUIET_TO = 7;

export const isQuietHour = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23;

/**
 * A stored pair this build would write: both hours in range and different.
 * Anything else — half a pair, an hour out of range, from = to — reads as no
 * hours at all rather than a guess (the CHECK makes it unreachable; a reader
 * must still not trust a column it did not write).
 */
export function quietHoursOf(row: {
  readonly quietHoursFrom: number | null | undefined;
  readonly quietHoursTo: number | null | undefined;
  readonly quietWeekends: boolean | null | undefined;
} | null | undefined): QuietHours {
  const from = row?.quietHoursFrom;
  const to = row?.quietHoursTo;
  const hours = isQuietHour(from) && isQuietHour(to) && from !== to;
  return { from: hours ? from : null, to: hours ? to : null, weekends: row?.quietWeekends === true };
}

/** Does this member have any quiet time at all? */
export const hasQuietTime = (q: QuietHours): boolean => q.weekends || (q.from !== null && q.to !== null);

/** The wall-clock hour (0–23) of an instant in a zone — offsets of any size, DST included. */
export function localHour(instant: Date, timeZone: string): number {
  const shifted = new Date(instant.getTime() + zoneOffsetMinutes(instant, timeZone) * 60_000);
  return shifted.getUTCHours();
}

/** Saturday or Sunday on the wall clock. */
function isLocalWeekend(instant: Date, timeZone: string): boolean {
  const day = new Date(`${localDateString(instant, timeZone)}T00:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** Is the hour `h` inside the nightly (or daytime) window? */
function insideHours(h: number, q: QuietHours): boolean {
  if (q.from === null || q.to === null) return false;
  return q.from < q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to;
}

export function isQuietAt(instant: Date, q: QuietHours, timeZone: string): boolean {
  if (q.weekends && isLocalWeekend(instant, timeZone)) return true;
  return insideHours(localHour(instant, timeZone), q);
}

/**
 * How many local days ahead the release is looked for. A quiet stretch can
 * last at most from Friday evening to Monday morning (weekend + nights), so
 * four days already suffice; nine leaves room for any reading of a week.
 */
const SEARCH_DAYS = 9;

/**
 * When does quiet time that holds at `instant` end? `null` when `instant` is
 * not quiet — the mail may go now.
 *
 * Quiet time can only end at one of two kinds of moment: a local midnight (the
 * weekend ends at Monday 00:00) or the `to` hour. So the candidates are those
 * moments over the next few local days, in order, and the release is the
 * first one that is not itself quiet — Saturday 10:00 with nights 19 → 7 and
 * the weekend ticked: Sunday 00:00 (weekend), Sunday 07:00 (weekend), Monday
 * 00:00 (night), Monday 07:00 — released. Both kinds are resolved on the wall
 * clock (`startOfLocalDay`, `localHourInstant`), so a clock change moves them
 * with the member's day; a `to` hour that does not exist that day (inside a
 * spring-forward gap) resolves an hour later, as the summary's hour does.
 */
export function quietRelease(instant: Date, q: QuietHours, timeZone: string): Date | null {
  if (!isQuietAt(instant, q, timeZone)) return null;
  const today = localDateString(instant, timeZone);
  const candidates: Date[] = [];
  for (let d = 0; d <= SEARCH_DAYS; d += 1) {
    const day = addDays(today, d);
    candidates.push(startOfLocalDay(day, timeZone));
    if (q.to !== null) candidates.push(localHourInstant(day, q.to, timeZone));
  }
  candidates.sort((a, b) => a.getTime() - b.getTime());
  for (const c of candidates) {
    if (c.getTime() > instant.getTime() && !isQuietAt(c, q, timeZone)) return c;
  }
  // Unreachable while `from !== to` (every weekday has hours outside the
  // window): a day later, never "now", so a misread setting holds rather
  // than sends.
  return new Date(instant.getTime() + 24 * 3_600_000);
}

/**
 * Does the member's own summary email fall inside their quiet time? It still
 * goes at the hour they chose (C73's "settled with it": a mail they scheduled
 * themselves is not work mail), and the settings page says so rather than let
 * it look like a mistake: its hour inside the window, or a weekly one on a
 * Saturday or Sunday with the weekend ticked. `weekday`: 1 = Monday … 7 = Sunday.
 */
export function summaryInQuietTime(q: QuietHours, cadence: string, hour: number, weekday: number): boolean {
  if (cadence === "NONE") return false;
  if (insideHours(hour, q)) return true;
  return cadence === "WEEKLY" && q.weekends && (weekday === 6 || weekday === 7);
}
