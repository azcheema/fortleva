import { localDateString } from "@/lib/duration";
import { addDays, spanDays } from "@/lib/week";

/**
 * WHEN A PROGRESS UPDATE IS DUE (Phase 5 slice 102, founder decision C70;
 * PLAN Phase 5 "`ProjectUpdateSchedule` (cadence, owner, auto-draft
 * pre-fill, +1/+2 working-day reminders, 'update missing' badge)").
 *
 * PURE — no database import — so the rule is covered by unit tests and the
 * project page, the Updates tab and the reminder job all answer from the
 * same function. The inputs are the project's cadence and day, whether it
 * is ACTIVE, the moment that schedule was set (`project.update_schedule_since`,
 * which only a trigger writes — on a change of cadence or day, on becoming
 * ACTIVE, on the portal switching on), the newest COUNTING post's time and
 * the workspace's time zone.
 *
 * THE RULE, in the words the Updates tab says it:
 *   - the chosen day is Monday–Friday (C70 (b), Friday by default); weekly
 *     and fortnightly updates fall on that day, monthly ones on the FIRST
 *     such day of the month (C70 (c));
 *   - the next update is due on the first of those days that is at least a
 *     minimum gap after the last published one (4 days weekly, 11
 *     fortnightly, 20 monthly), and never on or before the day the
 *     schedule was set.
 *
 * WHY ANCHORED TO THE LAST POST rather than to fixed calendar slots: a late
 * update must not count twice, nor leave the next one due the day after
 * it. Weekly on Friday — posted Friday: next Friday; posted Thursday:
 * the Friday after (8 days, not 1); posted late on Monday: this Friday
 * (4 days). Changing the cadence or the day restarts the schedule from that
 * moment, which also clears "late": a new schedule is a new promise.
 *
 * WHICH POST COUNTS is the caller's read (`lastCountingPostAt`,
 * `update-reminders.ts`): a PUBLISHED one — never an archived or retracted
 * post, which was taken back — and, while the project's client portal is
 * ON, only one the client can see (C70 (g)): the schedule promises the
 * CLIENT updates.
 *
 * ONLY AN ACTIVE PROJECT HAS ONE. A planned, paused, completed, cancelled or
 * archived project shows no due day and is reminded of nothing; becoming
 * ACTIVE restamps `since`, so a project whose cadence was set while it was
 * being planned starts its schedule the day it starts (the design review's
 * high: it was otherwise "late" from day one, and too late to remind).
 *
 * A MISSED UPDATE IS REMINDED AGAIN ON EVERY DUE DAY after it (C70 (e)):
 * the due day stays where it was — "late since Friday 9 October" — while
 * each later scheduled day (`reminderSlotOn`) opens a new round of three.
 */

export type UpdateCadenceValue = "NONE" | "WEEKLY" | "BIWEEKLY" | "MONTHLY";

/** ISO weekdays an update may be due on: 1 = Monday … 5 = Friday. */
export const UPDATE_WEEKDAYS = [1, 2, 3, 4, 5] as const;
export type UpdateWeekday = (typeof UPDATE_WEEKDAYS)[number];
/** C70 (b): Friday. The column's default says the same. */
export const DEFAULT_UPDATE_WEEKDAY: UpdateWeekday = 5;

export const isUpdateWeekday = (v: unknown): v is UpdateWeekday =>
  typeof v === "number" && (UPDATE_WEEKDAYS as readonly number[]).includes(v);

/** The minimum days between the last post's day and the next due day. */
export const UPDATE_MIN_GAP_DAYS: Readonly<Record<Exclude<UpdateCadenceValue, "NONE">, number>> = {
  WEEKLY: 4,
  BIWEEKLY: 11,
  MONTHLY: 20,
};

/** The local hour (workspace time) from which a reminder may go out on its day… */
export const UPDATE_REMINDER_HOUR = 9;
/** …and the hour by which it must have: a run after it sends nothing that day (a 23:00 "due today" helps nobody). */
export const UPDATE_REMINDER_LAST_HOUR = 17;
/** Reminders on the due day (0) and one and two working days later. */
export const UPDATE_REMINDER_LAST_STEP = 2;

export type UpdateScheduleState = "scheduled" | "due" | "late";

export type UpdateScheduleInput = {
  readonly cadence: UpdateCadenceValue;
  /** ACTIVE and not archived — anything else has no schedule. */
  readonly active: boolean;
  readonly weekday: number;
  /** When the cadence or the day last changed; null exactly when the cadence is NONE. */
  readonly since: Date | null;
  /** The newest COUNTING post's `publishedAt` (see the header), or null before the first. */
  readonly lastPublishedAt: Date | null;
  readonly timeZone: string;
};

export type UpdateScheduleStatus = {
  /** `YYYY-MM-DD`, a day in the workspace's zone. */
  readonly dueOn: string;
  readonly state: UpdateScheduleState;
};

