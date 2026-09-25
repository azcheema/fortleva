import type { TenantDb } from "@/db";
import { localDateString } from "@/lib/duration";
import { budgetBurn } from "@/modules/time/budgets";
import { billAmountOf, money } from "@/modules/time/ctx";
import type { EntryRow } from "@/modules/time/rollup";

import type { UpdateMetricsInclude } from "./update-body";
import type { ChangesSinceLast, HoursFigure, InternalSnapshot, MetricsWindow, PortalSnapshot } from "./update-snapshot";

export {
  PORTAL_SNAPSHOT_KEYS,
  changeIdsOf,
  foreignPortalSnapshotKeys,
  metricsWindowFor,
  redactHoursFor,
  withoutHours,
  type ChangeIds,
  type ChangesSinceLast,
  type HoursAccess,
  type HoursFigure,
  type InternalSnapshot,
  type MetricsWindow,
  type PortalSnapshot,
} from "./update-snapshot";

/**
 * THE MACHINE NUMBERS OF A PROGRESS UPDATE (DATA_MODEL.md §6.16), and
 * the file that decides which of them a CLIENT may ever read.
 *
 * Two snapshots, two tables, one rule. `computePortalSnapshot` builds
 * what is frozen onto the class-B `ProjectUpdate.portalSnapshot` — the
 * row a contact selects — and it is portal-safe BY CONSTRUCTION: every
 * query in it counts or names only rows the client can already see
 * (CLIENT_VISIBLE tasks, CLIENT_VISIBLE milestones, SHIPPED versions,
 * their own requests) and the hours block reads `time_entry` only as
 * aggregates with no member column, exactly as `project_time_summary`
 * does, and only when the project shares hours at all.
 * `computeInternalSnapshot` builds the class-A twin — per-member hours,
 * cost, margin, budget burn — which `portal_deny` keeps off the contact
 * plane whatever a projection does.
 *
 * The shapes, the allow-list and the window rule are the LEAF module
 * `update-snapshot.ts` (no database import, so the composer and the
 * unit test can reach them); this file holds the reads.
 */

export type ProjectForMetrics = {
  readonly id: string;
  readonly hoursSharingMode: "NONE" | "HOURS" | "BILLABLE_AMOUNT";
  readonly billingCurrency: string | null;
};

const between = (w: MetricsWindow) => ({ gte: w.from, lt: w.to });

/** The window's local calendar days, for the `local_date` column: inclusive both ends. */
const localDays = (w: MetricsWindow, timeZone: string) => ({
  from: localDateString(w.from, timeZone),
  // `to` is exclusive; the last local day inside it is the day of the instant just before.
  to: localDateString(new Date(w.to.getTime() - 1), timeZone),
});

type HoursRow = { seconds: number | null; billable_seconds: number | null; amount: string | null };

/**
 * Σ over closed entries of one project, NO member column, optionally
 * bounded by local days — the same aggregate shape `project_time_summary`
 * freezes monthly (`src/modules/time/summary.ts`), so the two portal
 * hours surfaces cannot disagree about what a "billable second" is.
 */
async function sumHours(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
  days: { from: string; to: string } | null,
): Promise<{ seconds: number; billableSeconds: number; amount: string }> {
  const from = days?.from ?? null;
  const to = days?.to ?? null;
  const rows = await tx.$queryRaw<HoursRow[]>`
    SELECT coalesce(sum(duration_seconds), 0)::int AS seconds,
           coalesce(sum(CASE WHEN billable THEN duration_seconds END), 0)::int AS billable_seconds,
           round(coalesce(sum(CASE WHEN billable THEN duration_seconds::numeric / 3600 * bill_rate END), 0), 2)::text AS amount
      FROM time_entry
     WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
       AND deleted_at IS NULL AND stopped_at IS NOT NULL
       AND (${from}::date IS NULL OR local_date >= ${from}::date)
       AND (${to}::date IS NULL OR local_date <= ${to}::date)`;
  return {
    seconds: rows[0]?.seconds ?? 0,
    billableSeconds: rows[0]?.billable_seconds ?? 0,
    amount: rows[0]?.amount ?? "0.00",
  };
}

/**
 * The portal-safe metrics, frozen at publish and shown live in the
 * composer's metrics card. Every read is sequential on the caller's one
 * connection (AGENTS.md's `Promise.all` trap).
 */
