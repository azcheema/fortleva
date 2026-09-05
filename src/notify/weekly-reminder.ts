import { localDateString, startOfLocalDay } from "@/lib/duration";
import { addDays, weekContaining } from "@/lib/week";

import { isEmailLevel } from "./catalog";

/**
 * The 2T weekly self-reminder's PURE half (PLAN.md Phase 2T, delta D6).
 *
 * Everything here decides WHO gets a reminder and WHEN — the two things
 * that can send someone mail they did not ask for, or send it at the
 * wrong hour — and none of it touches the database. That is the point:
 * `src/jobs/weekly-reminders.ts` is then only queries, and these rules
 * are covered by unit tests rather than by a 30-second round trip to
 * Neon. (It is also what a test import needs: pulling `@/db` into the
 * unit suite fails at module load, with no DATABASE_URL there.)
 */

/**
 * The `NotificationPreference.perKind` key the reminder opts in under.
 * `perKind` is the model's own extension point — `{ "<kind>": {email,
 * inApp} }` — so an opt-in for one kind needs no column and no
 * migration. It is also the outbox TEMPLATE key for the mail itself.
 */
export const WEEKLY_REMINDER_KIND = "time.weekly_reminder";

/** `NotificationPreference.digestWeekday` is 1 = Monday; unset = Monday. */
export const DEFAULT_WEEKDAY = 1;
/** `digestHour` defaults to 8 in the schema; restated for an unset row. */
export const DEFAULT_HOUR = 8;

export type OptIn = { tenantId: string; memberId: string };

type PerKind = Record<string, { email?: boolean } | undefined>;

const optedIn = (raw: unknown): boolean =>
  raw !== null &&
  typeof raw === "object" &&
  !Array.isArray(raw) &&
  (raw as PerKind)[WEEKLY_REMINDER_KIND]?.email === true;

/** One preference row as the discovery query returns it. */
export type OptInCandidate = {
  tenantId: string;
  receiverId: string;
  perKind: unknown;
  emailLevel: string;
};

/**
 * Who is actually due a reminder, given every member preference row.
 */
export function selectOptIns(rows: readonly OptInCandidate[]): OptIn[] {
  return rows
    .filter((r) => optedIn(r.perKind))
    // `emailLevel: NONE` means no mail from Fortleva, full stop — it
    // outranks an opt-in the member may have ticked long ago. The
    // settings page says so under the switch.
    .filter((r) => !isEmailLevel(r.emailLevel) || r.emailLevel !== "NONE")
    .map((r): OptIn => ({ tenantId: r.tenantId, memberId: r.receiverId }));
}

/**
 * The instant this member's reminder becomes due, inside the ISO week
 * `now` falls in for THEM, plus the week it belongs to.
 *
 * The week is resolved from the member's LOCAL date, so someone in
 * Auckland and someone in Lisbon do not disagree about which week it is
 * for a few hours every Sunday. Returns null for a weekday outside 1-7
 * rather than clamping — a stored 0 or 9 is data this build did not
 * write, and guessing what it meant is worse than skipping a nudge.
 */
export function dueAt(
  now: Date,
  timeZone: string,
  weekday: number,
  hour: number,
): { at: Date; isoYear: number; isoWeek: number } | null {
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const today = localDateString(now, timeZone);
  const week = weekContaining(today, "MONDAY");
  const day = addDays(week.from, weekday - 1);
  // Local midnight of that day plus the hour. A DST shift *inside* that
  // day would move a late-evening reminder by an hour; a morning one is
  // never affected, and an hour of drift on a weekly nudge is not worth
  // a second zone conversion.
  const at = new Date(startOfLocalDay(day, timeZone).getTime() + hour * 3_600_000);
  return { at, isoYear: week.isoYear, isoWeek: week.isoWeek };
}
