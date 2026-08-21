import { assertInScope, isAuthorized, scopeWhere } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { dateColumn, isoDateOf } from "@/lib/duration";
import { fail } from "@/lib/domain-error";

import { billAmountOf, money, principalOf, sumBillAmount, type TimeCtx } from "./ctx";

/**
 * Rollups (DATA_MODEL.md §6.15; plan §3.3): flat SUMs over time_entry by
 * project / item / epic / client / agreement / work type × member / total
 * × date range. No RollupCache — a few hundred rows per project-month
 * sum instantly. Money: bill amounts are Σ seconds/3600 × bill_rate and
 * appear only with rate:view_bill; COST is never summed here — the cost
 * aggregation is SUM(seconds) GROUP BY cost_rate_card_id → rates.ts
 * revealCostRates (✦ + fresh factor), kept out of every CSV by default.
 */

export type Range = { from: string; to: string };

const rangeWhere = (r: Range) => ({ gte: dateColumn(r.from), lte: dateColumn(r.to) });
const hours2 = (seconds: number) => Math.round((seconds / 3600) * 100) / 100;

export type RollupLine = {
  key: string;
  label: string;
  seconds: number;
  billableSeconds: number;
  /** Only with rate:view_bill; null otherwise. */
  amount: string | null;
};

export type ProjectRollup = {
  projectId: string;
  range: Range;
  currency: string | null;
  totals: { seconds: number; billableSeconds: number; amount: string | null; estimateMinutes: number | null };
  byMember: (RollupLine & { weeks: Record<string, number> })[];
  byItem: (RollupLine & { epicKey: string | null })[];
  byEpic: RollupLine[];
  byAgreement: RollupLine[];
  byWorkType: RollupLine[];
  /** Members' cost-card ids + seconds — the input of the ✦ cost aggregation, never amounts. */
  costBuckets: { costRateCardId: string | null; seconds: number }[];
};

export type EntryRow = {
  memberId: string;
  memberName: string;
  workItemId: string | null;
  itemKey: string | null;
  itemTitle: string | null;
  rootId: string | null;
  rootKey: string | null;
  rootTitle: string | null;
  serviceId: string | null;
  serviceName: string | null;
  workTypeId: string | null;
  workTypeName: string | null;
  costRateCardId: string | null;
  localDate: Date;
  durationSeconds: number;
  billable: boolean;
  billRate: { toString(): string } | null;
  currency: string | null;
};

/** Closed entries of one project in a local-date range, with the labels every money/rollup view groups by. Shared with money.ts. */
export async function loadProjectEntries(tx: TenantDb, tenantId: string, projectId: string, range: Range): Promise<EntryRow[]> {
  const rows = await tx.timeEntry.findMany({
    where: { tenantId, projectId, deletedAt: null, stoppedAt: { not: null }, localDate: rangeWhere(range) },
    select: {
      memberId: true,
      workItemId: true,
      serviceId: true,
      workTypeId: true,
      costRateCardId: true,
      localDate: true,
      durationSeconds: true,
      billable: true,
      billRate: true,
      currency: true,
      member: { select: { user: { select: { name: true } } } },
      workItem: {
        select: {
          number: true,
          title: true,
          rootId: true,
          project: { select: { key: true } },
        },
      },
      service: { select: { name: true } },
      workType: { select: { name: true } },
    },
  });
  // Resolve epic (root) titles in one query.
  const rootIds = [...new Set(rows.map((r) => r.workItem?.rootId).filter((x): x is string => !!x))];
  const roots = rootIds.length
    ? await tx.workItem.findMany({
        where: { tenantId, id: { in: rootIds } },
        select: { id: true, number: true, title: true, project: { select: { key: true } } },
      })
    : [];
  const rootById = new Map(roots.map((r) => [r.id, r]));
  return rows.map((r) => {
    const root = r.workItem?.rootId ? rootById.get(r.workItem.rootId) : undefined;
    return {
      memberId: r.memberId,
      memberName: r.member.user.name,
      workItemId: r.workItemId,
      itemKey: r.workItem ? `${r.workItem.project.key}-${r.workItem.number}` : null,
      itemTitle: r.workItem?.title ?? null,
      rootId: r.workItem?.rootId ?? null,
      rootKey: root ? `${root.project.key}-${root.number}` : null,
      rootTitle: root?.title ?? null,
      serviceId: r.serviceId,
      serviceName: r.service?.name ?? null,
      workTypeId: r.workTypeId,
      workTypeName: r.workType?.name ?? null,
      costRateCardId: r.costRateCardId,
      localDate: r.localDate,
      durationSeconds: r.durationSeconds ?? 0,
      billable: r.billable,
      billRate: r.billRate,
      currency: r.currency,
    };
  });
}

