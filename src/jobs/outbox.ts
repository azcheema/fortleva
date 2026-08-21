import { withPlatform } from "@/db";
import { send } from "@/mailer";
import { isNotificationKind, NOTIFICATION_KINDS } from "@/notify/catalog";
import { renderEmail } from "@/notify/templates";

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
  kind: string;
  locale: string;
  to_email: string;
  params: Record<string, unknown> | null;
  notification_ids: string[];
  attempts: number;
};

type Outcome = "sent" | "skipped" | "suppressed" | "failed" | "dead";
type Prepared = { row: ClaimedRow; subject: string; text: string };

const SYSTEM = { type: "system", job: "outbox" } as const;

export async function drainOutbox(
  limit = 50,
): Promise<{ sent: number; skipped: number; suppressed: number; failed: number; dead: number }> {
  const out = { sent: 0, skipped: 0, suppressed: 0, failed: 0, dead: 0 };

  const prepared = await withPlatform(
    SYSTEM,
    "claim due email_outbox rows (FOR UPDATE SKIP LOCKED) and resolve them",
    async (tx) => {
      const claimed = await tx.$queryRaw<ClaimedRow[]>`
        UPDATE email_outbox SET status = 'SENDING', locked_at = now(), updated_at = now()
        WHERE id IN (
          SELECT id FROM email_outbox
          WHERE (status IN ('QUEUED', 'FAILED') AND send_after <= now())
             OR (status = 'SENDING' AND locked_at < now() - make_interval(mins => ${LEASE_MINUTES}))
          ORDER BY send_after
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, kind, locale, to_email, params, notification_ids, attempts`;
      const toSend: Prepared[] = [];
      for (const row of claimed) {
        if (!isNotificationKind(row.kind)) {
          await tx.emailOutbox.update({ where: { id: row.id }, data: { status: "DEAD", lastError: "unknown kind", lockedAt: null } });
          out.dead += 1;
          continue;
        }
        const kind = row.kind;
        const spec = NOTIFICATION_KINDS[kind];
        // Debounce cancellation: an assignment read within the window is
        // SKIPPED, not sent (§6.18).
        if (spec.email?.cancelledIfRead && row.notification_ids.length > 0) {
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
        try {
          const msg = renderEmail(kind, row.locale, row.params);
          toSend.push({ row, subject: msg.subject, text: msg.text });
        } catch (e) {
          const dead = row.attempts + 1 >= MAX_ATTEMPTS;
          await tx.emailOutbox.update({ where: { id: row.id }, data: failureData(row, e, dead) });
          out[dead ? "dead" : "failed"] += 1;
        }
      }
      return toSend;
    },
    { readOnly: false },
  );

  // One row's failure never blocks the next: each send + finalise is
  // isolated and every path below resolves to an outcome.
  for (const item of prepared) {
    out[await sendAndFinalise(item)] += 1;
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

async function sendAndFinalise({ row, subject, text }: Prepared): Promise<Outcome> {
  let sendError: unknown = null;
  try {
    await send({ to: row.to_email, subject, text });
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
          if (row.notification_ids.length > 0) {
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
      { readOnly: false },
    );
  } catch {
    // The finalise itself failed (connection, timeout): the row stays
    // SENDING and the lease reclaim revisits it — at-least-once.
    return sendError === null ? "sent" : "failed";
  }
}
