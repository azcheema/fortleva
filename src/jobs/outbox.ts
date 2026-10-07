import { withPlatform, withTenant } from "@/db";
import { send } from "@/mailer";
import { isNotificationKind, NOTIFICATION_KINDS } from "@/notify/catalog";
import {
  DIGEST_CATCH_UP_HOURS,
  DIGEST_DROPPED_LATE,
  DIGEST_DROPPED_UNWANTED,
  DIGEST_SEND_GRACE_HOURS,
  DIGEST_SENDING_TENANT_STATUSES,
  MEMBER_DIGEST_MAIL,
} from "@/notify/digest";
import { MAIL_WITHOUT_REPLY_TO, resolveReplyAddress } from "@/notify/reply-address-resolve";
import { isEmailTemplate, renderEmail } from "@/notify/templates";

/**
 * The outbox drain (ARC-21; §6.18): claims due rows with FOR UPDATE SKIP
 * LOCKED under the platform system principal, resolves each one INSIDE
 * the claim transaction (unknown kind → DEAD, debounce cancelled → SKIPPED,
 * suppressed address → SUPPRESSED, template rendered), then sends each
 * remaining message OUTSIDE any database transaction and finalises it in
 * its own short transaction. Invoked by a Vercel Cron every 2 minutes
 * (Pro) later; today by after() kicks and the authenticated
 * POST /api/jobs/run. Safe to run concurrently — the claim is the lock.
 *
 * Delivery is AT-LEAST-ONCE: enqueue is exactly-once (the idempotency
 * key), but a send that succeeded just before its finalise failed is
 * re-sent when the lease is reclaimed. Two things the review found and
 * this shape fixes: a claimed row whose delivery threw stayed SENDING
 * forever (nothing reclaimed a stale lease and one throw aborted the whole
 * loop), and the external send ran inside a 5 s database transaction.
 * withPlatform writes the platform audit event for the claim and for each
 * finalise (TENANCY §12).
 */

const MAX_ATTEMPTS = 8;
/** A SENDING row older than this was abandoned mid-flight (crash, timeout) and is claimed again. */
const LEASE_MINUTES = 10;

type ClaimedRow = {
  id: string;
  tenant_id: string;
  receiver_type: string;
  receiver_id: string;
  kind: string;
  locale: string;
  to_email: string;
  params: Record<string, unknown> | null;
  notification_ids: string[];
  attempts: number;
  created_at: Date;
};

type Outcome = "sent" | "skipped" | "suppressed" | "failed" | "dead";
type Prepared = { row: ClaimedRow; subject: string; text: string };

const SYSTEM = { type: "system", job: "outbox" } as const;

