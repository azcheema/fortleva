import { withPlatform } from "@/db";
import { sendExpirationReminders } from "@/modules/vault";

/**
 * The daily renewal reminders (Phase 3V slice 89; ARCHITECTURE.md §5's
 * `reminders` job): at 60 / 30 / 14 / 7 / 1 days before an asset's renewal
 * date, an agreement's END (founder decision C55) and a login's expiry
 * (C56, as a count per client). The per-tenant body — who hears, what is
 * sent, the dedupe — is the vault's (`sendExpirationReminders`); this file
 * only finds the tenants worth opening.
 *
 * Discovery is the one audited cross-tenant read (`withPlatform`, read-only)
 * and carries ids only. Each tenant then runs under its OWN system
 * principal with RLS live, so nothing here can mix two tenants' rows. The
 * window is two days wider than any zone's "today" on either side: which
 * day it is for a tenant is decided inside its own transaction, from its
 * own preferences. Tenants holding a dedupe row whose day has passed are
 * opened too, with nothing due: that run's only work is the sweep, which
 * would otherwise never reach a tenant whose last date left the window
 * (the code review's low — a renewed or deleted domain's rows would stay).
 *
 * ONE TENANT'S FAILURE DOES NOT SKIP THE REST. The job runs once a day, so
 * a single tenant whose run throws would otherwise silence every tenant
 * after it in the list, every day, until somebody read a log. It is
 * counted and logged — the tenant's id and the error's name and code, never
 * its message, which for a Prisma error prints the query's arguments (the
 * outbox's addresses among them; the security review) — and the next
 * tenant runs. Idempotent: the next run sends whatever this one did not
 * (`ExpirationReminderSent`).
 * Invoked by `POST /api/jobs/run` until Vercel Cron exists.
 */

const DAY_MS = 86_400_000;
/** The furthest band (60 days) plus a day either side for zones. */
const LOOK_AHEAD_DAYS = 62;

export async function runExpirationReminders(
  now: Date = new Date(),
): Promise<{ tenants: number; assets: number; agreements: number; logins: number; failed: number }> {
  const window = { gte: new Date(now.getTime() - 2 * DAY_MS), lt: new Date(now.getTime() + LOOK_AHEAD_DAYS * DAY_MS) };
  const tenantIds = await withPlatform(
    { type: "system", job: "expiration-reminders" },
    "list tenants with an asset, agreement end or login expiry inside the reminder window, or a reminder row to sweep",
    async (tx) => {
      // In sequence: one transaction, one connection (AGENTS.md's trap).
      const assets = await tx.clientAsset.findMany({
        where: { status: "ACTIVE", expiresAt: window },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      const agreements = await tx.service.findMany({
        where: { status: { not: "ENDED" }, endsAt: window },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      const logins = await tx.credentialItem.findMany({
        where: { deletedAt: null, expiresAt: window },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      // The tenant's own sweep deletes days before its yesterday; three days
      // back is past that in every zone, so a tenant opened only to sweep
      // always has something to sweep (the fix-pass review).
      const stale = await tx.expirationReminderSent.findMany({
        where: { dueOn: { lt: new Date(now.getTime() - 3 * DAY_MS) } },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      return [...new Set([...assets, ...agreements, ...logins, ...stale].map((r) => r.tenantId))];
    },
  );

  const out = { tenants: tenantIds.length, assets: 0, agreements: 0, logins: 0, failed: 0 };
  for (const tenantId of tenantIds) {
    try {
      const r = await sendExpirationReminders(tenantId, now);
      out.assets += r.assets;
      out.agreements += r.agreements;
      out.logins += r.logins;
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`expiration-reminders: tenant ${tenantId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  return out;
}
