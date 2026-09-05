import { record } from "@/audit/record";
import type { MemberActor } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";

import { isEmailLevel, type EmailLevelValue } from "./catalog";
import { WEEKLY_REMINDER_KIND } from "./weekly-reminder";

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
 * WHAT THIS EXPOSES IS WHAT IS WIRED, and nothing else. The model
 * carries `inAppLevel`, `digestCadence`, `digestHour`, `digestWeekday`,
 * quiet hours and a timezone; digests are Phase 5 and NOTHING reads
 * them today, so offering them would be a page of controls that change
 * nothing. `inAppLevel` is deliberately absent for a stronger reason:
 * the inbox is where an assignment is found, and a setting that can
 * silence it silently is how someone misses work.
 */

export type NotifyCtx = { readonly tenantId: string; readonly actor: MemberActor };

/** The schema default, restated so "no row yet" and "a row holding the
 * default" are the same answer everywhere (`emit` relies on this too). */
export const DEFAULT_EMAIL_LEVEL: EmailLevelValue = "PARTICIPATING";

export type MemberNotificationPreferences = {
  readonly emailLevel: EmailLevelValue;
  readonly weeklyTimeReminder: boolean;
};

/** Only the fields the page can actually change. */
export type NotificationPreferencePatch = {
  readonly emailLevel?: EmailLevelValue;
  readonly weeklyTimeReminder?: boolean;
};

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
    select: { emailLevel: true, perKind: true },
  });
  return {
    emailLevel: isEmailLevel(row?.emailLevel) ? row.emailLevel : DEFAULT_EMAIL_LEVEL,
    weeklyTimeReminder: weeklyFrom(row?.perKind),
  };
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
    const next: MemberNotificationPreferences = {
      emailLevel: patch.emailLevel ?? current.emailLevel,
      weeklyTimeReminder: patch.weeklyTimeReminder ?? current.weeklyTimeReminder,
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
        data: { emailLevel: next.emailLevel, perKind },
      });
    } else {
      await tx.notificationPreference.create({
        data: {
          tenantId: ctx.tenantId,
          receiverType: "MEMBER",
          receiverId: ctx.actor.memberId,
          emailLevel: next.emailLevel,
          perKind,
        },
      });
    }

    await record(tx, {
      action: "notification.preference_changed",
      targetType: "Member",
      targetId: ctx.actor.memberId,
      metadata: { emailLevel: next.emailLevel, weeklyTimeReminder: next.weeklyTimeReminder },
    });
    return next;
  });
}
