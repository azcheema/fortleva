import { record } from "@/audit/record";
import type { MemberActor } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { fail } from "@/lib/domain-error";
import { readPreferences } from "@/preferences/service";

import { isEmailLevel, type EmailLevelValue } from "./catalog";
import {
  DEFAULT_DIGEST_CADENCE,
  DEFAULT_DIGEST_HOUR,
  DEFAULT_DIGEST_WEEKDAY,
  isDigestCadence,
  type DigestCadenceValue,
} from "./digest";
import { DEFAULT_QUIET_FROM, DEFAULT_QUIET_TO, isQuietHour, quietHoursOf, quietRelease } from "./quiet-hours";
import { WEEKLY_REMINDER_KIND } from "./weekly-reminder";
import { usableZone } from "./zone";

/**
 * A member's own notification preferences (`/settings/notifications`;
 * `NotificationPreference`, DATA_MODEL.md §6.18).
 *
 * THE ROW IS ALWAYS THE ACTOR'S OWN, and that is enforced by the shape
 * of this module rather than by a check inside it: no function here
 * takes a receiver id, so there is no parameter an caller could get
 * wrong. `NotificationPreference` is class A — `tenant_isolation` plus
 * `portal_deny`, with no per-principal binding — so unlike the inbox,
 * the database would happily let one member write another's row. The
 * application is the only gate, which is exactly why it is not a
 * parameter.
 *
 * NO `requireAccess`: notifications are core and "never
 * entitlement-gated — channels toggled by preference" (§6.18). NO
 * permission code either: there is no seat in this product that may
 * decide, on someone else's behalf, whether that person is emailed.
 *
 * WHAT THIS EXPOSES IS WHAT IS WIRED, and nothing else. Since Phase 5
 * slice 100 that includes the SUMMARY EMAIL's cadence, hour and weekday
 * (`digestCadence`, `digestHour`, `digestWeekday` — read by
 * `src/jobs/digests.ts`), and since slice 105 the QUIET HOURS
 * (`quietHoursFrom`, `quietHoursTo`, `quietWeekends` — read by `notify.emit`
 * and the outbox drain, src/notify/quiet-hours.ts; founder decision C73), and
 * since slice 106 the PHONE's own level (`pushLevel` — read by the push drain,
 * src/jobs/push.ts; founder decision C74 (b)).
 * The model also carries `inAppLevel`, which nothing reads, so it is not
 * offered — a control that changes nothing is worse than none. Its `timezone`
 * IS read, first, by the summary, the weekly reminder and quiet hours, but
 * nothing writes it: the zone that decides is the member's own on `/account`
 * (`Member.timezone`), else the workspace's — which is what the page names.
 * `inAppLevel` is deliberately absent for
 * a stronger reason: the inbox is where an assignment is found, and a
 * setting that can silence it silently is how someone misses work.
 */

export type NotifyCtx = { readonly tenantId: string; readonly actor: MemberActor };

/** The schema default, restated so "no row yet" and "a row holding the
 * default" are the same answer everywhere (`emit` relies on this too). */
export const DEFAULT_EMAIL_LEVEL: EmailLevelValue = "PARTICIPATING";

export type MemberNotificationPreferences = {
  readonly emailLevel: EmailLevelValue;
  readonly weeklyTimeReminder: boolean;
  /** The summary email (slice 100): how often, at what local hour, on what weekday when weekly. */
  readonly digestCadence: DigestCadenceValue;
  readonly digestHour: number;
  /** 1 = Monday … 7 = Sunday. */
  readonly digestWeekday: number;
  /** Quiet hours (slice 105): both set or both null — null is "off". */
  readonly quietHoursFrom: number | null;
  readonly quietHoursTo: number | null;
  readonly quietWeekends: boolean;
  /** The PHONE's own level (slice 106, C74 (b)) — the email ladder, read by the push drain. */
  readonly pushLevel: EmailLevelValue;
};

/** Only the fields the page can actually change. */
export type NotificationPreferencePatch = {
  readonly emailLevel?: EmailLevelValue;
  readonly weeklyTimeReminder?: boolean;
  readonly digestCadence?: DigestCadenceValue;
  readonly digestHour?: number;
  readonly digestWeekday?: number;
  /**
   * Quiet hours: `null` switches them off; an object switches them on — an
   * hour it leaves out keeps the one saved, else 19:00–07:00 (the form posts
   * no hours on the change that switches them on: they are not on the page
   * yet). The same hour twice is refused (`QUIET_HOURS_SAME`).
   */
  readonly quietHours?: { readonly from?: number; readonly to?: number } | null;
  readonly quietWeekends?: boolean;
  readonly pushLevel?: EmailLevelValue;
};

