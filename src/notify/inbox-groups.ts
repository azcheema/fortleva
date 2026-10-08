import { localDateString } from "@/lib/duration";
import { addDays, weekContaining, type WeekStart } from "@/lib/week";

/**
 * THE INBOX'S DAY GROUPS (Phase 5 slice 104, founder decision C72 (c)) —
 * Today, Yesterday, This week, Older: the headings `/inbox` draws over its
 * rows, decided on the SERVER for each row and handed to the list as data, so
 * the browser never recomputes a calendar day in a zone it may not share (the
 * process-zone hydration trap — `formatDate` in a client tree once rendered a
 * different day on the server than in the browser).
 *
 * Calendar days in the MEMBER's zone (`resolveTimeZone`: their own, else the
 * workspace's), so a notification at 00:30 is "today" in Stockholm whatever
 * UTC says; "this week" is the rest of the current week by the WORKSPACE's
 * week start (`ui.weekStart`), the week the product shows everywhere else.
 * Yesterday wins over "this week" (it is the more specific heading), and on
 * the first day of a week "this week" holds only today and yesterday's
 * neighbours already taken — it is then simply empty.
 */
export const INBOX_GROUPS = ["today", "yesterday", "week", "older"] as const;
export type InboxGroup = (typeof INBOX_GROUPS)[number];

export function inboxGroupOf(createdAt: Date, now: Date, timeZone: string, weekStart: WeekStart): InboxGroup {
  const day = localDateString(createdAt, timeZone);
  const today = localDateString(now, timeZone);
  if (day >= today) return "today"; // a stamp a moment ahead of the clock is still today
  if (day === addDays(today, -1)) return "yesterday";
  if (day >= weekContaining(today, weekStart).from) return "week";
  return "older";
}