export async function computePortalSnapshot(
  tx: TenantDb,
  tenantId: string,
  project: ProjectForMetrics,
  window: MetricsWindow,
  include: UpdateMetricsInclude,
  timeZone: string,
  now: Date = new Date(),
): Promise<PortalSnapshot> {
  const projectId = project.id;
  const out: {
    -readonly [K in keyof PortalSnapshot]: PortalSnapshot[K];
  } = {
    version: 1,
    computedAt: now.toISOString(),
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
  };

  if (include.tasks) {
    // What the client's own list shows (`listPortalTasks`): live, shared,
    // not a request, not dropped. A count of INTERNAL work is not on
    // UI.md §11's never-list, but a number that disagrees with the list
    // under it is a number the client cannot trust.
    const live = {
      tenantId,
      projectId,
      deletedAt: null,
      archivedAt: null,
      visibility: "CLIENT_VISIBLE" as const,
      kind: { not: "REQUEST" as const },
      stateCategory: { not: "CANCELLED" as const },
    };
    const total = await tx.workItem.count({ where: live });
    const done = await tx.workItem.count({ where: { ...live, stateCategory: "DONE" } });
    const doneInPeriod = await tx.workItem.count({
      where: { ...live, stateCategory: "DONE", completedAt: between(window) },
    });
    out.tasks = { done, total, doneInPeriod };
  }

  if (include.milestones) {
    const rows = await tx.milestone.findMany({
      where: { tenantId, projectId, visibility: "CLIENT_VISIBLE", status: { not: "CANCELLED" } },
      select: { name: true, status: true, completedAt: true },
      orderBy: [{ completedAt: "asc" }, { rank: "asc" }],
    });
    out.milestones = {
      done: rows.filter((m) => m.status === "DONE").length,
      total: rows.length,
      hitInPeriod: rows
        .filter((m) => m.completedAt !== null && m.completedAt >= window.from && m.completedAt < window.to)
        .map((m) => m.name),
    };
  }

  if (include.versions) {
    const rows = await tx.projectVersion.findMany({
      where: { tenantId, projectId, status: "SHIPPED", shippedAt: between(window) },
      select: { version: true, title: true },
      orderBy: [{ shippedAt: "asc" }, { id: "asc" }],
    });
    out.versions = { shippedInPeriod: rows.map((v) => ({ version: v.version, title: v.title })) };
  }

  if (include.requests) {
    const request = { tenantId, projectId, deletedAt: null, kind: "REQUEST" as const, visibility: "CLIENT_VISIBLE" as const };
    const open = await tx.workItem.count({ where: { ...request, stateCategory: "TRIAGE" } });
    const acceptedInPeriod = await tx.workItem.count({ where: { ...request, acceptedAt: between(window) } });
    out.requests = { open, acceptedInPeriod };
  }

  if (include.hours && project.hoursSharingMode !== "NONE") {
    const mode = project.hoursSharingMode;
    const inPeriod = await sumHours(tx, tenantId, projectId, localDays(window, timeZone));
    const toDate = await sumHours(tx, tenantId, projectId, null);
    // The ACTIVE budgets, shared on the same rule as the monthly summary
    // row: an HOURS budget whenever hours are shared, a MONEY budget only
    // when amounts are.
    const budgets = await tx.projectBudget.findMany({
      where: { tenantId, projectId, status: "ACTIVE" },
      select: { kind: true, amount: true },
    });
    const hoursBudget = budgets.find((b) => b.kind === "HOURS") ?? null;
    const moneyBudget = mode === "BILLABLE_AMOUNT" ? (budgets.find((b) => b.kind === "MONEY") ?? null) : null;
    const figure = (f: { seconds: number; billableSeconds: number; amount: string }): HoursFigure => ({
      seconds: f.seconds,
      billableSeconds: f.billableSeconds,
      amount: mode === "BILLABLE_AMOUNT" ? f.amount : null,
    });
    out.hours = {
      mode,
      inPeriod: figure(inPeriod),
      toDate: figure(toDate),
      budgetSeconds: hoursBudget ? Math.round(Number(hoursBudget.amount.toString()) * 3600) : null,
      budgetAmount: moneyBudget ? money(Number(moneyBudget.amount.toString())) : null,
      currency: project.billingCurrency,
    };
  }

  return out;
}

export type InternalSnapshotInputs = {
  /** The window's closed entries with their labels — `loadProjectEntries`; null when the publisher may not see team time. */
  readonly entries: readonly EntryRow[] | null;
  /** Revealed COST rates by card id — null unless the publisher held rate:view_cost ✦ and the reveal ran. */
  readonly costOf: Readonly<Record<string, string>> | null;
  /** The ACTIVE budget row, or null when there is none or the publisher may not see budgets. */
  readonly budget: Parameters<typeof budgetBurn>[2] | null;
  /** Whether bill amounts may be written (rate:view_bill). */
  readonly withAmounts: boolean;
  readonly currency: string | null;
};