export async function drainOutbox(
  limit = 50,
  opts?: {
    /**
     * Drain ONE tenant's rows only. For a dbtest, which must never claim —
     * and "send" — another tenant's mail on the shared database (AGENTS.md:
     * no writes outside your own throwaway tenant; slice 100's design
     * review). Production drains every tenant.
     */
    readonly tenantId?: string;
  },
): Promise<{ sent: number; skipped: number; suppressed: number; failed: number; dead: number }> {
  const out = { sent: 0, skipped: 0, suppressed: 0, failed: 0, dead: 0 };
  const only = opts?.tenantId;

  const prepared = await withPlatform(
    SYSTEM,
    only ? `claim one tenant's due email_outbox rows (FOR UPDATE SKIP LOCKED)` : "claim due email_outbox rows (FOR UPDATE SKIP LOCKED) and resolve them",
    async (tx) => {
      const claimed = only
        ? await tx.$queryRaw<ClaimedRow[]>`
        UPDATE email_outbox SET status = 'SENDING', locked_at = now(), updated_at = now()
        WHERE id IN (
          SELECT id FROM email_outbox
          WHERE tenant_id = ${only}
            AND ((status IN ('QUEUED', 'FAILED') AND send_after <= now())
             OR (status = 'SENDING' AND locked_at < now() - make_interval(mins => ${LEASE_MINUTES})))
          ORDER BY send_after
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, tenant_id, receiver_type, receiver_id, kind, locale, to_email, params, notification_ids, attempts, created_at`
        : await tx.$queryRaw<ClaimedRow[]>`
        UPDATE email_outbox SET status = 'SENDING', locked_at = now(), updated_at = now()
        WHERE id IN (
          SELECT id FROM email_outbox
          WHERE (status IN ('QUEUED', 'FAILED') AND send_after <= now())
             OR (status = 'SENDING' AND locked_at < now() - make_interval(mins => ${LEASE_MINUTES}))
          ORDER BY send_after
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, tenant_id, receiver_type, receiver_id, kind, locale, to_email, params, notification_ids, attempts, created_at`;
      const toSend: Prepared[] = [];
      // The summaries' receivers, read ONCE for the whole claim rather than
      // per row (the fix-pass review: two reads per summary inside a leased
      // transaction add up over a slow link). Keyed by tenant and member.
      const digestRows = claimed.filter((r) => r.kind === MEMBER_DIGEST_MAIL);
      const standing = new Map<string, { status: string; tenantStatus: string }>();
      const summaryPrefs = new Map<string, { emailLevel: string; digestCadence: string }>();
      if (digestRows.length > 0) {
        const ids = [...new Set(digestRows.map((r) => r.receiver_id))];
        for (const m of await tx.member.findMany({
          where: { id: { in: ids } },
          select: { id: true, tenantId: true, status: true, tenant: { select: { status: true } } },
        })) {
          standing.set(`${m.tenantId}:${m.id}`, { status: m.status, tenantStatus: m.tenant.status });
        }
        for (const p of await tx.notificationPreference.findMany({
          where: { receiverType: "MEMBER", receiverId: { in: ids } },
          select: { tenantId: true, receiverId: true, emailLevel: true, digestCadence: true },
        })) {
          summaryPrefs.set(`${p.tenantId}:${p.receiverId}`, { emailLevel: p.emailLevel, digestCadence: p.digestCadence });
        }
      }
      for (const row of claimed) {
        // TEMPLATE key, not notification kind (see notify/templates.ts):
        // outbox rows exist that no fan-out produced — the 2T weekly
        // self-reminder — and treating those as unknown killed them.
        if (!isEmailTemplate(row.kind)) {
          await tx.emailOutbox.update({ where: { id: row.id }, data: { status: "DEAD", lastError: "unknown kind", lockedAt: null } });
          out.dead += 1;
          continue;
        }
        const kind = row.kind;
        // Debounce cancellation: an assignment read within the window is
        // SKIPPED, not sent (§6.18). Only a fan-out kind has one — a row
        // with no notification behind it has nothing that could be read.
        const spec = isNotificationKind(kind) ? NOTIFICATION_KINDS[kind] : null;
        if (spec?.email?.cancelledIfRead && row.notification_ids.length > 0) {
          const unread = await tx.notification.count({ where: { id: { in: row.notification_ids }, readAt: null } });
          if (unread === 0) {
            await tx.emailOutbox.update({ where: { id: row.id }, data: { status: "SKIPPED", lockedAt: null } });
            out.skipped += 1;
            continue;
          }
        }
        // Suppression re-checked at send (a bounce may have landed since enqueue).
        const suppressed = await tx.emailSuppression.findUnique({ where: { email: row.to_email } });
        if (suppressed) {
          await tx.emailOutbox.update({ where: { id: row.id }, data: { status: "SUPPRESSED", lockedAt: null } });
          out.suppressed += 1;
          continue;
        }
        // A member's SUMMARY (slice 100) is rendered from the rows it covers
        // that are STILL unread now — bodies at send time (§6.18) — so it
        // never reports news its reader has already opened, and one whose
        // rows have all been read since is SKIPPED, like a read assignment.
        let params = row.params;
        if (kind === MEMBER_DIGEST_MAIL) {
          const now = new Date();
          // Still WANTED, and still on time (the code review's low): a member
          // who chose Never — or no email at all — after it was made, a
          // suspended member or workspace, or a summary still unsent hours
          // after it was made (a retrying transport) is dropped, not sent:
          // "each morning", never in the afternoon.
          const member = standing.get(`${row.tenant_id}:${row.receiver_id}`);
          const pref = summaryPrefs.get(`${row.tenant_id}:${row.receiver_id}`);
          const wanted =
            member?.status === "ACTIVE" &&
            (DIGEST_SENDING_TENANT_STATUSES as readonly string[]).includes(member.tenantStatus) &&
            pref?.emailLevel !== "NONE" &&
            pref?.digestCadence !== "NONE";
          // Late is measured from the SUMMARY'S TIME (`params.dueAt`), else —
          // a row made without one — from its creation.
          const dueAt = typeof row.params?.["dueAt"] === "string" ? Date.parse(row.params["dueAt"]) : NaN;
          const from = Number.isFinite(dueAt) ? dueAt : new Date(row.created_at).getTime();
          const late = now.getTime() > from + (DIGEST_CATCH_UP_HOURS + DIGEST_SEND_GRACE_HOURS) * 3_600_000;
          if (!wanted || late) {
            // Tagged, so the next summary does not count from a summary
            // nobody received (`DIGEST_DROPPED_*`, src/notify/digest.ts).
            await tx.emailOutbox.update({
              where: { id: row.id },
              data: { status: "SKIPPED", lockedAt: null, lastError: late ? DIGEST_DROPPED_LATE : DIGEST_DROPPED_UNWANTED },
            });
            out.skipped += 1;
            continue;
          }
          const counts = await tx.notification.groupBy({
            by: ["kind"],
            where: {
              // The row's own receiver, a second belt: the ids came from the
              // job, but a summary must never count anyone else's inbox.
              tenantId: row.tenant_id,
              receiverType: "MEMBER",
              receiverId: row.receiver_id,
              id: { in: row.notification_ids },
              readAt: null,
              archivedAt: null,
              OR: [{ snoozedTill: null }, { snoozedTill: { lte: now } }],
            },
            _count: { _all: true },
          });
          if (counts.length === 0) {
            await tx.emailOutbox.update({ where: { id: row.id }, data: { status: "SKIPPED", lockedAt: null } });
            out.skipped += 1;
            continue;
          }
          params = { counts: Object.fromEntries(counts.map((c) => [c.kind, c._count._all])) };
        }
        try {
          const msg = renderEmail(kind, row.locale, params);
          toSend.push({ row, subject: msg.subject, text: msg.text });
        } catch (e) {
          const dead = row.attempts + 1 >= MAX_ATTEMPTS;
          await tx.emailOutbox.update({ where: { id: row.id }, data: failureData(row, e, dead) });
          out[dead ? "dead" : "failed"] += 1;
        }
      }
      return toSend;
    },
    // A one-tenant drain's audit row is THAT tenant's (TENANCY §12) — and so
    // a dbtest's goes with its throwaway tenant (the code review's low).
    { readOnly: false, ...(only ? { targetTenantId: only } : {}) },
  );

  // WHERE A REPLY GOES (slice 100, C68 (c), (f)): every outbox mail belongs
  // to a workspace, and carries that workspace's reply address — once per
  // workspace per drain, each under its OWN system principal, outside the
  // claim (its rows are leased). A workspace whose address cannot be read is
  // logged by name and code and its mail goes without one: a reply that
  // bounces is a smaller failure than a notice that never leaves.
  const replyTo = new Map<string, string | undefined>();
  for (const tenantId of new Set(prepared.map((p) => p.row.tenant_id))) {
    try {
      const address = await withTenant(tenantId, { type: "system" }, (tx) => resolveReplyAddress(tx, tenantId));
      replyTo.set(tenantId, address ?? undefined);
    } catch (e) {
      replyTo.set(tenantId, undefined);
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`outbox: reply address for tenant ${tenantId} unreadable: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }

  // One row's failure never blocks the next: each send + finalise is
  // isolated and every path below resolves to an outcome.
  for (const item of prepared) {
    // A security notice to the workspace's own members carries none: a reply
    // to it would go to an address an admin may have set
    // (`MAIL_WITHOUT_REPLY_TO`).
    const address = MAIL_WITHOUT_REPLY_TO.has(item.row.kind) ? undefined : replyTo.get(item.row.tenant_id);
    out[await sendAndFinalise(item, address, only)] += 1;
  }
  return out;
}

const failureData = (row: ClaimedRow, e: unknown, dead: boolean) => ({
  status: (dead ? "DEAD" : "FAILED") as "DEAD" | "FAILED",
  attempts: { increment: 1 },
  lastError: (e instanceof Error ? e.message : String(e)).slice(0, 500),
  // Exponential backoff: 1, 2, 4, 8 … minutes.
  sendAfter: new Date(Date.now() + 2 ** row.attempts * 60_000),
  lockedAt: null,
});

async function sendAndFinalise(
  { row, subject, text }: Prepared,
  replyTo: string | undefined,
  only: string | undefined,
): Promise<Outcome> {
  let sendError: unknown = null;
  try {
    await send({ to: row.to_email, subject, text, ...(replyTo ? { replyTo } : {}) });
  } catch (e) {
    sendError = e;
  }
  try {
    return await withPlatform(
      SYSTEM,
      `finalise outbox row ${row.id} (${row.kind})`,
      async (tx) => {
        if (sendError === null) {
          await tx.emailOutbox.update({
            where: { id: row.id },
            data: { status: "SENT", sentAt: new Date(), attempts: { increment: 1 }, lockedAt: null },
          });
          // `emailedAt` says the mail ABOUT that one notification went. A
          // summary is an overview of many (C68 (h)) and counts them by time
          // instead (`digestSince`), so it stamps nothing.
          if (row.notification_ids.length > 0 && row.kind !== MEMBER_DIGEST_MAIL) {
            await tx.notification.updateMany({
              where: { id: { in: row.notification_ids } },
              data: { emailedAt: new Date() },
            });
          }
          return "sent" as const;
        }
        const dead = row.attempts + 1 >= MAX_ATTEMPTS;
        await tx.emailOutbox.update({ where: { id: row.id }, data: failureData(row, sendError, dead) });
        return dead ? ("dead" as const) : ("failed" as const);
      },
      { readOnly: false, ...(only ? { targetTenantId: only } : {}) },
    );
  } catch {
    // The finalise itself failed (connection, timeout): the row stays
    // SENDING and the lease reclaim revisits it — at-least-once.
    return sendError === null ? "sent" : "failed";
  }
}
