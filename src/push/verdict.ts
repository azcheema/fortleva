import type { EmailLevelValue, NotificationKind } from "@/notify/catalog";
import { DIGEST_SENDING_TENANT_STATUSES } from "@/notify/digest";
import { isQuietAt, type QuietHours } from "@/notify/quiet-hours";
import { isSeen } from "@/notify/work-mail";

import { pushAllowed } from "./payload";

/**
 * WHETHER ONE NOTIFICATION BUZZES ITS RECEIVER'S DEVICES (Phase 5 slice 106;
 * founder decision C74). Asked once, by the drain, at the moment it would go
 * (`src/jobs/push.ts`) — and never again: the drain stamps the notification
 * whatever the answer (`notification.pushed_at`), so a push is now or never.
 *
 *   1. WANTED: the member still active, their workspace still sending (the
 *      summary's and the work mail's rule — a suspended or closed workspace
 *      buzzes nobody), and their PHONE level letting this kind through (C74
 *      (b): its own setting on the email ladder; (i): the owners' alarm at any
 *      level but Nothing — `pushAllowed`).
 *   2. NOT QUIET — WHEN IT HAPPENED, NOR NOW (C74 (c): silent, never later).
 *      Quiet when the notification was made means it belongs to the quiet
 *      time, so a drain that reaches it a minute after the quiet ended (a lost
 *      kick, picked up by the jobs route) must not deliver it then; quiet now
 *      means the member is asleep. The email waits for the morning (slice 105)
 *      and the inbox has it. (The design review's M5.)
 *   3. NOT SEEN: read, archived or snoozed in the inbox already — "if you're
 *      already looking, don't buzz". There is no wait to make this likely: a
 *      task handed over buzzes at once (C74 (h)); this catches what was seen
 *      before the drain got to it.
 * Which DEVICES then get it — those whose sign-in is still alive (C74 (d)) — is
 * the drain's read, not this rule's; how long the push service may hold it is
 * `pushTtlSeconds`.
 */

export type PushReceiver = {
  readonly memberStatus: string;
  readonly tenantStatus: string;
  readonly pushLevel: EmailLevelValue;
  readonly quiet: QuietHours;
  /** The member's own zone (`usableZone`) — the clock quiet hours are read on. */
  readonly zone: string;
};

export const PUSH_DROPPED = {
  unwanted: "unwanted",
  quiet: "quiet",
  seen: "seen",
} as const;

export type PushVerdict =
  | { readonly action: "send" }
  | { readonly action: "drop"; readonly why: (typeof PUSH_DROPPED)[keyof typeof PUSH_DROPPED] };

export function pushVerdict(
  note: {
    readonly kind: NotificationKind;
    readonly createdAt: Date;
    readonly readAt: Date | null;
    readonly archivedAt: Date | null;
    readonly snoozedTill: Date | null;
  },
  receiver: PushReceiver | undefined,
  now: Date,
): PushVerdict {
  const wanted =
    receiver !== undefined &&
    receiver.memberStatus === "ACTIVE" &&
    (DIGEST_SENDING_TENANT_STATUSES as readonly string[]).includes(receiver.tenantStatus) &&
    pushAllowed(receiver.pushLevel, note.kind);
  if (!wanted) return { action: "drop", why: PUSH_DROPPED.unwanted };
  if (isQuietAt(note.createdAt, receiver.quiet, receiver.zone) || isQuietAt(now, receiver.quiet, receiver.zone)) {
    return { action: "drop", why: PUSH_DROPPED.quiet };
  }
  if (isSeen(note, now)) return { action: "drop", why: PUSH_DROPPED.seen };
  return { action: "send" };
}

/** The grain of a TTL cut short by quiet hours: the push service sees the TTL, so a finer one would tell it the member's schedule. */
export const QUIET_TTL_GRAIN_SECONDS = 5 * 60;

/**
 * How long a push stays good — the push service's `TTL` (RFC 8030 §5.2) — so
 * that it can never arrive in the member's quiet time, nor after the drain's
 * "late or never" window (C74 (c); the design review's M5): a phone that went
 * offline at 18:55 and comes back at 19:30 inside 19:00–07:00 quiet hours gets
 * nothing.
 *
 * The window's remainder, unless the member's quiet time begins first. That is
 * found in one-minute steps AND at the window's very end (the code review's
 * nit: a quiet start inside the last partial minute was missed) — quiet hours
 * change on whole hours, so a minute's grain is exact at the boundary — and the
 * bound it gives is rounded DOWN to `QUIET_TTL_GRAIN_SECONDS` (the security
 * review's low: the TTL is visible to the push service, and a minute-exact one
 * would disclose when the member's quiet hours begin). Rounding down keeps the
 * promise: never into quiet time. Zero: deliver only to a device that is
 * online right now, else drop.
 */
export function pushTtlSeconds(
  windowEndsAt: Date,
  receiver: Pick<PushReceiver, "quiet" | "zone">,
  now: Date,
): number {
  const windowLeft = Math.max(0, Math.floor((windowEndsAt.getTime() - now.getTime()) / 1000));
  const steps: number[] = [];
  for (let s = 60; s < windowLeft; s += 60) steps.push(s);
  if (windowLeft > 0) steps.push(windowLeft);
  let safe = 0;
  for (const s of steps) {
    if (isQuietAt(new Date(now.getTime() + s * 1000), receiver.quiet, receiver.zone)) {
      return Math.floor(safe / QUIET_TTL_GRAIN_SECONDS) * QUIET_TTL_GRAIN_SECONDS;
    }
    safe = s;
  }
  return windowLeft;
}
