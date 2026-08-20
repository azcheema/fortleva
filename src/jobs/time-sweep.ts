import { withPlatform } from "@/db";
import { checkBudgetAlerts } from "@/modules/time/budgets";
import { settleTenant } from "@/modules/time/settle";

/**
 * The time module's cron bodies (ARC-21; PLAN.md Phase 2T "Services"):
 *  - `*\/15` timer/shift watch — the 12 h entry auto-stop and the 14 h
 *    shift auto-stop; identical to the lazy per-member settle the reads
 *    already apply, so the cron only catches members who never came back;
 *  - hourly budget alerts — once per (budget, period, threshold).
 * Cross-tenant discovery runs under withPlatform (the one audited
 * cross-tenant entry point); each tenant's work then runs under that
 * tenant's SYSTEM principal with RLS fully active. Invoked by Vercel
 * Cron (Pro) later; today by POST /api/jobs/run.
 */

export async function runTimeSweep(
  now: Date = new Date(),
): Promise<{ tenants: number; autoStoppedEntries: number; autoStoppedShifts: number }> {
  const tenantIds = await withPlatform(
    { type: "system", job: "time-sweep" },
    "list tenants with an open time entry or shift",
    async (tx) => {
      const [entries, shifts] = await Promise.all([
        tx.timeEntry.findMany({ where: { stoppedAt: null, deletedAt: null }, select: { tenantId: true }, distinct: ["tenantId"] }),
        tx.shift.findMany({ where: { stoppedAt: null, deletedAt: null }, select: { tenantId: true }, distinct: ["tenantId"] }),
      ]);
      return [...new Set([...entries, ...shifts].map((r) => r.tenantId))];
    },
  );
  const out = { tenants: tenantIds.length, autoStoppedEntries: 0, autoStoppedShifts: 0 };
  for (const tenantId of tenantIds) {
    const r = await settleTenant(tenantId, now);
    out.autoStoppedEntries += r.autoStoppedEntries;
    out.autoStoppedShifts += r.autoStoppedShifts;
  }
  return out;
}

export async function runBudgetAlerts(
  now: Date = new Date(),
): Promise<{ tenants: number; checked: number; alerts: number }> {
  const tenantIds = await withPlatform(
    { type: "system", job: "budget-alerts" },
    "list tenants with an ACTIVE project budget",
    async (tx) =>
      (await tx.projectBudget.findMany({ where: { status: "ACTIVE" }, select: { tenantId: true }, distinct: ["tenantId"] })).map(
        (r) => r.tenantId,
      ),
  );
  const out = { tenants: tenantIds.length, checked: 0, alerts: 0 };
  for (const tenantId of tenantIds) {
    const r = await checkBudgetAlerts(tenantId, now);
    out.checked += r.checked;
    out.alerts += r.alerts;
  }
  return out;
}