/** ISO weekday of a `YYYY-MM-DD` day: 1 = Monday … 7 = Sunday. */
export function isoWeekdayOf(isoDate: string): number {
  const d = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The first `weekday` of the month `YYYY-MM`. */
function firstWeekdayOfMonth(yearMonth: string, weekday: number): string {
  const first = `${yearMonth}-01`;
  return addDays(first, (weekday - isoWeekdayOf(first) + 7) % 7);
}

/** `YYYY-MM` of the month after the one `isoDate` is in. */
function nextMonthOf(isoDate: string): string {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** The first day on or after `floor` the cadence can fall on. */
export function firstDueDayOnOrAfter(
  cadence: Exclude<UpdateCadenceValue, "NONE">,
  weekday: UpdateWeekday,
  floor: string,
): string {
  if (cadence === "MONTHLY") {
    const thisMonth = firstWeekdayOfMonth(floor.slice(0, 7), weekday);
    return thisMonth >= floor ? thisMonth : firstWeekdayOfMonth(nextMonthOf(floor), weekday);
  }
  return addDays(floor, (weekday - isoWeekdayOf(floor) + 7) % 7);
}

/**
 * The day the next update is due, or null when the project has no schedule
 * (NONE, or a stored day this build did not write — guessing what a 0 or a
 * 6 meant is worse than not reminding).
 */
export function updateDueOn(input: UpdateScheduleInput): string | null {
  if (!input.active || input.cadence === "NONE" || input.since === null || !isUpdateWeekday(input.weekday)) {
    return null;
  }
  // ISO dates compare as strings.
  let floor = addDays(localDateString(input.since, input.timeZone), 1);
  if (input.lastPublishedAt) {
    const afterPost = addDays(localDateString(input.lastPublishedAt, input.timeZone), UPDATE_MIN_GAP_DAYS[input.cadence]);
    if (afterPost > floor) floor = afterPost;
  }
  return firstDueDayOnOrAfter(input.cadence, input.weekday, floor);
}

/** Where the project stands at `now`: the due day, and whether it is still ahead, today, or past. */
export function updateScheduleAt(input: UpdateScheduleInput, now: Date): UpdateScheduleStatus | null {
  const dueOn = updateDueOn(input);
  if (dueOn === null) return null;
  const today = localDateString(now, input.timeZone);
  return { dueOn, state: dueOn > today ? "scheduled" : dueOn === today ? "due" : "late" };
}

/**
 * The scheduled day whose round of reminders `today` belongs to, for an
 * update due on `dueOn` and still missing (C70 (e)): the latest day on or
 * before today that the cadence falls on, counting from the due day — every
 * 7 days weekly, every 14 fortnightly, the first chosen weekday of each
 * month monthly. Null before the due day.
 */
export function reminderSlotOn(
  cadence: Exclude<UpdateCadenceValue, "NONE">,
  weekday: UpdateWeekday,
  dueOn: string,
  today: string,
): string | null {
  if (today < dueOn) return null;
  if (cadence === "MONTHLY") {
    const thisMonth = firstWeekdayOfMonth(today.slice(0, 7), weekday);
    if (thisMonth <= today && thisMonth >= dueOn) return thisMonth;
    // Before this month's day: last month's (never before the due day).
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7));
    const previous = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    const lastMonth = firstWeekdayOfMonth(previous, weekday);
    return lastMonth >= dueOn ? lastMonth : dueOn;
  }
  const period = cadence === "WEEKLY" ? 7 : 14;
  const days = spanDays(dueOn, today) - 1;
  return addDays(dueOn, days - (days % period));
}

/**
 * Which reminder belongs to `today` for a round that began on `dueOn` (both
 * days in the workspace's zone): 0 on the due day itself, then the count of
 * WORKING days (Monday–Friday) after it — or null when today is not a
 * working day, is before the due day, or is past the last reminder. Each
 * reminder belongs to exactly one day, so a run that missed a day skips that
 * reminder rather than sending two at once.
 */
export function reminderStepOn(dueOn: string, today: string): number | null {
  if (today < dueOn) return null;
  if (isoWeekdayOf(today) > 5) return null;
  // Two working days after a weekday lie within four calendar days; past
  // that the answer is "none", so the walk below stays short however late
  // the update is (the caller passes the round's own day, `reminderSlotOn`).
  if (spanDays(dueOn, today) > 7) return null;
  let step = 0;
  for (let d = addDays(dueOn, 1); d <= today; d = addDays(d, 1)) {
    if (isoWeekdayOf(d) <= 5) step += 1;
  }
  return step <= UPDATE_REMINDER_LAST_STEP ? step : null;
}

/** The project columns the rule reads — one shape for the job and the page. */
export type ScheduledProject = {
  readonly status: string;
  readonly archivedAt: Date | null;
  readonly updateCadence: UpdateCadenceValue;
  readonly updateWeekday: number;
  readonly updateScheduleSince: Date | null;
};

/** The rule's input for a project, given its newest counting post and the workspace's zone. */
export const scheduleInputOf = (
  project: ScheduledProject,
  lastPublishedAt: Date | null,
  timeZone: string,
): UpdateScheduleInput => ({
  cadence: project.updateCadence,
  active: project.status === "ACTIVE" && project.archivedAt === null,
  weekday: project.updateWeekday,
  since: project.updateScheduleSince,
  lastPublishedAt,
  timeZone,
});
