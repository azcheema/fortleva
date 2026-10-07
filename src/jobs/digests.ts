import { withPlatform, withTenant, type TenantDb } from "@/db";
import { isEmailLevel } from "@/notify/catalog";
import {
  DEFAULT_DIGEST_CADENCE,
  DEFAULT_DIGEST_HOUR,
  DEFAULT_DIGEST_WEEKDAY,
  DIGEST_MAX_ROWS,
  DIGEST_SENDING_TENANT_STATUSES,
  DIGEST_SETTLE_MS,
  MEMBER_DIGEST_MAIL,
  digestSince,
  isDigestCadence,
  memberDigestKey,
  periodDueNow,
  summarisedKinds,
} from "@/notify/digest";
import { readPreferences } from "@/preferences/service";

/**
 * THE TEAM'S SUMMARY EMAIL — the job (Phase 5 slice 100; founder decision
 * C68 (b), (e), (h); ARCHITECTURE.md §5's `digests` row: hourly, each member's
 * own zone). The rules — when a summary is due, where it starts counting, what
 * it says — are `src/notify/digest.ts`'s; this file is only queries.
 *
 * Each member gets ONE outbox row per period (`digest:member:<id>:<period>`,
 * the idempotency key being the once-only guard, as the weekly reminder's is),
 * only in the few hours after their summary's time in their own zone
 * (`periodDueNow`), and only when something arrived since their last summary
 * that is still unread. The row carries the ids of the notifications it covers
 * and, in `params`, only the summary's time: the outbox counts the ones STILL
 * unread when it sends
 * (`src/jobs/outbox.ts`), so a summary never reports news its reader has
 * opened since, and SKIPS when none is left. The row's own `createdAt` is
 * where the next summary starts counting (`digestSince`), so no notification
 * is counted by two summaries.
 *
 * Discovery is the one audited cross-tenant read (`withPlatform`, read-only,
 * ids only), and leaves out workspaces that are suspended, being offboarded
 * or closed. Each tenant then runs under its OWN system principal — the
 * notification policy lets the system principal read every receiver's rows
 * ("fan-out + digests", migration 20260820170000) — so nothing here can mix
 * two tenants' rows. ONE TENANT'S FAILURE DOES NOT SKIP THE REST: it is
 * counted and logged by name and code only (a Prisma message prints the
 * query's arguments — addresses among them), and the next run retries it.
 * Invoked by `POST /api/jobs/run` until Vercel Cron exists.
 */

const DAY_MS = 86_400_000;
const SYSTEM = { type: "system" } as const;
const SENDING_STATUSES = DIGEST_SENDING_TENANT_STATUSES;
/** A weekly period and the catch-up hours, with a day to spare for zones. */
const DISCOVERY_DAYS = 9;

