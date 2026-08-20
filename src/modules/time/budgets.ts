import { record } from "@/audit/record";
import { assertInScope, isAuthorized } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { dateColumn, isoDateOf, localDateString } from "@/lib/duration";
import { fail } from "@/lib/domain-error";
import { emit } from "@/notify/emit";
import { readPreferences } from "@/preferences/service";

import { guarded, idsOnly, principalOf, type TimeCtx } from "./ctx";

/**
 * ProjectBudget + BudgetAlert (DATA_MODEL.md §6.15): an hours-or-money
 * budget per project, one ACTIVE at a time (partial unique), with
 * once-per-threshold alerts — the (budget, periodKey, threshold) unique
 * IS the dedupe, so the hourly job just INSERTs and a conflict means
 * "already sent". Retainer/hour-bank ledgers are Phase 4; RETAINER here
 * is intent + a cap. Budget figures reach the portal only through
 * ProjectTimeSummary when the project's hoursSharingMode allows.
 */

export type BudgetKind = "HOURS" | "MONEY";
export type BillingModel = "T_AND_M" | "FIXED_FEE" | "RETAINER" | "NON_BILLABLE";
export type BudgetPeriod = "NONE" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";

export type BudgetView = {
  id: string;
  projectId: string;
  kind: BudgetKind;
  billingModel: BillingModel;
  amount: string;
  currency: string | null;
  period: BudgetPeriod;
  periodAnchor: string | null;
  includeNonBillable: boolean;
  thresholds: number[];
  notifyMemberIds: string[];
  status: "ACTIVE" | "ARCHIVED";
};

export type BudgetBurn = {
  periodKey: string;
  periodStart: string | null;
  periodEnd: string | null;
  /** Seconds counted (billable only unless includeNonBillable). */
  seconds: number;
  /** Money budgets: Σ seconds/3600 × billRate of the counted entries. */
  amount: string | null;
  /** 0–∞ as a percentage of the budget amount. */
  percent: number;
};

const select = {
  id: true,
  projectId: true,
  kind: true,
  billingModel: true,
  amount: true,
  currency: true,
  period: true,
  periodAnchor: true,
  includeNonBillable: true,
  thresholds: true,
  notifyMemberIds: true,
  status: true,
} as const;

type Row = {
  id: string;
  projectId: string;
  kind: BudgetKind;
  billingModel: BillingModel;
  amount: { toString(): string };
  currency: string | null;
  period: BudgetPeriod;
  periodAnchor: Date | null;
  includeNonBillable: boolean;
  thresholds: number[];
  notifyMemberIds: string[];
  status: "ACTIVE" | "ARCHIVED";
};

const toView = (r: Row): BudgetView => ({
  id: r.id,
  projectId: r.projectId,
  kind: r.kind,
  billingModel: r.billingModel,
  amount: r.amount.toString(),
  currency: r.currency,
  period: r.period,
  periodAnchor: r.periodAnchor ? isoDateOf(r.periodAnchor) : null,
  includeNonBillable: r.includeNonBillable,
  thresholds: r.thresholds,
  notifyMemberIds: r.notifyMemberIds,
  status: r.status,
});

const AMOUNT_RE = /^\d{1,10}(?:[.,]\d{1,2})?$/;
const normalizeAmount = (raw: string): string => {
  const s = raw.trim().replace(",", ".");
  if (!AMOUNT_RE.test(s) || Number(s) <= 0) fail("INVALID_INPUT", "amount must be a positive number");
  return s;
};
const normalizeThresholds = (t: readonly number[] | undefined): number[] => {
  const out = [...new Set((t ?? [80, 100]).map((n) => Math.round(n)).filter((n) => n >= 1 && n <= 200))].sort((a, b) => a - b);
  if (out.length === 0 || out.length > 10) fail("INVALID_INPUT", "1–10 thresholds between 1 and 200");
  return out;
};

