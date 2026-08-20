import { record } from "@/audit/record";
import { assertInScope, isAuthorized } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { dateColumn, isoDateOf } from "@/lib/duration";
import { fail } from "@/lib/domain-error";

import { guarded, idsOnly, principalOf, type TimeCtx } from "./ctx";

/**
 * TimeReport (D3; DATA_MODEL.md §6.15): an EXPLICITLY published, IMMUTABLE
 * client time report — "not all the reports, the ones the user wants".
 * The snapshot is CLIENT-SAFE BY CONSTRUCTION: the generator never
 * selects a member column, and a line carries an entity's NAME only when
 * that entity (work item / agreement) is CLIENT_VISIBLE — INTERNAL ones
 * fold into one "other" line at generation time, so any snapshot is
 * publishable without a validate-at-publish step. Publish = status +
 * visibility + publishedAt in ONE audited tx; unpublish = visibility →
 * INTERNAL; published rows are immutable and archive-only (triggers).
 * Internal readers without rate:view_bill get amount keys stripped.
 */

export type ReportGroupBy = "DAY" | "WORK_ITEM" | "EPIC" | "SERVICE";
export type ReportStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

/** One snapshot line. `kind: "other"` carries no label — the UI localizes it. */
export type ReportLine =
  | { kind: "day"; date: string; seconds: number; billableSeconds: number; amount?: string }
  | { kind: "work_item"; ref: string; label: string; seconds: number; billableSeconds: number; amount?: string }
  | { kind: "epic"; ref: string; label: string; seconds: number; billableSeconds: number; amount?: string }
  | { kind: "service"; label: string; seconds: number; billableSeconds: number; amount?: string }
  | { kind: "other"; seconds: number; billableSeconds: number; amount?: string };

export type ReportSnapshot = {
  version: 1;
  groupBy: ReportGroupBy;
  period: { start: string; end: string };
  currency: string | null;
  includeAmounts: boolean;
  includeNonBillable: boolean;
  lines: ReportLine[];
  totals: { seconds: number; billableSeconds: number; amount?: string };
};

export type ReportView = {
  id: string;
  projectId: string;
  clientId: string;
  title: string;
  periodStart: string;
  periodEnd: string;
  groupBy: ReportGroupBy;
  includeAmounts: boolean;
  includeNonBillable: boolean;
  status: ReportStatus;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  totalSeconds: number;
  billableSeconds: number;
  billableAmount: string | null;
  currency: string | null;
  generatedAt: Date;
  publishedAt: Date | null;
  snapshot: ReportSnapshot;
};

const select = {
  id: true,
  projectId: true,
  clientId: true,
  title: true,
  periodStart: true,
  periodEnd: true,
  groupBy: true,
  includeAmounts: true,
  includeNonBillable: true,
  status: true,
  visibility: true,
  totalSeconds: true,
  billableSeconds: true,
  billableAmount: true,
  currency: true,
  generatedAt: true,
  publishedAt: true,
  snapshot: true,
} as const;

const money = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

/** Strip every amount key (internal reader without rate:view_bill). */
const stripAmounts = (s: ReportSnapshot): ReportSnapshot => ({
  ...s,
  lines: s.lines.map((l) => {
    const copy = { ...l } as ReportLine & { amount?: string };
    delete copy.amount;
    return copy as ReportLine;
  }),
  totals: { seconds: s.totals.seconds, billableSeconds: s.totals.billableSeconds },
});