const amountOf = (rows: EntryRow[]): number => sumBillAmount(rows);

function group<K extends string | null>(
  rows: EntryRow[],
  keyOf: (r: EntryRow) => K,
  labelOf: (r: EntryRow) => string,
  withAmounts: boolean,
  fallbackKey = "__none",
  fallbackLabel = "",
): (RollupLine & { _rows: EntryRow[] })[] {
  const buckets = new Map<string, { label: string; rows: EntryRow[] }>();
  for (const r of rows) {
    const k = keyOf(r) ?? fallbackKey;
    const b = buckets.get(k) ?? { label: keyOf(r) === null ? fallbackLabel : labelOf(r), rows: [] };
    b.rows.push(r);
    buckets.set(k, b);
  }
  return [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      label: b.label,
      seconds: b.rows.reduce((s, r) => s + r.durationSeconds, 0),
      billableSeconds: b.rows.filter((r) => r.billable).reduce((s, r) => s + r.durationSeconds, 0),
      amount: withAmounts ? money(amountOf(b.rows)) : null,
      _rows: b.rows,
    }))
    .sort((a, b) => b.seconds - a.seconds);
}

const isoWeekKey = (d: Date): string => {
  const dt = new Date(d.getTime());
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};

/** time:view_team + scope — the project Time tab (totals, member × week, item/epic, agreement, work type). */
export async function projectRollup(ctx: TimeCtx, projectId: string, range: Range): Promise<ProjectRollup> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:view_team");
    await assertInScope(tx, ctx.actor, { projectId });
    const [project, canSeeMoney] = await Promise.all([
      tx.project.findFirst({ where: { tenantId: ctx.tenantId, id: projectId }, select: { billingCurrency: true } }),
      isAuthorized(tx, ctx.actor, "rate:view_bill"),
    ]);
    if (!project) fail("INVALID_INPUT", "unknown project");
    const rows = await loadProjectEntries(tx, ctx.tenantId, projectId, range);
    const estimate = await tx.workItem.aggregate({
      where: { tenantId: ctx.tenantId, projectId, deletedAt: null, archivedAt: null },
      _sum: { estimateMinutes: true },
    });
    const strip = (l: RollupLine & { _rows: EntryRow[] }): RollupLine => ({
      key: l.key,
      label: l.label,
      seconds: l.seconds,
      billableSeconds: l.billableSeconds,
      amount: l.amount,
    });
    const byMember = group(rows, (r) => r.memberId, (r) => r.memberName, canSeeMoney).map((l) => ({
      ...strip(l),
      weeks: l._rows.reduce<Record<string, number>>((acc, r) => {
        const k = isoWeekKey(r.localDate);
        acc[k] = (acc[k] ?? 0) + r.durationSeconds;
        return acc;
      }, {}),
    }));
    const byItem = group(rows, (r) => r.workItemId, (r) => `${r.itemKey} ${r.itemTitle}`, canSeeMoney, "__project", "").map(
      (l) => ({ ...strip(l), epicKey: l._rows[0]?.rootKey ?? null }),
    );
    return {
      projectId,
      range,
      currency: project!.billingCurrency,
      totals: {
        seconds: rows.reduce((s, r) => s + r.durationSeconds, 0),
        billableSeconds: rows.filter((r) => r.billable).reduce((s, r) => s + r.durationSeconds, 0),
        amount: canSeeMoney ? money(amountOf(rows)) : null,
        estimateMinutes: estimate._sum.estimateMinutes ?? null,
      },
      byMember,
      byItem,
      byEpic: group(rows, (r) => r.rootId, (r) => `${r.rootKey} ${r.rootTitle}`, canSeeMoney, "__project", "").map(strip),
      byAgreement: group(rows, (r) => r.serviceId, (r) => r.serviceName ?? "", canSeeMoney, "__none", "").map(strip),
      byWorkType: group(rows, (r) => r.workTypeId, (r) => r.workTypeName ?? "", canSeeMoney, "__none", "").map(strip),
      costBuckets: group(rows, (r) => r.costRateCardId, () => "", false, "__none", "").map((l) => ({
        costRateCardId: l.key === "__none" ? null : l.key,
        seconds: l.seconds,
      })),
    };
  });
}

