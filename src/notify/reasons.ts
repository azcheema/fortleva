/**
 * WHY A NOTIFICATION REACHED THIS PERSON (Phase 5 slice 104, founder decision
 * C72 (d)) — the small tag beside a row in `/inbox`: "Assigned to you",
 * "Your project", … Stored on the row by `notify.emit` from now on
 * (`notification.reason`); older rows, and rows for a client's contact, have
 * none and show none.
 *
 * A CLOSED SET, held by the database too (the migration's CHECK): a new reason
 * — mentions, when they arrive (C44) — is a migration that widens it. The ORDER
 * is the precedence: someone who qualifies twice (an owner who is also assigned
 * to the client) is tagged with the more specific reason, the earlier one here.
 */
export const NOTIFICATION_REASONS = [
  /** The task is theirs (assigned, or a comment on a task assigned to them). */
  "ASSIGNEE",
  /** They asked for the thing that answered (a login asked of a client). */
  "REQUESTER",
  /** They lead the project the notification is about. */
  "PROJECT_LEAD",
  /** They are assigned to that project. */
  "PROJECT_MEMBER",
  /** They are assigned to that client. */
  "CLIENT_MEMBER",
  /** They are on the budget's own alert list. */
  "BUDGET_WATCHER",
  /**
   * They can open the logins the notification counts — the expiring-logins
   * reminder goes to everyone the vault lets see them (`credential:view` and
   * the reach), owners and tenant-wide admins included, so no narrower reason
   * is true for all of them (the design review's high).
   */
  "VAULT_ACCESS",
  /** They own the workspace (the owners hear some things always). */
  "OWNER",
] as const;

export type NotificationReason = (typeof NOTIFICATION_REASONS)[number];

export const isNotificationReason = (v: unknown): v is NotificationReason =>
  typeof v === "string" && (NOTIFICATION_REASONS as readonly string[]).includes(v);

/** The more specific of two reasons (the earlier in `NOTIFICATION_REASONS`). */
export const pickReason = (a: NotificationReason, b: NotificationReason): NotificationReason =>
  NOTIFICATION_REASONS.indexOf(a) <= NOTIFICATION_REASONS.indexOf(b) ? a : b;

/**
 * One reason per member from several receiver groups — each member tagged with
 * the most specific reason they qualify for, whatever order the groups come in.
 */
export function reasonsFor(
  groups: Iterable<readonly [NotificationReason, Iterable<string>]>,
): Map<string, NotificationReason> {
  const out = new Map<string, NotificationReason>();
  for (const [reason, memberIds] of groups) {
    for (const id of memberIds) {
      const had = out.get(id);
      out.set(id, had === undefined ? reason : pickReason(had, reason));
    }
  }
  return out;
}