const toView = (
  r: {
    id: string;
    projectId: string;
    clientId: string;
    title: string;
    periodStart: Date;
    periodEnd: Date;
    groupBy: ReportGroupBy;
    includeAmounts: boolean;
    includeNonBillable: boolean;
    status: ReportStatus;
    visibility: "INTERNAL" | "CLIENT_VISIBLE";
    totalSeconds: number;
    billableSeconds: number;
    billableAmount: { toString(): string } | null;
    currency: string | null;
    generatedAt: Date;
    publishedAt: Date | null;
    snapshot: unknown;
  },
  canSeeMoney: boolean,
): ReportView => {
  const snapshot = r.snapshot as ReportSnapshot;
  return {
    id: r.id,
    projectId: r.projectId,
    clientId: r.clientId,
    title: r.title,
    periodStart: isoDateOf(r.periodStart),
    periodEnd: isoDateOf(r.periodEnd),
    groupBy: r.groupBy,
    includeAmounts: r.includeAmounts,
    includeNonBillable: r.includeNonBillable,
    status: r.status,
    visibility: r.visibility,
    totalSeconds: r.totalSeconds,
    billableSeconds: r.billableSeconds,
    billableAmount: canSeeMoney && r.billableAmount ? money(Number(r.billableAmount.toString())) : null,
    currency: r.currency,
    generatedAt: r.generatedAt,
    publishedAt: r.publishedAt,
    snapshot: canSeeMoney ? snapshot : stripAmounts(snapshot),
  };
};

/**
 * Build the snapshot. The SELECT carries no member column; labels are
 * attached only to CLIENT_VISIBLE entities; everything else folds into
 * "other". Pure over the rows it reads, so a draft can be regenerated.
 */
