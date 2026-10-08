/**
 * DOES A ROW STILL BELONG IN THE TAB IT IS SHOWN IN? (Phase 5 slice 104; the
 * design review's medium) — the browser's twin of `filterWhere` in
 * `src/notify/inbox.ts`, so an optimistic change takes a row out of exactly
 * the tabs the server would no longer return it in, and the keyboard's focus
 * can move to the next row BEFORE the row is gone (never to <body>):
 *
 * | tab | holds |
 * |---|---|
 * | unread | not read, not archived, not snoozed into the future |
 * | all | not archived (a snoozed row stays) |
 * | snoozed | not archived, snoozed into the future |
 * | archived | archived |
 *
 * Pure and dependency-free: the client list imports it, and
 * `reasons.test.ts`-style unit tests hold it to the server's table.
 */
export type BucketRow = { readonly read: boolean; readonly archived: boolean; readonly snoozedTill: string | null };

export type InboxBucket = "unread" | "all" | "snoozed" | "archived";

export function staysInBucket(bucket: InboxBucket, row: BucketRow, nowMs: number): boolean {
  const snoozedAhead = row.snoozedTill !== null && Date.parse(row.snoozedTill) > nowMs;
  switch (bucket) {
    case "unread":
      return !row.read && !row.archived && !snoozedAhead;
    case "all":
      return !row.archived;
    case "snoozed":
      return !row.archived && snoozedAhead;
    case "archived":
      return row.archived;
  }
}
