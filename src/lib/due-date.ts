import { localDateString } from "./duration";
import { addDays, isIsoDate, weekContaining, type WeekStart } from "./week";

/**
 * The due-date picker's values, pure (no React, no directive).
 *
 * A picker value is an ID, never a resolved date: on a Sunday in a
 * Monday tenant "tomorrow" and "next week" are the same DAY but must
 * never be the same VALUE, or cmdk would light both rows up. The token
 * resolves only at commit, against the "today" the picker computed when
 * it opened.
 */

export const DUE_TOKENS = ["today", "tomorrow", "nextWeek"] as const;
export type DueToken = (typeof DUE_TOKENS)[number];

export const isDueToken = (v: string): v is DueToken => (DUE_TOKENS as readonly string[]).includes(v);

/** The member's calendar day in THEIR zone — never UTC, never the browser's. */
export const todayIn = (timeZone: string, now: Date = new Date()): string => localDateString(now, timeZone);

/**
 * today → today · tomorrow → +1 · nextWeek → the first day of the next
 * grid week under `weekStart`, always 1–7 days ahead (for a Monday
 * tenant that is `snooze.ts`'s next Monday).
 */
export function resolveDueToken(token: DueToken, today: string, weekStart: WeekStart): string {
  switch (token) {
    case "today":
      return today;
    case "tomorrow":
      return addDays(today, 1);
    case "nextWeek":
      return addDays(weekContaining(today, weekStart).from, 7);
  }
}

/** A typed date the server will accept (`isIsoDate`, 1970–2100), or null. */
export const parseDueQuery = (query: string): string | null => {
  const trimmed = query.trim();
  return isIsoDate(trimmed) ? trimmed : null;
};

/**
 * Picker value → ISO date | null (clear) | undefined (not a value; ignore).
 *
 * A token that resolves past the accepted range (only reachable on the
 * last days of 2100) is `undefined` too: it is not a date the server
 * would store, so the picker must not send it.
 */
export function dueChoiceToIso(choice: string, today: string, weekStart: WeekStart): string | null | undefined {
  if (choice === "none") return null;
  const iso = isDueToken(choice) ? resolveDueToken(choice, today, weekStart) : choice;
  return isIsoDate(iso) ? iso : undefined;
}
