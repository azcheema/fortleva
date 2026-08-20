import { withPlatform } from "@/db";
import { send } from "@/mailer";
import { isNotificationKind, NOTIFICATION_KINDS } from "@/notify/catalog";
import { renderEmail } from "@/notify/templates";

/**
 * The outbox drain (ARC-21; §6.18): claims QUEUED/FAILED rows with
 * FOR UPDATE SKIP LOCKED under the platform system principal, sends
 * through the one mailer adapter, finalises per row. Invoked by a
 * Vercel Cron every 2 minutes (Pro) later; today by after() kicks and
 * the authenticated POST /api/jobs/run. Safe to run concurrently — the
 * claim is the lock. withPlatform writes the platform audit event for
 * the run (TENANCY §12: one summary event, not one per row).
 */

const MAX_ATTEMPTS = 8;

type ClaimedRow = {
  id: string;
  kind: string;
  locale: string;
  to_email: string;
  params: Record<string, unknown> | null;
  notification_ids: string[];
  attempts: number;
};

export async function drainOutbox(
  limit = 50,
): Promise<{ sent: number; skipped: number; suppressed: number; failed: number; dead: number }> {
  const out = { sent: 0, skipped: 0, suppressed: 0, failed: 0, dead: 0 };

  const claimed = await withPlatform(
    { type: "system", job: "outbox" },
    "claim due email_outbox rows (FOR UPDATE SKIP LOCKED)",
    async (tx) => {
      return tx.$queryRaw<ClaimedRow[]>`
        UPDATE email_outbox SET status = 'SENDING', locked_at = now(), updated_at = now()
        WHERE id IN (
          SELECT id FROM email_outbox
          WHERE status IN ('QUEUED', 'FAILED') AND send_after <= now()
          ORDER BY send_after
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, kind, locale, to_email, params, notification_ids, attempts`;
    },
    { readOnly: false },
  );
  if (claimed.length === 0) return out;

  for (const row of claimed) {
    const outcome = await deliver(row);
    out[outcome] += 1;
  }
  return out;
}

async function deliver(
  row: ClaimedRow,
): Promise<"sent" | "skipped" | "suppressed" | "failed" | "dead"> {
  return withPlatform(
    { type: "system", job: "outbox" },
    `deliver outbox row ${row.id} (${row.kind})`,
    async (tx) => {
      if (!isNotificationKind(row.kind)) {
        await tx.emailOutbox.update({
          where: { id: row.id },
          data: { status: "DEAD", lastError: "unknown kind" },
        });
        return "dead";
      }
      const kind = row.kind;
      const spec = NOTIFICATION_KINDS[kind];
      // Debounce cancellation: an assignment read within the window is
      // SKIPPED, not sent (§6.18).
      if (spec.email?.cancelledIfRead && row.notification_ids.length > 0) {
        const unread = await tx.notification.count({
          where: { id: { in: row.notification_ids }, readAt: null },
        });
        if (unread === 0) {
          await tx.emailOutbox.update({ where: { id: row.id }, data: { status: "SKIPPED" } });
          return "skipped";
        }
      }
      // Suppression re-checked at send (a bounce may have landed since enqueue).
      const suppressed = await tx.emailSuppression.findUnique({ where: { email: row.to_email } });
      if (suppressed) {
        await tx.emailOutbox.update({ where: { id: row.id }, data: { status: "SUPPRESSED" } });
        return "suppressed";
      }
      try {
        const msg = renderEmail(kind, row.locale, row.params);
        await send({ to: row.to_email, subject: msg.subject, text: msg.text });
        await tx.emailOutbox.update({
          where: { id: row.id },
          data: { status: "SENT", sentAt: new Date(), attempts: { increment: 1 } },
        });
        if (row.notification_ids.length > 0) {
          await tx.notification.updateMany({
            where: { id: { in: row.notification_ids } },
            data: { emailedAt: new Date() },
          });
        }
        return "sent";
      } catch (e) {
        const dead = row.attempts + 1 >= MAX_ATTEMPTS;
        await tx.emailOutbox.update({
          where: { id: row.id },
          data: {
            status: dead ? "DEAD" : "FAILED",
            attempts: { increment: 1 },
            lastError: e instanceof Error ? e.message.slice(0, 500) : String(e),
            // Exponential backoff: 1, 2, 4, 8 … minutes.
            sendAfter: new Date(Date.now() + 2 ** row.attempts * 60_000),
            lockedAt: null,
          },
        });
        return dead ? "dead" : "failed";
      }
    },
    { readOnly: false },
  );
}
