import { withPlatform } from "@/db";
import { UPDATE_REMINDER_SWEEP_DAYS, sendUpdateReminders } from "@/modules/work/update-reminders";
import { DIGEST_SENDING_TENANT_STATUSES } from "@/notify/digest";

/**
 * The progress-update reminders (Phase 5 slice 102; founder decision C70):
 * a project's lead — or its people who can publish — is told on the day its
 * update is due and on the next two working days, and again each later due
 * day while it stays missing. The per-tenant body — who hears, when, the
 * dedupe — is the work module's (`sendUpdateReminders`); this file only finds
 * the tenants worth opening.
 *
 * Discovery is the one audited cross-tenant read (`withPlatform`, read-only)
 * and carries ids only: SENDING tenants (not suspended, offboarding or closed
 * — the digests' set; the reviews' medium) with an ACTIVE, unarchived project
 * that has a cadence, and tenants holding dedupe rows old enough to sweep. Each tenant
 * then runs under its OWN system principal with RLS live, so nothing here can
 * mix two tenants' rows. Which day and hour it is for a tenant is decided
 * inside its own transaction, from its own preferences.
 *
 * ONE TENANT'S FAILURE DOES NOT SKIP THE REST: it is counted and logged — the
 * tenant's id and the error's name and code, never its message, which for a
 * Prisma error prints the query's arguments — and the next tenant runs.
 * Idempotent and hourly-safe: each reminder goes once, on its own day,
 * between 09:00 and 17:00 workspace time. Invoked by `POST /api/jobs/run`
 * until Vercel Cron exists.
 */

const DAY_MS = 86_400_000;

export async function runUpdateReminders(
  now: Date = new Date(),
): Promise<{ tenants: number; sent: number; unheard: number; failed: number }> {
  const tenantIds = await withPlatform(
    { type: "system", job: "update-reminders" },
    "list tenants with an active project on an update schedule, or update-reminder rows to sweep",
    async (tx) => {
      // In sequence: one transaction, one connection (AGENTS.md's trap).
      const scheduled = await tx.project.findMany({
        where: {
          status: "ACTIVE",
          archivedAt: null,
          updateCadence: { not: "NONE" },
          tenant: { status: { in: [...DIGEST_SENDING_TENANT_STATUSES] } },
        },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      // A day past the tenant's own sweep horizon in every zone.
      const stale = await tx.projectUpdateReminderSent.findMany({
        where: { dueOn: { lt: new Date(now.getTime() - (UPDATE_REMINDER_SWEEP_DAYS + 2) * DAY_MS) } },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      return [...new Set([...scheduled, ...stale].map((r) => r.tenantId))];
    },
  );

  const out = { tenants: tenantIds.length, sent: 0, unheard: 0, failed: 0 };
  for (const tenantId of tenantIds) {
    try {
      const r = await sendUpdateReminders(tenantId, now);
      out.sent += r.sent;
      out.unheard += r.unheard;
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`update-reminders: tenant ${tenantId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  return out;
}