async function buildSnapshot(
  tx: TenantDb,
  tenantId: string,
  args: {
    projectId: string;
    periodStart: string;
    periodEnd: string;
    groupBy: ReportGroupBy;
    includeAmounts: boolean;
    includeNonBillable: boolean;
    currency: string | null;
  },
): Promise<ReportSnapshot> {
  const rows = await tx.timeEntry.findMany({
    where: {
      tenantId,
      projectId: args.projectId,
      deletedAt: null,
      stoppedAt: { not: null },
      localDate: { gte: dateColumn(args.periodStart), lte: dateColumn(args.periodEnd) },
      ...(args.includeNonBillable ? {} : { billable: true }),
    },
    // NO member column here — by construction (DATA_MODEL.md §6.15 D3).
    select: {
      localDate: true,
      durationSeconds: true,
      billable: true,
      billRate: true,
      workItem: {
        select: { number: true, title: true, visibility: true, rootId: true, project: { select: { key: true } } },
      },
      service: { select: { name: true, visibility: true } },
    },
  });
  const rootIds = [...new Set(rows.map((r) => r.workItem?.rootId).filter((x): x is string => !!x))];
  const roots = rootIds.length
    ? await tx.workItem.findMany({
        where: { tenantId, id: { in: rootIds } },
        select: { id: true, number: true, title: true, visibility: true, project: { select: { key: true } } },
      })
    : [];
  const rootById = new Map(roots.map((r) => [r.id, r]));

  type Acc = { line: ReportLine; amount: number };
  const buckets = new Map<string, Acc>();
  const add = (key: string, make: () => ReportLine, r: (typeof rows)[number]) => {
    const acc = buckets.get(key) ?? { line: make(), amount: 0 };
    acc.line.seconds += r.durationSeconds ?? 0;
    if (r.billable) {
      acc.line.billableSeconds += r.durationSeconds ?? 0;
      if (r.billRate) acc.amount += ((r.durationSeconds ?? 0) / 3600) * Number(r.billRate.toString());
    }
    buckets.set(key, acc);
  };
  const other = (): ReportLine => ({ kind: "other", seconds: 0, billableSeconds: 0 });

  for (const r of rows) {
    switch (args.groupBy) {
      case "DAY": {
        const date = isoDateOf(r.localDate);
        add(`day:${date}`, () => ({ kind: "day", date, seconds: 0, billableSeconds: 0 }), r);
        break;
      }
      case "WORK_ITEM": {
        const wi = r.workItem;
        if (wi && wi.visibility === "CLIENT_VISIBLE") {
          const ref = `${wi.project.key}-${wi.number}`;
          add(`wi:${ref}`, () => ({ kind: "work_item", ref, label: wi.title, seconds: 0, billableSeconds: 0 }), r);
        } else {
          add("other", other, r);
        }
        break;
      }
      case "EPIC": {
        const root = r.workItem?.rootId ? rootById.get(r.workItem.rootId) : undefined;
        if (root && root.visibility === "CLIENT_VISIBLE") {
          const ref = `${root.project.key}-${root.number}`;
          add(`epic:${ref}`, () => ({ kind: "epic", ref, label: root.title, seconds: 0, billableSeconds: 0 }), r);
        } else {
          add("other", other, r);
        }
        break;
      }
      case "SERVICE": {
        const s = r.service;
        if (s && s.visibility === "CLIENT_VISIBLE") {
          add(`svc:${s.name}`, () => ({ kind: "service", label: s.name, seconds: 0, billableSeconds: 0 }), r);
        } else {
          add("other", other, r);
        }
        break;
      }
    }
  }
  const lines = [...buckets.entries()]
    .sort(([a], [b]) => (a === "other" ? 1 : b === "other" ? -1 : a.localeCompare(b)))
    .map(([, acc]) => (args.includeAmounts ? { ...acc.line, amount: money(acc.amount) } : acc.line));
  const totalSeconds = rows.reduce((s, r) => s + (r.durationSeconds ?? 0), 0);
  const billableSeconds = rows.filter((r) => r.billable).reduce((s, r) => s + (r.durationSeconds ?? 0), 0);
  const totalAmount = rows.reduce(
    (s, r) => s + (r.billable && r.billRate ? ((r.durationSeconds ?? 0) / 3600) * Number(r.billRate.toString()) : 0),
    0,
  );
  return {
    version: 1,
    groupBy: args.groupBy,
    period: { start: args.periodStart, end: args.periodEnd },
    currency: args.currency,
    includeAmounts: args.includeAmounts,
    includeNonBillable: args.includeNonBillable,
    lines,
    totals: args.includeAmounts
      ? { seconds: totalSeconds, billableSeconds, amount: money(totalAmount) }
      : { seconds: totalSeconds, billableSeconds },
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function requireGenerateAccess(tx: TenantDb, ctx: TimeCtx, projectId: string, includeAmounts: boolean) {
  await requireAccess(tx, ctx.tenantId, ctx.actor, "time_report:manage");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "time:view_team");
  if (includeAmounts) await requireAccess(tx, ctx.tenantId, ctx.actor, "rate:view_bill");
  await assertInScope(tx, ctx.actor, { projectId });
}

/** time_report:manage (+ time:view_team, + rate:view_bill when amounts) — generate a DRAFT. */
export async function generateReport(
  ctx: TimeCtx,
  input: {
    projectId: string;
    title: string;
    periodStart: string;
    periodEnd: string;
    groupBy?: ReportGroupBy;
    includeAmounts?: boolean;
    includeNonBillable?: boolean;
  },
): Promise<ReportView> {
  const title = input.title.trim();
  if (title === "") fail("NAME_REQUIRED");
  if (!DATE_RE.test(input.periodStart) || !DATE_RE.test(input.periodEnd) || input.periodEnd < input.periodStart) {
    fail("INVALID_INPUT", "period");
  }
  const groupBy = input.groupBy ?? "DAY";
  const includeAmounts = input.includeAmounts ?? false;
  const includeNonBillable = input.includeNonBillable ?? false;
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireGenerateAccess(tx, ctx, input.projectId, includeAmounts);
      const project = await tx.project.findFirst({
        where: { tenantId: ctx.tenantId, id: input.projectId },
        select: { clientId: true, billingCurrency: true },
      });
      if (!project) fail("INVALID_INPUT", "unknown project");
      const snapshot = await buildSnapshot(tx, ctx.tenantId, {
        projectId: input.projectId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        groupBy,
        includeAmounts,
        includeNonBillable,
        currency: project!.billingCurrency,
      });
      const row = await tx.timeReport.create({
        data: {
          tenantId: ctx.tenantId,
          clientId: project!.clientId,
          projectId: input.projectId,
          title,
          periodStart: dateColumn(input.periodStart),
          periodEnd: dateColumn(input.periodEnd),
          groupBy,
          includeAmounts,
          includeNonBillable,
          snapshot: snapshot as object,
          totalSeconds: snapshot.totals.seconds,
          billableSeconds: snapshot.totals.billableSeconds,
          billableAmount: includeAmounts ? (snapshot.totals.amount ?? null) : null,
          currency: project!.billingCurrency,
          createdByMemberId: ctx.actor.memberId,
        },
        select,
      });
      await record(tx, {
        action: "time_report.created",
        targetType: "TimeReport",
        targetId: row.id,
        metadata: idsOnly({ projectId: input.projectId, groupBy, periodStart: input.periodStart, periodEnd: input.periodEnd }),
      });
      return toView(row, true);
    }),
  );
}