/** ISO week number + year for a calendar date. */
function isoWeek(isoDate: string): { year: number; week: number } {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/** The current period's key and [start, end] local dates (inclusive). */
export function currentPeriod(
  period: BudgetPeriod,
  today: string,
): { key: string; start: string | null; end: string | null } {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  switch (period) {
    case "NONE":
      return { key: "ALL", start: null, end: null };
    case "WEEKLY": {
      const { year, week } = isoWeek(today);
      const dt = new Date(Date.UTC(y, m - 1, d));
      const day = dt.getUTCDay() || 7;
      const monday = new Date(dt.getTime() - (day - 1) * 86_400_000);
      const sunday = new Date(monday.getTime() + 6 * 86_400_000);
      return { key: `${year}-W${String(week).padStart(2, "0")}`, start: iso(monday), end: iso(sunday) };
    }
    case "MONTHLY":
      return {
        key: `${y}-${String(m).padStart(2, "0")}`,
        start: iso(new Date(Date.UTC(y, m - 1, 1))),
        end: iso(new Date(Date.UTC(y, m, 0))),
      };
    case "QUARTERLY": {
      const q = Math.floor((m - 1) / 3);
      return {
        key: `${y}-Q${q + 1}`,
        start: iso(new Date(Date.UTC(y, q * 3, 1))),
        end: iso(new Date(Date.UTC(y, q * 3 + 3, 0))),
      };
    }
    case "YEARLY":
      return { key: String(y), start: `${y}-01-01`, end: `${y}-12-31` };
  }
}

/** Burn of one budget in its current period (inside an existing tx). */
export async function budgetBurn(tx: TenantDb, tenantId: string, budget: Row, today: string): Promise<BudgetBurn> {
  const p = currentPeriod(budget.period, today);
  const anchor = budget.periodAnchor ? isoDateOf(budget.periodAnchor) : null;
  const start = [p.start, anchor].filter((x): x is string => x !== null).sort().at(-1) ?? null;
  const rows = await tx.$queryRaw<{ seconds: number | null; amount: string | null }[]>`
    SELECT coalesce(sum(duration_seconds), 0)::int AS seconds,
           round(coalesce(sum(CASE WHEN billable THEN duration_seconds::numeric / 3600 * bill_rate END), 0), 2)::text AS amount
      FROM time_entry
     WHERE tenant_id = ${tenantId} AND project_id = ${budget.projectId}
       AND deleted_at IS NULL AND stopped_at IS NOT NULL
       AND (${budget.includeNonBillable} OR billable)
       AND (${start}::date IS NULL OR local_date >= ${start}::date)
       AND (${p.end}::date IS NULL OR local_date <= ${p.end}::date)`;
  const seconds = rows[0]?.seconds ?? 0;
  const amount = rows[0]?.amount ?? "0";
  const budgetAmount = Number(budget.amount.toString());
  const used = budget.kind === "HOURS" ? seconds / 3600 : Number(amount);
  const percent = budgetAmount > 0 ? Math.round((used / budgetAmount) * 1000) / 10 : 0;
  return {
    periodKey: p.key,
    periodStart: start,
    periodEnd: p.end,
    seconds,
    amount: budget.kind === "MONEY" ? amount : null,
    percent,
  };
}

/** budget:view — the project's ACTIVE budget and its burn (amounts only with rate:view_bill). */
export async function getProjectBudget(
  ctx: TimeCtx,
  projectId: string,
): Promise<{ budget: BudgetView; burn: BudgetBurn } | null> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "budget:view");
    await assertInScope(tx, ctx.actor, { projectId });
    const row = await tx.projectBudget.findFirst({
      where: { tenantId: ctx.tenantId, projectId, status: "ACTIVE" },
      select,
    });
    if (!row) return null;
    const prefs = await readPreferences(tx, ctx.tenantId);
    const burn = await budgetBurn(tx, ctx.tenantId, row, localDateString(new Date(), prefs.timezone));
    const canSeeMoney = await isAuthorized(tx, ctx.actor, "rate:view_bill");
    return {
      budget: toView(row),
      burn: canSeeMoney || row.kind === "HOURS" ? burn : { ...burn, amount: null },
    };
  });
}

export type BudgetInput = {
  projectId: string;
  kind: BudgetKind;
  billingModel?: BillingModel;
  amount: string;
  currency?: string | null;
  period?: BudgetPeriod;
  periodAnchor?: string | null;
  includeNonBillable?: boolean;
  thresholds?: readonly number[];
  notifyMemberIds?: readonly string[];
};

/** budget:manage — create (archiving the current ACTIVE one in the same tx). */
export async function createBudget(ctx: TimeCtx, input: BudgetInput): Promise<BudgetView> {
  const amount = normalizeAmount(input.amount);
  const thresholds = normalizeThresholds(input.thresholds);
  const period = input.period ?? "NONE";
  if (period !== "NONE" && !input.periodAnchor) fail("INVALID_INPUT", "periodAnchor required for a periodic budget");
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "budget:manage");
      await assertInScope(tx, ctx.actor, { projectId: input.projectId });
      const project = await tx.project.findFirst({
        where: { tenantId: ctx.tenantId, id: input.projectId },
        select: { clientId: true, billingCurrency: true },
      });
      if (!project) fail("INVALID_INPUT", "unknown project");
      const currency = input.kind === "MONEY" ? (input.currency ?? project!.billingCurrency ?? null) : null;
      if (input.kind === "MONEY" && !currency) fail("INVALID_INPUT", "currency required for a money budget");
      const current = await tx.projectBudget.findFirst({
        where: { tenantId: ctx.tenantId, projectId: input.projectId, status: "ACTIVE" },
        select: { id: true },
      });
      if (current) {
        await tx.projectBudget.update({ where: { id: current.id }, data: { status: "ARCHIVED" } });
        await record(tx, { action: "budget.changed", targetType: "ProjectBudget", targetId: current.id, metadata: { archived: true } });
      }
      const row = await tx.projectBudget.create({
        data: {
          tenantId: ctx.tenantId,
          clientId: project!.clientId,
          projectId: input.projectId,
          kind: input.kind,
          billingModel: input.billingModel ?? "T_AND_M",
          amount,
          currency,
          period,
          periodAnchor: input.periodAnchor ? dateColumn(input.periodAnchor) : null,
          includeNonBillable: input.includeNonBillable ?? false,
          thresholds,
          notifyMemberIds: [...(input.notifyMemberIds ?? [])],
          createdByMemberId: ctx.actor.memberId,
        },
        select,
      });
      await record(tx, {
        action: "budget.created",
        targetType: "ProjectBudget",
        targetId: row.id,
        metadata: idsOnly({ projectId: input.projectId, kind: input.kind, period }),
      });
      return toView(row);
    }),
  );
}