export const isDigestHour = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23;
export const isDigestWeekday = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 7;

type PerKind = Record<string, { email?: boolean; inApp?: boolean } | undefined>;

/** `perKind` is Json: anything could be in there, including null and an
 * array. Read it defensively and treat a malformed value as absent. */
const readPerKind = (raw: unknown): PerKind =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as PerKind) : {};

const weeklyFrom = (raw: unknown): boolean =>
  readPerKind(raw)[WEEKLY_REMINDER_KIND]?.email === true;

/**
 * The member's effective preferences. A member who has never opened the
 * page has no row, and gets the defaults — never an error and never a
 * write, because reading a page must not create data.
 */
export async function readOwnPreferences(
  ctx: NotifyCtx,
): Promise<MemberNotificationPreferences> {
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) =>
    loadOwn(tx, ctx),
  );
}

async function loadOwn(tx: TenantDb, ctx: NotifyCtx): Promise<MemberNotificationPreferences> {
  const row = await tx.notificationPreference.findFirst({
    where: { tenantId: ctx.tenantId, receiverType: "MEMBER", receiverId: ctx.actor.memberId },
    select: {
      emailLevel: true,
      perKind: true,
      digestCadence: true,
      digestHour: true,
      digestWeekday: true,
      quietHoursFrom: true,
      quietHoursTo: true,
      quietWeekends: true,
      pushLevel: true,
    },
  });
  const quiet = quietHoursOf(row);
  return {
    emailLevel: isEmailLevel(row?.emailLevel) ? row.emailLevel : DEFAULT_EMAIL_LEVEL,
    weeklyTimeReminder: weeklyFrom(row?.perKind),
    // A stored value this build would not write (none can be written through
    // this module, which range-checks) reads as the default here, so the page
    // offers a choice the member can save; the job (`src/jobs/digests.ts`)
    // meanwhile skips such a member rather than guess — the one case where
    // page and job disagree, until the member saves.
    digestCadence: isDigestCadence(row?.digestCadence) ? row.digestCadence : DEFAULT_DIGEST_CADENCE,
    digestHour: isDigestHour(row?.digestHour) ? row.digestHour : DEFAULT_DIGEST_HOUR,
    digestWeekday: isDigestWeekday(row?.digestWeekday) ? row.digestWeekday : DEFAULT_DIGEST_WEEKDAY,
    quietHoursFrom: quiet.from,
    quietHoursTo: quiet.to,
    quietWeekends: quiet.weekends,
    pushLevel: isEmailLevel(row?.pushLevel) ? row.pushLevel : DEFAULT_EMAIL_LEVEL,
  };
}

/** The hours a patch settles on, against what is saved (see the patch's note). */
function settleQuietHours(
  current: MemberNotificationPreferences,
  patch: NotificationPreferencePatch["quietHours"],
): { from: number | null; to: number | null } {
  if (patch === undefined) return { from: current.quietHoursFrom, to: current.quietHoursTo };
  if (patch === null) return { from: null, to: null };
  const from = patch.from ?? current.quietHoursFrom ?? DEFAULT_QUIET_FROM;
  const to = patch.to ?? current.quietHoursTo ?? DEFAULT_QUIET_TO;
  if (!isQuietHour(from) || !isQuietHour(to)) fail("INVALID_INPUT", "quiet hours out of range");
  if (from === to) fail("QUIET_HOURS_SAME");
  return { from, to };
}

/**
 * Write the fields the patch carries and audit the result.
 *
 * The audit records the SETTLED values rather than the patch, because
 * the page saves one field at a time (UI.md §5.10, no Save buttons) and
 * an event that said only "emailLevel: NONE" would not say what the
 * member's notifications actually became. `notification.preference_changed`
 * is a TENANT-visible action and the values are settings, not secrets.
 *
 * A no-op patch still writes: it is one row, the settled values are
 * what the audit is for, and a "save" that quietly recorded nothing
 * would make the trail depend on what the previous value happened to
 * be.
 */
