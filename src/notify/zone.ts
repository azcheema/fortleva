/**
 * The time zone a member's own mail is timed in — their summary, their weekly
 * reminder, their quiet hours: the first zone Intl accepts of, most specific
 * first, the notification preference's own (`NotificationPreference.timezone`,
 * which nothing writes today), the member's (`/account`), the workspace's.
 * Callers pass the workspace's zone already resolved — `readPreferences` inside
 * a tenant transaction, `workspaceTimezoneOf` from a raw row — so it is never
 * missing; UTC is the last resort for a value this build did not write.
 *
 * A stored zone this build did not write must not throw a whole tenant's mail
 * away. (Moved here from `src/jobs/digests.ts` in slice 105, so the summary,
 * `notify.emit` and the outbox drain all read a member's day the same way.)
 */
export function usableZone(...candidates: (string | null | undefined)[]): string {
  for (const zone of candidates) {
    if (!zone) continue;
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: zone });
      return zone;
    } catch {
      // try the next
    }
  }
  return "UTC";
}