/**
 * The staff-only twin. Pure over its inputs except for the budget burn,
 * which is one aggregate query. The inputs are gathered by the service,
 * because two of them (the cost reveal, the permission answers) are not
 * this file's to decide.
 */
export async function computeInternalSnapshot(
  tx: TenantDb,
  tenantId: string,
  inputs: InternalSnapshotInputs,
  today: string,
): Promise<InternalSnapshot> {
  let byMember: InternalSnapshot["byMember"] = null;
  if (inputs.entries) {
    const buckets = new Map<string, { name: string; seconds: number; billableSeconds: number }>();
    for (const r of inputs.entries) {
      const b = buckets.get(r.memberId) ?? { name: r.memberName, seconds: 0, billableSeconds: 0 };
      b.seconds += r.durationSeconds;
      if (r.billable) b.billableSeconds += r.durationSeconds;
      buckets.set(r.memberId, b);
    }
    byMember = [...buckets.entries()]
      .map(([memberId, b]) => ({ memberId, name: b.name, seconds: b.seconds, billableSeconds: b.billableSeconds }))
      .sort((a, b) => b.seconds - a.seconds || a.memberId.localeCompare(b.memberId));
  }

  let cost: InternalSnapshot["cost"] = null;
  if (inputs.entries && inputs.costOf) {
    let value = 0;
    let costSum = 0;
    let uncosted = 0;
    for (const r of inputs.entries) {
      value += billAmountOf(r);
      const rate = r.costRateCardId ? inputs.costOf[r.costRateCardId] : undefined;
      if (rate !== undefined) costSum += (r.durationSeconds / 3600) * Number(rate);
      else uncosted += r.durationSeconds;
    }
    const margin = value - costSum;
    cost = {
      cost: money(costSum),
      value: money(value),
      margin: money(margin),
      marginPercent: value > 0 ? Math.round((margin / value) * 1000) / 10 : null,
      currency: inputs.currency,
      uncostedSeconds: uncosted,
    };
  }

  let budget: InternalSnapshot["budget"] = null;
  if (inputs.budget) {
    const burn = await budgetBurn(tx, tenantId, inputs.budget, today);
    budget = {
      kind: inputs.budget.kind,
      amount: inputs.budget.amount.toString(),
      currency: inputs.budget.currency,
      periodKey: burn.periodKey,
      usedSeconds: burn.seconds,
      usedAmount: inputs.budget.kind === "MONEY" && inputs.withAmounts ? burn.amount : null,
      usedPercent: burn.percent,
    };
  }

  return { version: 1, byMember, cost, budget };
}

/**
 * What happened since the last update, for the composer's pull-in panel
 * (see `ChangesSinceLast`). Staff-only: INTERNAL rows are listed with
 * their visibility so the author knows what they are about to publish.
 */
export async function readChanges(
  tx: TenantDb,
  tenantId: string,
  project: { readonly id: string; readonly key: string },
  window: MetricsWindow,
): Promise<ChangesSinceLast> {
  const projectId = project.id;
  const done = await tx.workItem.findMany({
    where: {
      tenantId,
      projectId,
      deletedAt: null,
      // Archived work is off the board and out of the counts above; a
      // line the panel offers must be one the numbers agree with.
      archivedAt: null,
      kind: { not: "REQUEST" },
      stateCategory: "DONE",
      completedAt: between(window),
    },
    select: { id: true, number: true, title: true, visibility: true },
    orderBy: [{ completedAt: "asc" }, { id: "asc" }],
    take: 200,
  });
  const milestones = await tx.milestone.findMany({
    where: { tenantId, projectId, status: "DONE", completedAt: between(window) },
    select: { id: true, name: true, visibility: true },
    orderBy: [{ completedAt: "asc" }, { id: "asc" }],
  });
  const versions = await tx.projectVersion.findMany({
    where: { tenantId, projectId, status: "SHIPPED", shippedAt: between(window) },
    select: { id: true, version: true, title: true },
    orderBy: [{ shippedAt: "asc" }, { id: "asc" }],
  });
  const requests = await tx.workItem.findMany({
    where: { tenantId, projectId, deletedAt: null, kind: "REQUEST", createdAt: between(window) },
    select: { id: true, number: true, title: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
  });
  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    doneItems: done.map((i) => ({ id: i.id, key: `${project.key}-${i.number}`, title: i.title, visibility: i.visibility })),
    milestonesHit: milestones.map((m) => ({ id: m.id, name: m.name, visibility: m.visibility })),
    versionsShipped: versions.map((v) => ({ id: v.id, version: v.version, title: v.title })),
    requestsReceived: requests.map((r) => ({ id: r.id, key: `${project.key}-${r.number}`, title: r.title })),
  };
}
