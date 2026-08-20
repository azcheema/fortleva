import { randomUUID } from "node:crypto";

import type { TenantDb } from "@/db";
import { isoDateOf, monthStartOf } from "@/lib/duration";

/**
 * ProjectTimeSummary maintenance (DATA_MODEL.md §6.15): the ONLY live
 * portal time surface is RECOMPUTED — never delta-upserted — for the
 * touched (project, month) in the SAME transaction as every time_entry
 * write. A full month of one project is a few hundred rows; a delta
 * drifts on every edge (cross-month edit, delete of a running entry,
 * reprice). The row has no member column by construction; visibility
 * and billable_amount nulling are stamped by trigger from the project's
 * hoursSharingMode; budget columns are copied from the ACTIVE budget
 * only when the mode shares them (fail-closed).
 */

export type SummaryTouch = { projectId: string | null; localDate: Date };

/** Recompute one (project, month). `monthStart` = "YYYY-MM-01". */
export async function recomputeProjectMonth(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
  monthStart: string,
): Promise<void> {
  const id = randomUUID();
  await tx.$executeRaw`
    INSERT INTO project_time_summary
      (id, tenant_id, client_id, project_id, period_month,
       billable_seconds, non_billable_seconds, billable_amount, currency,
       budget_seconds, budget_amount, computed_at)
    SELECT ${id}, p.tenant_id, p.client_id, p.id, ${monthStart}::date,
           coalesce(sum(CASE WHEN e.billable THEN e.duration_seconds END), 0)::int,
           coalesce(sum(CASE WHEN NOT e.billable THEN e.duration_seconds END), 0)::int,
           CASE WHEN p.hours_sharing_mode = 'BILLABLE_AMOUNT'
                THEN round(sum(CASE WHEN e.billable THEN e.duration_seconds::numeric / 3600 * e.bill_rate END), 2)
                ELSE NULL END,
           p.billing_currency,
           CASE WHEN p.hours_sharing_mode <> 'NONE'
                THEN (SELECT round(b.amount * 3600)::int FROM project_budget b
                       WHERE b.tenant_id = p.tenant_id AND b.project_id = p.id
                         AND b.status = 'ACTIVE' AND b.kind = 'HOURS')
                ELSE NULL END,
           CASE WHEN p.hours_sharing_mode = 'BILLABLE_AMOUNT'
                THEN (SELECT b.amount FROM project_budget b
                       WHERE b.tenant_id = p.tenant_id AND b.project_id = p.id
                         AND b.status = 'ACTIVE' AND b.kind = 'MONEY')
                ELSE NULL END,
           now()
      FROM project p
      LEFT JOIN time_entry e
        ON e.tenant_id = p.tenant_id AND e.project_id = p.id
       AND e.deleted_at IS NULL AND e.stopped_at IS NOT NULL
       AND e.local_date >= ${monthStart}::date
       AND e.local_date <  (${monthStart}::date + interval '1 month')
     WHERE p.tenant_id = ${tenantId} AND p.id = ${projectId}
     GROUP BY p.tenant_id, p.client_id, p.id, p.hours_sharing_mode, p.billing_currency
    ON CONFLICT (tenant_id, project_id, period_month) DO UPDATE SET
      billable_seconds     = EXCLUDED.billable_seconds,
      non_billable_seconds = EXCLUDED.non_billable_seconds,
      billable_amount      = EXCLUDED.billable_amount,
      currency             = EXCLUDED.currency,
      budget_seconds       = EXCLUDED.budget_seconds,
      budget_amount        = EXCLUDED.budget_amount,
      computed_at          = EXCLUDED.computed_at`;
}

/** Recompute every distinct (project, month) a write touched (ad-hoc rows touch nothing). */
export async function recomputeTouched(
  tx: TenantDb,
  tenantId: string,
  touches: readonly SummaryTouch[],
): Promise<void> {
  const seen = new Set<string>();
  for (const t of touches) {
    if (!t.projectId) continue;
    const month = monthStartOf(isoDateOf(t.localDate));
    const key = `${t.projectId}:${month}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await recomputeProjectMonth(tx, tenantId, t.projectId, month);
  }
}