/** budget:manage — edit thresholds / notify list / amount / model of the ACTIVE budget. */
export async function updateBudget(
  ctx: TimeCtx,
  id: string,
  patch: Partial<Omit<BudgetInput, "projectId" | "kind">>,
): Promise<BudgetView> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "budget:manage");
      const existing = await tx.projectBudget.findFirst({ where: { tenantId: ctx.tenantId, id }, select });
      if (!existing) fail("INVALID_INPUT", "unknown budget");
      await assertInScope(tx, ctx.actor, { projectId: existing!.projectId });
      const data: Record<string, unknown> = {};
      if (patch.amount !== undefined) data["amount"] = normalizeAmount(patch.amount);
      if (patch.billingModel !== undefined) data["billingModel"] = patch.billingModel;
      if (patch.thresholds !== undefined) data["thresholds"] = normalizeThresholds(patch.thresholds);
      if (patch.notifyMemberIds !== undefined) data["notifyMemberIds"] = [...patch.notifyMemberIds];
      if (patch.includeNonBillable !== undefined) data["includeNonBillable"] = patch.includeNonBillable;
      if (patch.period !== undefined) data["period"] = patch.period;
      if (patch.periodAnchor !== undefined) data["periodAnchor"] = patch.periodAnchor ? dateColumn(patch.periodAnchor) : null;
      if (patch.currency !== undefined) data["currency"] = patch.currency;
      const row = await tx.projectBudget.update({ where: { id }, data, select });
      await record(tx, {
        action: "budget.changed",
        targetType: "ProjectBudget",
        targetId: id,
        metadata: { fields: Object.keys(data) },
      });
      return toView(row);
    }),
  );
}

/** budget:manage — archive the budget (no ACTIVE budget afterwards). */
export async function archiveBudget(ctx: TimeCtx, id: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "budget:manage");
    const existing = await tx.projectBudget.findFirst({ where: { tenantId: ctx.tenantId, id }, select });
    if (!existing) fail("INVALID_INPUT", "unknown budget");
    await assertInScope(tx, ctx.actor, { projectId: existing!.projectId });
    if (existing!.status === "ARCHIVED") return;
    await tx.projectBudget.update({ where: { id }, data: { status: "ARCHIVED" } });
    await record(tx, { action: "budget.changed", targetType: "ProjectBudget", targetId: id, metadata: { archived: true } });
  });
}

/**
 * The hourly job body (also lazily callable): for every ACTIVE budget of
 * the tenant, insert a BudgetAlert per crossed threshold — the unique
 * dedupes — and notify the budget's list (or the project lead) through
 * notify.emit (COALESCED kind; ids only). Runs under the SYSTEM principal.
 */
export async function checkBudgetAlerts(
  tenantId: string,
  now: Date = new Date(),
): Promise<{ checked: number; alerts: number }> {
  return withTenant(tenantId, { type: "system" }, async (tx) => {
    const prefs = await readPreferences(tx, tenantId);
    const today = localDateString(now, prefs.timezone);
    const budgets = await tx.projectBudget.findMany({ where: { tenantId, status: "ACTIVE" }, select });
    let alerts = 0;
    for (const b of budgets) {
      const burn = await budgetBurn(tx, tenantId, b, today);
      for (const threshold of b.thresholds) {
        if (burn.percent < threshold) continue;
        const { count } = await tx.budgetAlert.createMany({
          data: [{ tenantId, budgetId: b.id, periodKey: burn.periodKey, threshold }],
          skipDuplicates: true,
        });
        if (count === 0) continue; // already sent for this period + threshold
        alerts += 1;
        let receivers = b.notifyMemberIds;
        if (receivers.length === 0) {
          const project = await tx.project.findFirst({ where: { id: b.projectId }, select: { leadMemberId: true } });
          receivers = project?.leadMemberId ? [project.leadMemberId] : [];
        }
        const project = await tx.project.findFirst({ where: { id: b.projectId }, select: { clientId: true } });
        await emit(tx, tenantId, {
          kind: "budget.threshold_reached",
          entity: { type: "ProjectBudget", id: b.id },
          clientId: project?.clientId,
          projectId: b.projectId,
          memberIds: receivers,
          params: { projectId: b.projectId, budgetId: b.id, threshold: String(threshold), periodKey: burn.periodKey },
          dedupeKey: `budget:${b.id}:${burn.periodKey}:${threshold}`,
        });
        await record(tx, {
          action: "budget.alert_sent",
          targetType: "ProjectBudget",
          targetId: b.id,
          metadata: { threshold, periodKey: burn.periodKey, percent: burn.percent, receivers: receivers.length },
        });
      }
    }
    return { checked: budgets.length, alerts };
  });
}