export async function runMemberDigests(
  now: Date = new Date(),
): Promise<{ tenants: number; enqueued: number; failed: number }> {
  // The tenants with anything a summary could count. No index serves this
  // scan across tenants (the notification indexes lead with tenant_id); at
  // today's size that is a non-issue, and when it stops being one the fix is
  // an index on `(created_at) WHERE read_at IS NULL`, not a cleverer query —
  // recorded so it is a decision, not a habit.
  const tenantIds = await withPlatform(
    { type: "system", job: "digests" },
    "list sending tenants with unread member notifications inside a summary's reach",
    async (tx) => {
      const rows = await tx.notification.findMany({
        where: {
          receiverType: "MEMBER",
          readAt: null,
          archivedAt: null,
          createdAt: { gte: new Date(now.getTime() - DISCOVERY_DAYS * DAY_MS) },
          tenant: { status: { in: [...SENDING_STATUSES] } },
        },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      return rows.map((r) => r.tenantId);
    },
  );

  const out = { tenants: tenantIds.length, enqueued: 0, failed: 0 };
  for (const tenantId of tenantIds) {
    try {
      out.enqueued += await enqueueMemberDigests(tenantId, now);
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`digests: tenant ${tenantId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  return out;
}

/** The first zone Intl accepts. A stored zone this build did not write must
 * not throw a whole tenant's summaries away. */
function usableZone(...candidates: (string | null | undefined)[]): string {
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

type Due = {
  readonly memberId: string;
  readonly email: string;
  readonly locale: "sv" | "en";
  /** This period's summary time — the outbox drops the row four hours after it (catch-up + grace). */
  readonly dueAt: Date;
  readonly previousAt: Date;
  readonly cadence: "DAILY" | "WEEKLY";
  readonly key: string;
};

/**
 * Enqueue this tenant's due summaries. Exported for the dbtest, which runs it
 * against its own throwaway tenant rather than every tenant of the database.
 */
export async function enqueueMemberDigests(tenantId: string, now: Date): Promise<number> {
  return withTenant(tenantId, SYSTEM, async (tx) => {
    // In SEQUENCE, never a `Promise.all` (AGENTS.md's standing trap: the
    // legs would share this transaction's one connection).
    const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { status: true } });
    if (!tenant || !(SENDING_STATUSES as readonly string[]).includes(tenant.status)) return 0;
    const members = await tx.member.findMany({
      where: { tenantId, status: "ACTIVE" },
      select: { id: true, timezone: true, user: { select: { email: true, locale: true } } },
    });
    if (members.length === 0) return 0;
    const prefs = await tx.notificationPreference.findMany({
      where: { tenantId, receiverType: "MEMBER", receiverId: { in: members.map((m) => m.id) } },
      select: {
        receiverId: true,
        emailLevel: true,
        digestCadence: true,
        digestHour: true,
        digestWeekday: true,
        timezone: true,
      },
    });
    const settings = await readPreferences(tx, tenantId);
    const prefOf = new Map(prefs.map((p) => [p.receiverId, p]));

    const candidates: Due[] = [];
    for (const m of members) {
      if (!m.user.email) continue;
      const pref = prefOf.get(m.id);
      // Email "Nothing" means no mail from Fortleva, full stop — the weekly
      // reminder's rule, and the settings page says so under the summary.
      // No row is the schema default: a daily summary at 08:00 (C68 (b)).
      if (isEmailLevel(pref?.emailLevel) && pref.emailLevel === "NONE") continue;
      const cadence = isDigestCadence(pref?.digestCadence) ? pref.digestCadence : DEFAULT_DIGEST_CADENCE;
      if (cadence === "NONE") continue;
      // The weekly reminder's three fallbacks, most specific first.
      const zone = usableZone(pref?.timezone, m.timezone, settings.timezone);
      const period = periodDueNow(
        now,
        zone,
        cadence,
        pref?.digestHour ?? DEFAULT_DIGEST_HOUR,
        pref?.digestWeekday ?? DEFAULT_DIGEST_WEEKDAY,
      );
      if (period === null) continue;
      candidates.push({
        memberId: m.id,
        email: m.user.email.toLowerCase(),
        locale: m.user.locale === "sv" ? "sv" : "en",
        dueAt: period.at,
        previousAt: period.previousAt,
        cadence,
        key: memberDigestKey(m.id, period.periodKey),
      });
    }
    if (candidates.length === 0) return 0;

    // Already enqueued this period: the hourly job reaches a member up to
    // three times inside the window, and the key would refuse the row anyway —
    // this only saves counting their inbox again.
    const done = new Set(
      (
        await tx.emailOutbox.findMany({
          where: { idempotencyKey: { in: candidates.map((c) => c.key) } },
          select: { idempotencyKey: true },
        })
      ).map((r) => r.idempotencyKey),
    );
    const suppressed = new Set(
      (
        await tx.emailSuppression.findMany({
          where: { email: { in: candidates.map((c) => c.email) } },
          select: { email: true },
        })
      ).map((s) => s.email),
    );
    const due = candidates.filter((c) => !done.has(c.key) && !suppressed.has(c.email));
    if (due.length === 0) return 0;
    // Where each one's last summary was made: the next counts from there —
    // a summary on its way, sent, or skipped because all of it had been read.
    // NOT one the outbox DROPPED unsent (too late, or no longer wanted): its
    // news reached nobody, so the chain runs from the one before it.
    const last = new Map(
      (
        await tx.emailOutbox.groupBy({
          by: ["receiverId"],
          where: {
            tenantId,
            receiverType: "MEMBER",
            receiverId: { in: due.map((c) => c.memberId) },
            kind: MEMBER_DIGEST_MAIL,
            OR: [
              { status: { in: ["QUEUED", "SENDING", "FAILED", "SENT"] } },
              { status: "SKIPPED", lastError: null },
            ],
          },
          _max: { createdAt: true },
        })
      ).map((g) => [g.receiverId, g._max.createdAt]),
    );

    // Counted up to a minute ago, and the next summary starts from there
    // (`DIGEST_SETTLE_MS`): a row stamped just before this read and committed
    // just after it is the next summary's, never nobody's.
    const until = new Date(now.getTime() - DIGEST_SETTLE_MS);
    const data = [];
    for (const c of due) {
      const since = digestSince(last.get(c.memberId) ?? null, c.previousAt, c.cadence);
      const ids = await rowsToSummarise(tx, tenantId, c.memberId, since, until, now);
      if (ids.length === 0) continue;
      data.push({
        tenantId,
        idempotencyKey: c.key,
        receiverType: "MEMBER" as const,
        receiverId: c.memberId,
        toEmail: c.email,
        kind: MEMBER_DIGEST_MAIL,
        locale: c.locale,
        // Only the summary's TIME, so the outbox can drop it once its hours
        // are over (the fix-pass review: measured from the row's own
        // creation, a summary made at 10:59 for 08:00 could go at 13:59). No
        // counts: the outbox counts the linked rows still unread at send.
        params: { dueAt: c.dueAt.toISOString() },
        notificationIds: ids,
        // Due at once — stated a minute back, so an app clock ahead of the
        // database's cannot hold it out of the outbox's next claim.
        sendAfter: until,
        // Stated, not defaulted: the next summary counts from exactly here.
        createdAt: until,
      });
    }
    if (data.length === 0) return 0;
    const { count } = await tx.emailOutbox.createMany({ data, skipDuplicates: true });
    return count;
  });
}

/**
 * The rows one member's summary covers: their own, unread, unarchived, not
 * snoozed past now, of a kind a summary counts, that arrived since `since`
 * and before `until` (C68 (h): what they were already emailed about
 * included). Newest first, at most `DIGEST_MAX_ROWS`.
 */
async function rowsToSummarise(
  tx: TenantDb,
  tenantId: string,
  memberId: string,
  since: Date,
  until: Date,
  now: Date,
): Promise<string[]> {
  const rows = await tx.notification.findMany({
    where: {
      tenantId,
      receiverType: "MEMBER",
      receiverId: memberId,
      readAt: null,
      archivedAt: null,
      createdAt: { gte: since, lt: until },
      kind: { in: summarisedKinds() },
      OR: [{ snoozedTill: null }, { snoozedTill: { lte: now } }],
    },
    select: { id: true },
    orderBy: { id: "desc" },
    take: DIGEST_MAX_ROWS,
  });
  return rows.map((r) => r.id);
}
