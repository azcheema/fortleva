import { NOTIFICATION_KINDS, emailAllowed, isNotificationKind, type EmailLevelValue, type NotificationKind } from "./catalog";
import { DIGEST_SENDING_TENANT_STATUSES } from "./digest";
import { quietRelease, type QuietHours } from "./quiet-hours";

/**
 * WORK EMAIL AT SEND (Phase 5 slice 105; founder decision C73). A work email
 * is one `notify.emit` enqueued for a member — a catalog kind with an `email`
 * block (src/notify/catalog.ts): an assignment, a mention, a client's request
 * or comment or sign-off, a renewal reminder, a login handed over, an update
 * due. Nothing else Fortleva mails is one: security notices, codes, resets,
 * invitations, summaries and the weekly self-reminder go under their own
 * template keys, never held (C73's "settled with it").
 *
 * Quiet hours can hold such a mail from a Friday evening to a Monday morning,
 * so what was true at enqueue may not be at send. The drain asks this, per
 * row, with what it read once for the whole claim (`src/jobs/outbox.ts`):
 *
 *   1. Is it still WANTED? The member still active, their workspace still
 *      sending (`DIGEST_SENDING_TENANT_STATUSES` — the summary's rule), their
 *      email level still letting this kind through (the setting at SEND
 *      decides: someone who chose "Nothing" at 23:00 is not mailed at 07:00),
 *      and their address still the one it was made for (the security review's
 *      nit — the clients' summary checks the same).
 *   2. Is it quiet for them NOW? Then it waits again, until the quiet ends —
 *      a drain a few minutes into the night, a failed send's retry landing in
 *      it, hours changed since enqueue.
 *   3. Was it held, and has everything behind it been SEEN in the inbox —
 *      read, archived, or snoozed for later (C73 (e), (h))? Then it is not
 *      sent: the email only ever pointed at the inbox.
 *   4. Was it a held "update due" reminder that a NEWER reminder for the same
 *      project, or a post that counts, has overtaken? It says the update is
 *      still missing, and the job sends the next one itself. (Not "the day
 *      changed": a member far from the workspace's zone whose quiet hours end
 *      after the workspace's midnight would then never get one — the code
 *      review's L4.)
 */

export const isWorkMail = (kind: string): kind is NotificationKind =>
  isNotificationKind(kind) && NOTIFICATION_KINDS[kind].email !== undefined;

/** Why a work email was dropped at send — its outbox row's `lastError`. */
export const WORK_MAIL_SKIPPED = {
  unwanted: "work mail no longer wanted",
  seen: "seen in the inbox while held",
  overtaken: "reminder overtaken while held",
} as const;

export type WorkMailReceiver = {
  readonly memberStatus: string;
  readonly tenantStatus: string;
  readonly emailLevel: EmailLevelValue;
  readonly quiet: QuietHours;
  /** The member's own zone (`usableZone`). */
  readonly zone: string;
  /** The member's address NOW, lower-cased. */
  readonly email: string;
};

export type WorkMailVerdict =
  | { readonly action: "send" }
  | { readonly action: "hold"; readonly until: Date }
  | { readonly action: "skip"; readonly why: (typeof WORK_MAIL_SKIPPED)[keyof typeof WORK_MAIL_SKIPPED] };

export function workMailVerdict(
  row: {
    readonly kind: NotificationKind;
    /** The address the row was made for (lower-cased at enqueue). */
    readonly toEmail: string;
    readonly quietHeld: boolean;
    /** The row's notification ids, and how many of them are still unseen. */
    readonly notificationCount: number;
    readonly unseenCount: number;
    /** A held update reminder a newer one or a post has overtaken (`reminderOvertaken`). */
    readonly overtaken: boolean;
  },
  receiver: WorkMailReceiver | undefined,
  now: Date,
): WorkMailVerdict {
  const wanted =
    receiver !== undefined &&
    receiver.memberStatus === "ACTIVE" &&
    (DIGEST_SENDING_TENANT_STATUSES as readonly string[]).includes(receiver.tenantStatus) &&
    receiver.email === row.toEmail &&
    emailAllowed(receiver.emailLevel, row.kind);
  if (!wanted) return { action: "skip", why: WORK_MAIL_SKIPPED.unwanted };
  const until = quietRelease(now, receiver.quiet, receiver.zone);
  if (until !== null) return { action: "hold", until };
  if (row.quietHeld && row.notificationCount > 0 && row.unseenCount === 0) {
    return { action: "skip", why: WORK_MAIL_SKIPPED.seen };
  }
  if (row.quietHeld && row.overtaken) return { action: "skip", why: WORK_MAIL_SKIPPED.overtaken };
  return { action: "send" };
}

/**
 * A held "update due" reminder is overtaken when a NEWER reminder for the same
 * project has reached the same member since it was made (the job's next day or
 * next step — it says the same thing, fresher), or when an update that counts
 * for the schedule was published after it was made (`lastCountingPostAt`'s
 * rule, read by the drain).
 */
export function reminderOvertaken(createdAt: Date, lastCountingPostAt: Date | null, newerReminder: boolean): boolean {
  if (newerReminder) return true;
  return lastCountingPostAt !== null && lastCountingPostAt.getTime() > createdAt.getTime();
}

/** Seen in the inbox: read, archived, or snoozed past `now` — the summary's "still unread", inverted. */
export const isSeen = (
  n: { readonly readAt: Date | null; readonly archivedAt: Date | null; readonly snoozedTill: Date | null },
  now: Date,
): boolean => n.readAt !== null || n.archivedAt !== null || (n.snoozedTill !== null && n.snoozedTill.getTime() > now.getTime());
