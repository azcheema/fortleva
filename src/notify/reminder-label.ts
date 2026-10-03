import type { NotificationKind } from "./catalog";

/**
 * Which `inbox.reminder.*` message draws a renewal reminder's row, with its
 * numbers (Phase 3V slice 89) — "Due for renewal within 14 days", "2 logins
 * expire within 7 days". One function for `/inbox` and Home's inbox card,
 * so the two can never word the same row differently. Null for every other
 * kind, and for a reminder without its numbers (`InboxRow.reminder` is null
 * when the member may no longer see the subject): the row then takes its
 * kind's generic label, `inbox.kind.*`.
 */
export type ReminderLabel =
  | { readonly key: "assetDue" | "agreementEnding"; readonly days: number }
  | { readonly key: "loginsExpiring"; readonly days: number; readonly count: number };

// The `t(…)` call itself stays in each component: next-intl's typed
// translator from `useTranslations` (client) and `getTranslations` (server)
// cannot be passed through one helper without widening its keys to
// `string`, which would lose the check that every key exists.
export function reminderLabel(
  kind: NotificationKind | null,
  reminder: { readonly days: number; readonly count: number | null } | null,
): ReminderLabel | null {
  if (reminder === null) return null;
  switch (kind) {
    case "expiration.asset_due":
      return { key: "assetDue", days: reminder.days };
    case "expiration.agreement_ending":
      return { key: "agreementEnding", days: reminder.days };
    case "expiration.logins_expiring":
      return reminder.count === null ? null : { key: "loginsExpiring", days: reminder.days, count: reminder.count };
    default:
      return null;
  }
}