/** time_report:manage — regenerate a DRAFT's snapshot (title/period/grouping may change). */
export async function regenerateReport(
  ctx: TimeCtx,
  id: string,
  patch?: { title?: string; periodStart?: string; periodEnd?: string; groupBy?: ReportGroupBy; includeAmounts?: boolean; includeNonBillable?: boolean },
): Promise<ReportView> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      const existing = await tx.timeReport.findFirst({ where: { tenantId: ctx.tenantId, id }, select });
      if (!existing) fail("INVALID_INPUT", "unknown report");
      if (existing!.status !== "DRAFT") fail("REPORT_IMMUTABLE");
      const includeAmounts = patch?.includeAmounts ?? existing!.includeAmounts;
      await requireGenerateAccess(tx, ctx, existing!.projectId, includeAmounts);
      const periodStart = patch?.periodStart ?? isoDateOf(existing!.periodStart);
      const periodEnd = patch?.periodEnd ?? isoDateOf(existing!.periodEnd);
      if (!DATE_RE.test(periodStart) || !DATE_RE.test(periodEnd) || periodEnd < periodStart) fail("INVALID_INPUT", "period");
      const title = (patch?.title ?? existing!.title).trim();
      if (title === "") fail("NAME_REQUIRED");
      const snapshot = await buildSnapshot(tx, ctx.tenantId, {
        projectId: existing!.projectId,
        periodStart,
        periodEnd,
        groupBy: patch?.groupBy ?? existing!.groupBy,
        includeAmounts,
        includeNonBillable: patch?.includeNonBillable ?? existing!.includeNonBillable,
        currency: existing!.currency,
      });
      const row = await tx.timeReport.update({
        where: { id },
        data: {
          title,
          periodStart: dateColumn(periodStart),
          periodEnd: dateColumn(periodEnd),
          groupBy: snapshot.groupBy,
          includeAmounts,
          includeNonBillable: snapshot.includeNonBillable,
          snapshot: snapshot as object,
          totalSeconds: snapshot.totals.seconds,
          billableSeconds: snapshot.totals.billableSeconds,
          billableAmount: includeAmounts ? (snapshot.totals.amount ?? null) : null,
          generatedAt: new Date(),
        },
        select,
      });
      await record(tx, { action: "time_report.updated", targetType: "TimeReport", targetId: id });
      return toView(row, true);
    }),
  );
}

/** time_report:publish — PUBLISHED + CLIENT_VISIBLE + publishedAt/By in ONE audited tx. */
export async function publishReport(ctx: TimeCtx, id: string): Promise<ReportView> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time_report:publish");
      const existing = await tx.timeReport.findFirst({ where: { tenantId: ctx.tenantId, id }, select });
      if (!existing) fail("INVALID_INPUT", "unknown report");
      await assertInScope(tx, ctx.actor, { projectId: existing!.projectId });
      if (existing!.status === "ARCHIVED") fail("REPORT_IMMUTABLE", "archived");
      const row = await tx.timeReport.update({
        where: { id },
        data:
          existing!.status === "DRAFT"
            ? { status: "PUBLISHED", visibility: "CLIENT_VISIBLE", publishedAt: new Date(), publishedByMemberId: ctx.actor.memberId }
            : { visibility: "CLIENT_VISIBLE" }, // republish after an unpublish
        select,
      });
      await record(tx, {
        action: "time_report.published",
        targetType: "TimeReport",
        targetId: id,
        metadata: idsOnly({ projectId: row.projectId, republish: existing!.status === "PUBLISHED" }),
      });
      return toView(row, true);
    }),
  );
}

