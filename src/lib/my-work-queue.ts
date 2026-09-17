import { addDays } from "./week";

/**
 * `/home`'s queue groups (UI.md rule 8: "assigned (overdue / today /
 * next 7 d)"), as pure arithmetic on ISO dates — the member's `today`
 * comes from their server-resolved zone (UI.md §8), never the browser's,
 * and a task's due date is a `@db.Date`, a calendar day with no zone.
 *
 * FOUR GROUPS, NOT THREE. The rule names three, but a queue of those
 * alone hides every assigned task with no due date or a later one — and
 * most tasks carry no date — so a member with a dozen tasks in progress
 * would be told they have nothing to do. `later` holds the rest, dated
 * first (soonest first), then undated, in the order the read returned.
 */
const QUEUE_GROUPS = ["overdue", "today", "soon", "later"] as const;
export type QueueGroup = (typeof QUEUE_GROUPS)[number];

/** "Next 7 days" = tomorrow through today + 7, inclusive. */
const SOON_DAYS = 7;

export function queueGroupOf(targetDate: string | null, today: string): QueueGroup {
  if (targetDate === null) return "later";
  if (targetDate < today) return "overdue";
  if (targetDate === today) return "today";
  return targetDate <= addDays(today, SOON_DAYS) ? "soon" : "later";
}

/**
 * The non-empty groups in their fixed order, each keeping its rows in the
 * order they arrived (the read sorts: soonest due, then priority).
 * `targetDate` is the row's ISO day or `null`.
 */
export function groupQueue<T extends { targetDate: string | null }>(
  rows: readonly T[],
  today: string,
): { group: QueueGroup; rows: T[] }[] {
  const by = new Map<QueueGroup, T[]>();
  for (const row of rows) {
    const group = queueGroupOf(row.targetDate, today);
    const list = by.get(group);
    if (list) list.push(row);
    else by.set(group, [row]);
  }
  return QUEUE_GROUPS.flatMap((group) => {
    const list = by.get(group);
    return list ? [{ group, rows: list }] : [];
  });
}
