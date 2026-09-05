import { withPlatform, withTenant } from "@/db";
import {
  DEFAULT_HOUR,
  DEFAULT_WEEKDAY,
  WEEKLY_REMINDER_KIND,
  dueAt,
  selectOptIns,
} from "@/notify/weekly-reminder";
import { readPreferences } from "@/preferences/service";

/**
 * The 2T weekly self-reminder (PLAN.md Phase 2T, delta D6: "opt-in
 * weekly self-reminder email (self-addressed only, via the 2W
 * outbox)").
 *
 * SELF-ADDRESSED IS THE WHOLE SECURITY STORY. There is no actor, no
 * subject and no recipient other than the member who ticked the box:
 * the job never reads a task, a client or a project, and the mail
 * carries no data at all — one sentence and a link to `/time`, which is
 * then rendered under the member's own session. Nothing about it can
 * leak, because nothing about it is loaded.
 *
 * NO NOTIFICATION ROW, deliberately. This is a nudge the member asked
 * for on a schedule, not something that happened; a weekly "did you log
 * your time?" in `/inbox` would be the first row in that surface that
 * reports no event, and the inbox's whole promise is that every row is
 * one. So the job enqueues an `EmailOutbox` row directly — which is why
 * `EmailOutbox.kind` had to become a template key rather than a
 * notification kind (see `notify/templates.ts`).
 *
 * EXACTLY-ONCE IS THE IDEMPOTENCY KEY, and nothing else — no new table,
 * no "last sent" column. `weekly-reminder:<memberId>:<isoYear>-W<week>`
 * is unique, so however often the job runs in a week, the second insert
 * is a `skipDuplicates` no-op. That also means the job does not need to
 * fire at a precise hour: it sends once the member's configured moment
 * has PASSED in their own week, so a cron that missed Monday still
 * delivers on Tuesday rather than skipping the week in silence.
 */

export async function runWeeklyReminders(
  now: Date = new Date(),
): Promise<{ tenants: number; enqueued: number }> {
  // Cross-tenant discovery under the one audited platform entry point.
  //
  // The SQL narrows to member preference rows and the opt-in test then
  // runs in JS. `perKind` is a Json column with no index and its key
  // contains a dot, so a `path` filter would be both unindexed and
  // fragile; the rows are one per member who has ever OPENED the
  // settings page, which is the smallest table in this schema. When
  // that stops being true the fix is a JSON-path index, not a scan in
  // application code — recorded so it is a decision rather than a
  // habit.
  const optIns = await withPlatform(
    { type: "system", job: "weekly-reminders" },
    "list members who opted in to the weekly time reminder",
    async (tx) => {
      const rows = await tx.notificationPreference.findMany({
        where: { receiverType: "MEMBER" },
        select: { tenantId: true, receiverId: true, perKind: true, emailLevel: true },
      });
      return selectOptIns(rows);
    },
  );

  const byTenant = new Map<string, string[]>();
  for (const o of optIns) byTenant.set(o.tenantId, [...(byTenant.get(o.tenantId) ?? []), o.memberId]);

  let enqueued = 0;
  for (const [tenantId, memberIds] of byTenant) {
    enqueued += await enqueueForTenant(tenantId, memberIds, now);
  }
  return { tenants: byTenant.size, enqueued };
}

/**
 * Enqueue this tenant's due reminders.
 *
 * IT RE-CHECKS THE OPT-IN, and that is not redundancy for its own sake:
 * this is the function that mails a person, and "who" arrives as a
 * parameter. A caller that widened the list — a future digest job
 * reusing it, a test, a mis-shaped query — would otherwise mail people
 * who never asked, silently and once a week. The rows it needs for the
 * schedule already carry `perKind` and `emailLevel`, so the second belt
 * costs nothing but the two columns. `selectOptIns` upstream is a COST
 * control (which tenants are worth opening at all); this is the gate.
 */
export async function enqueueForTenant(
  tenantId: string,
  memberIds: readonly string[],
  now: Date,
): Promise<number> {
  return withTenant(tenantId, { type: "system" }, async (tx) => {
    const [prefs, members, settings] = await Promise.all([
      tx.notificationPreference.findMany({
        where: { tenantId, receiverType: "MEMBER", receiverId: { in: [...memberIds] } },
        select: {
          tenantId: true,
          receiverId: true,
          perKind: true,
          emailLevel: true,
          timezone: true,
          digestWeekday: true,
          digestHour: true,
        },
      }),
      tx.member.findMany({
        where: { tenantId, id: { in: [...memberIds] }, status: "ACTIVE" },
        select: { id: true, timezone: true, user: { select: { email: true, locale: true } } },
      }),
      readPreferences(tx, tenantId),
    ]);
    const prefOf = new Map(prefs.map((p) => [p.receiverId, p]));
    const consenting = new Set(selectOptIns(prefs).map((o) => o.memberId));
    const rows = members.flatMap((m) => {
      const pref = prefOf.get(m.id);
      // No row means no opt-in: the reminder is off until it is ticked.
      if (!consenting.has(m.id) || !m.user.email) return [];
      // Three fallbacks, most specific first: the notification row's own
      // zone, then the member's, then the workspace's. A member with
      // none of them would otherwise be reminded at 08:00 UTC, which is
      // the middle of the night for half the world.
      const zone = pref?.timezone ?? m.timezone ?? settings.timezone;
      const due = dueAt(now, zone, pref?.digestWeekday ?? DEFAULT_WEEKDAY, pref?.digestHour ?? DEFAULT_HOUR);
      if (due === null || now < due.at) return [];
      return [
        {
          tenantId,
          idempotencyKey: `weekly-reminder:${m.id}:${due.isoYear}-W${String(due.isoWeek).padStart(2, "0")}`,
          receiverType: "MEMBER" as const,
          receiverId: m.id,
          toEmail: m.user.email.toLowerCase(),
          kind: WEEKLY_REMINDER_KIND,
          locale: m.user.locale === "sv" ? "sv" : "en",
          // No params: the mail is one sentence and a link. Nothing
          // about this member's work is loaded, so nothing can leak.
          notificationIds: [],
          sendAfter: due.at,
        },
      ];
    });
    if (rows.length === 0) return 0;
    // Suppression is re-checked by the worker at send; the enqueue-time
    // check keeps a hard-bounced address out of the queue entirely.
    const suppressed = new Set(
      (
        await tx.emailSuppression.findMany({
          where: { email: { in: rows.map((r) => r.toEmail) } },
          select: { email: true },
        })
      ).map((s) => s.email),
    );
    const data = rows.filter((r) => !suppressed.has(r.toEmail));
    if (data.length === 0) return 0;
    const { count } = await tx.emailOutbox.createMany({ data, skipDuplicates: true });
    return count;
  });
}