export async function updateOwnPreferences(
  ctx: NotifyCtx,
  patch: NotificationPreferencePatch,
): Promise<MemberNotificationPreferences> {
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    const current = await loadOwn(tx, ctx);
    const hours = settleQuietHours(current, patch.quietHours);
    const next: MemberNotificationPreferences = {
      emailLevel: patch.emailLevel ?? current.emailLevel,
      weeklyTimeReminder: patch.weeklyTimeReminder ?? current.weeklyTimeReminder,
      digestCadence: patch.digestCadence ?? current.digestCadence,
      digestHour: patch.digestHour ?? current.digestHour,
      digestWeekday: patch.digestWeekday ?? current.digestWeekday,
      quietHoursFrom: hours.from,
      quietHoursTo: hours.to,
      quietWeekends: patch.quietWeekends ?? current.quietWeekends,
      pushLevel: patch.pushLevel ?? current.pushLevel,
    };
    // The action validates; this is the belt, because these become a
    // schedule a job acts on.
    if (!isDigestCadence(next.digestCadence) || !isDigestHour(next.digestHour) || !isDigestWeekday(next.digestWeekday)) {
      throw new Error("notify: a summary setting out of range");
    }
    const summary = {
      digestCadence: next.digestCadence,
      digestHour: next.digestHour,
      digestWeekday: next.digestWeekday,
      quietHoursFrom: next.quietHoursFrom,
      quietHoursTo: next.quietHoursTo,
      quietWeekends: next.quietWeekends,
      pushLevel: next.pushLevel,
    };

    const existing = await tx.notificationPreference.findFirst({
      where: { tenantId: ctx.tenantId, receiverType: "MEMBER", receiverId: ctx.actor.memberId },
      select: { id: true, perKind: true },
    });
    // Merge into whatever `perKind` already holds: it is the model's
    // extension point for every future kind, and replacing the object
    // would drop a setting this build has never heard of.
    const perKind: PerKind = {
      ...readPerKind(existing?.perKind),
      [WEEKLY_REMINDER_KIND]: { email: next.weeklyTimeReminder },
    };

    if (existing) {
      await tx.notificationPreference.update({
        where: { id: existing.id },
        data: { emailLevel: next.emailLevel, perKind, ...summary },
      });
    } else {
      await tx.notificationPreference.create({
        data: {
          tenantId: ctx.tenantId,
          receiverType: "MEMBER",
          receiverId: ctx.actor.memberId,
          emailLevel: next.emailLevel,
          perKind,
          ...summary,
        },
      });
    }

    const quietChanged =
      next.quietHoursFrom !== current.quietHoursFrom ||
      next.quietHoursTo !== current.quietHoursTo ||
      next.quietWeekends !== current.quietWeekends;
    if (quietChanged) await retimeHeldMail(tx, ctx, next);

    await record(tx, {
      action: "notification.preference_changed",
      targetType: "Member",
      targetId: ctx.actor.memberId,
      metadata: { ...next },
    });
    return next;
  });
}

/**
 * The member's work emails ALREADY WAITING on their quiet hours follow the
 * new ones (slice 105): switched off at 23:00, what waited goes at the next
 * drain; the end moved, they move with it. Only their own rows, only those
 * still QUEUED and held — a row a drain holds right now (SENDING) is not
 * touched, and that drain asks the quiet hours again itself. `email_outbox`
 * is class A with full runtime grants (2W); the filter on the actor's own id
 * is the gate, as the preference row's is.
 */
async function retimeHeldMail(tx: TenantDb, ctx: NotifyCtx, next: MemberNotificationPreferences): Promise<void> {
  // In SEQUENCE (AGENTS.md's standing trap).
  const member = await tx.member.findFirst({ where: { id: ctx.actor.memberId }, select: { timezone: true } });
  const pref = await tx.notificationPreference.findFirst({
    where: { tenantId: ctx.tenantId, receiverType: "MEMBER", receiverId: ctx.actor.memberId },
    select: { timezone: true },
  });
  const zone = usableZone(pref?.timezone, member?.timezone, (await readPreferences(tx, ctx.tenantId)).timezone);
  const now = new Date();
  const release = quietRelease(
    now,
    { from: next.quietHoursFrom, to: next.quietHoursTo, weekends: next.quietWeekends },
    zone,
  );
  await tx.emailOutbox.updateMany({
    where: {
      tenantId: ctx.tenantId,
      receiverType: "MEMBER",
      receiverId: ctx.actor.memberId,
      status: "QUEUED",
      quietHeld: true,
    },
    data: { sendAfter: release ?? now },
  });
}