export type TeamRollupLine = {
  memberId: string;
  memberName: string;
  projectId: string | null;
  projectKey: string | null;
  projectName: string | null;
  seconds: number;
  billableSeconds: number;
  amount: string | null;
  /** The project's billing currency (ad-hoc rows: null) — amounts are never summed across currencies. */
  currency: string | null;
  /** Σ hours vs the member's hoursPerDay × working days in range — display only. */
  hoursPerDay: number | null;
};

/** time:view_team — per member × project totals inside the actor's scope (ad-hoc rows included). */
export async function teamRollup(ctx: TimeCtx, range: Range): Promise<TeamRollupLine[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:view_team");
    const canSeeMoney = await isAuthorized(tx, ctx.actor, "rate:view_bill");
    const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "projectId" });
    const rows = await tx.timeEntry.findMany({
      where: {
        tenantId: ctx.tenantId,
        deletedAt: null,
        stoppedAt: { not: null },
        localDate: rangeWhere(range),
        OR: [{ projectId: null }, { projectId: { not: null }, ...scope }],
      },
      select: {
        memberId: true,
        projectId: true,
        durationSeconds: true,
        billable: true,
        billRate: true,
        member: { select: { hoursPerDay: true, user: { select: { name: true } } } },
        project: { select: { key: true, name: true, billingCurrency: true } },
      },
    });
    const buckets = new Map<string, TeamRollupLine & { _amount: number }>();
    for (const r of rows) {
      const k = `${r.memberId}:${r.projectId ?? "adhoc"}`;
      const b =
        buckets.get(k) ??
        ({
          memberId: r.memberId,
          memberName: r.member.user.name,
          projectId: r.projectId,
          projectKey: r.project?.key ?? null,
          projectName: r.project?.name ?? null,
          seconds: 0,
          billableSeconds: 0,
          amount: null,
          currency: r.project?.billingCurrency ?? null,
          hoursPerDay: r.member.hoursPerDay ? Number(r.member.hoursPerDay.toString()) : null,
          _amount: 0,
        } as TeamRollupLine & { _amount: number });
      b.seconds += r.durationSeconds ?? 0;
      if (r.billable) b.billableSeconds += r.durationSeconds ?? 0;
      b._amount += billAmountOf(r);
      buckets.set(k, b);
    }
    return [...buckets.values()]
      .map(({ _amount, ...line }) => ({ ...line, amount: canSeeMoney ? money(_amount) : null }))
      .sort((a, b) => a.memberName.localeCompare(b.memberName) || (a.projectKey ?? "").localeCompare(b.projectKey ?? ""));
  });
}

/** The agreement consumption strip: "X h this period" against one Service (a SUM, not a ledger). */
export async function agreementConsumption(
  ctx: TimeCtx,
  serviceId: string,
  range: Range,
): Promise<{ serviceId: string; seconds: number; billableSeconds: number; amount: string | null; hours: number }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "service:view");
    const service = await tx.service.findFirst({
      where: { tenantId: ctx.tenantId, id: serviceId },
      select: { clientId: true, projectId: true },
    });
    if (!service) fail("INVALID_INPUT", "unknown agreement");
    if (service!.projectId) await assertInScope(tx, ctx.actor, { projectId: service!.projectId });
    else await assertInScope(tx, ctx.actor, { clientId: service!.clientId, lifted: true });
    const canSeeMoney = await isAuthorized(tx, ctx.actor, "rate:view_bill");
    const rows = await tx.timeEntry.findMany({
      where: { tenantId: ctx.tenantId, serviceId, deletedAt: null, stoppedAt: { not: null }, localDate: rangeWhere(range) },
      select: { durationSeconds: true, billable: true, billRate: true },
    });
    const seconds = rows.reduce((s, r) => s + (r.durationSeconds ?? 0), 0);
    const billableSeconds = rows.filter((r) => r.billable).reduce((s, r) => s + (r.durationSeconds ?? 0), 0);
    const amount = sumBillAmount(rows);
    return { serviceId, seconds, billableSeconds, amount: canSeeMoney ? money(amount) : null, hours: hours2(seconds) };
  });
}

export { isoDateOf };
