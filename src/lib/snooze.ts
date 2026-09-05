/**
 * The inbox's snooze presets (UI.md §6, `inbox` scope `S`).
 *
 * WHY THE ARITHMETIC IS ON THE CLIENT and this module is therefore
 * environment-free: "tomorrow morning" is a question about the member's
 * own wall clock, and `Member.timezone` is an optional column that is
 * routinely empty — a server-side preset would quietly park the row at
 * the wrong morning for anyone who has not filled it in. The browser
 * already knows the answer, so it computes the instant and the service
 * validates it (future, and inside a 90-day horizon).
 *
 * MORNING IS 09:00 LOCAL, and it is this module's promise rather than a
 * setting: it is what the label "tomorrow morning" says, and it is not
 * `NotificationPreference.digestHour` — that one is when the member
 * asked to be *mailed* a summary, a different question with a different
 * answer. Deriving one from the other would make changing the digest
 * hour silently move every future snooze.
 */

export const SNOOZE_PRESETS = ["inThreeHours", "tomorrow", "nextWeek"] as const;

export type SnoozePreset = (typeof SNOOZE_PRESETS)[number];

const MORNING_HOUR = 9;

/** Local midnight `days` after the day `from` falls on, at MORNING_HOUR.
 * Built through the Date constructor rather than by adding milliseconds,
 * so a DST boundary inside the span still lands on 09:00 local. */
const morningAfter = (from: Date, days: number): Date => {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days, MORNING_HOUR, 0, 0, 0);
  return d;
};

/**
 * The instant a preset means, relative to `now` in the LOCAL zone.
 * Every result is strictly after `now` — the service refuses a snooze
 * that is not, and "next Monday" on a Monday at 07:00 must not resolve
 * to two hours from now and call itself a week.
 */
export function snoozeUntil(preset: SnoozePreset, now: Date): Date {
  switch (preset) {
    case "inThreeHours":
      return new Date(now.getTime() + 3 * 60 * 60 * 1000);
    case "tomorrow":
      return morningAfter(now, 1);
    case "nextWeek": {
      // getDay(): 0 = Sunday. The next Monday is always 1-7 days ahead,
      // never today: a Monday snoozed "to next week" means the next one.
      const daysToMonday = ((8 - now.getDay()) % 7) || 7;
      return morningAfter(now, daysToMonday);
    }
  }
}