/** time_report:publish — hide from the portal again (status stays PUBLISHED; republish allowed). */
export async function unpublishReport(ctx: TimeCtx, id: string): Promise<ReportView> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time_report:publish");
      const existing = await tx.timeReport.findFirst({ where: { tenantId: ctx.tenantId, id }, select });
      if (!existing) fail("INVALID_INPUT", "unknown report");
      await assertInScope(tx, ctx.actor, { projectId: existing!.projectId });
      const row = await tx.timeReport.update({ where: { id }, data: { visibility: "INTERNAL" }, select });
      await record(tx, { action: "time_report.unpublished", targetType: "TimeReport", targetId: id });
      return toView(row, true);
    }),
  );
}

/** time_report:manage — archive (published rows are archive-only). */
export async function archiveReport(ctx: TimeCtx, id: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time_report:manage");
      const existing = await tx.timeReport.findFirst({ where: { tenantId: ctx.tenantId, id }, select });
      if (!existing) fail("INVALID_INPUT", "unknown report");
      await assertInScope(tx, ctx.actor, { projectId: existing!.projectId });
      if (existing!.status === "ARCHIVED") return;
      if (existing!.status === "DRAFT") {
        // A draft has never been visible; deleting it is the honest archive.
        await tx.timeReport.delete({ where: { id } });
        await record(tx, { action: "time_report.deleted", targetType: "TimeReport", targetId: id });
        return;
      }
      await tx.timeReport.update({ where: { id }, data: { status: "ARCHIVED", visibility: "INTERNAL" } });
      await record(tx, { action: "time_report.archived", targetType: "TimeReport", targetId: id });
    }),
  );
}

/** time_report:manage — delete a DRAFT (published rows refuse at the database). */
export async function deleteReport(ctx: TimeCtx, id: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time_report:manage");
      const existing = await tx.timeReport.findFirst({ where: { tenantId: ctx.tenantId, id }, select: { projectId: true, status: true } });
      if (!existing) fail("INVALID_INPUT", "unknown report");
      await assertInScope(tx, ctx.actor, { projectId: existing!.projectId });
      if (existing!.status !== "DRAFT") fail("REPORT_IMMUTABLE");
      await tx.timeReport.delete({ where: { id } });
      await record(tx, { action: "time_report.deleted", targetType: "TimeReport", targetId: id });
    }),
  );
}

/** time_report:manage — a project's reports (amounts only with rate:view_bill). */
export async function listReports(ctx: TimeCtx, projectId: string): Promise<ReportView[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time_report:manage");
    await assertInScope(tx, ctx.actor, { projectId });
    const canSeeMoney = await isAuthorized(tx, ctx.actor, "rate:view_bill");
    const rows = await tx.timeReport.findMany({
      where: { tenantId: ctx.tenantId, projectId },
      orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }],
      select,
    });
    return rows.map((r) => toView(r, canSeeMoney));
  });
}

export async function getReport(ctx: TimeCtx, id: string): Promise<ReportView> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time_report:manage");
    const row = await tx.timeReport.findFirst({ where: { tenantId: ctx.tenantId, id }, select });
    if (!row) fail("INVALID_INPUT", "unknown report");
    await assertInScope(tx, ctx.actor, { projectId: row!.projectId });
    const canSeeMoney = await isAuthorized(tx, ctx.actor, "rate:view_bill");
    return toView(row!, canSeeMoney);
  });
}
