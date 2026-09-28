import { record } from "@/audit/record";
import { assertInScope, isAuthorized } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { dateColumn, isoDateOf } from "@/lib/duration";
import { fail, isDeadlock } from "@/lib/domain-error";
import { lockProjectRanks } from "@/modules/work";
import { retryOnDeadlock } from "@/lib/retry";

import { billAmountOf, guarded, idsOnly, money, principalOf, sumBillAmount, type TimeCtx } from "./ctx";

/**
 * TimeReport (D3; DATA_MODEL.md §6.15): an EXPLICITLY published, IMMUTABLE
 * client time report — "not all the reports, the ones the user wants".
 * The snapshot is CLIENT-SAFE BY CONSTRUCTION: the generator never
 * selects a member column, and a line carries an entity's NAME only when
 * that entity (work item / agreement) is CLIENT_VISIBLE — INTERNAL ones
 * fold into one "other" line at generation time. That makes a snapshot
 * safe on the day it is GENERATED, not the day it is PUBLISHED: since
 * Phase 3 slice 72, publish and republish (`assertNamesStillShared`)
 * check every task and epic line against the task's visibility NOW and
 * refuse REPORT_NAMES_PRIVATE_TASK — never editing the frozen snapshot —
 * and both sides apply ONE rule (`namedTaskShared`). SERVICE lines are not
 * re-checked (no id to look one up by; a recorded residual, PLAN §0 slice
 * 72). Publish = status +
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
        select: {
          id: true,
          number: true,
          title: true,
          visibility: true,
          rootId: true,
          parentId: true,
          deletedAt: true,
          project: { select: { key: true } },
        },
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
  // A SOFT-DELETED task is named only if the tasks above it are still
  // shared — the rule publish applies (`namedTaskShared`). Without it the
  // generator named a deleted shared subtask whose parent had been made
  // private since (a make-private leaves soft-deleted rows alone), and
  // every report generated over that time was then refused at publish
  // with advice that could never work (slice 72 fix review). In sequence.
  const deletedAncestorIds = [
    ...new Set(
      rows
        .flatMap((r) => (r.workItem && r.workItem.deletedAt !== null ? [r.workItem.parentId, r.workItem.rootId] : []))
        .filter((x): x is string => !!x),
    ),
  ];
  const ancestorVisibility = new Map(
    deletedAncestorIds.length
      ? (
          await tx.workItem.findMany({
            where: { tenantId, id: { in: deletedAncestorIds } },
            select: { id: true, visibility: true },
          })
        ).map((a) => [a.id, a.visibility] as const)
      : [],
  );

  type Acc = { line: ReportLine; amount: number };
  const buckets = new Map<string, Acc>();
  const add = (key: string, make: () => ReportLine, r: (typeof rows)[number]) => {
    const acc = buckets.get(key) ?? { line: make(), amount: 0 };
    acc.line.seconds += r.durationSeconds ?? 0;
    if (r.billable) acc.line.billableSeconds += r.durationSeconds ?? 0;
    acc.amount += billAmountOf(r);
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
        if (
          wi &&
          namedTaskShared({
            visibility: wi.visibility,
            deleted: wi.deletedAt !== null,
            ancestors: [wi.parentId, wi.rootId === wi.id ? null : wi.rootId].map((a) =>
              a === null ? null : (ancestorVisibility.get(a) ?? "INTERNAL"),
            ),
          })
        ) {
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
  const totalAmount = sumBillAmount(rows);
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

/**
 * A snapshot folds a PRIVATE task into "other" when it is GENERATED —
 * which says nothing about the day it is PUBLISHED. A draft generated
 * while a task was shared, published after the task was made private,
 * put that task's title on the client's portal; so did republishing an
 * unpublished report (Phase 3 slice 72's design review found it: the
 * sharing UI's "make private" questions promise the client stops seeing
 * the task, and without this they would not). Every task and epic line
 * is checked against the task's visibility NOW, soft-deleted rows
 * included — a task that was shared and then deleted was still shared —
 * and a line whose task is private, or can no longer be found at all,
 * refuses the publish. The snapshot is frozen (the header's promise, and
 * a published one is immutable by trigger), so the answer is a fresh
 * report, never a quiet edit of this one.
 *
 * SERVICE lines are not checked: a snapshot names an agreement by its
 * name alone, with no id to look it up by — a recorded residual (PLAN §0,
 * slice 72).
 */
async function assertNamesStillShared(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
  snapshot: ReportSnapshot,
): Promise<void> {
  const numbers = new Set<number>();
  for (const line of snapshot.lines) {
    if (line.kind !== "work_item" && line.kind !== "epic") continue;
    const n = Number(line.ref.slice(line.ref.lastIndexOf("-") + 1));
    if (!Number.isInteger(n) || n < 1) fail("REPORT_NAMES_PRIVATE_TASK", "unreadable ref");
    numbers.add(n);
  }
  if (numbers.size === 0) return;
  // THE NAMED TASKS AND THE TASKS ABOVE THEM, LOCKED FOR SHARE: a
  // make-private takes FOR NO KEY UPDATE on the same rows, so it either
  // waits for this publish or this publish waits for it and then reads it
  // private. An unlocked read let the two cross under READ COMMITTED.
  //
  // BEHIND THE PROJECT'S QUEUE FIRST (rank-lock.ts: every writer that locks
  // many work_item rows of a project queues). Without it the share-locks
  // could cycle with a QUEUED writer that locks the same rows in another
  // order — a bulk edit (scan order), the make-private cascade (level by
  // level) — and a bulk edit that lost that deadlock has no retry (slice
  // 72's third review). Queued, no queued writer holds a row of this
  // project while these are taken. This transaction holds nothing before
  // the queue (its report read is unlocked), so the queue opens no new
  // cycle; the cost is a short wait behind a running bulk edit, and a
  // report publish is not an emergency lever. What can still cycle — the
  // unqueued MULTI-row lockers rank-lock.ts lists (the portal fan-out, a
  // contact's release; a writer of ONE row may wait on these share-locks
  // but cannot close a cycle with them — it holds one row, and what it
  // takes after is compatible with FOR SHARE) — `publishReport` retries.
  //
  // ONE statement, root first (`ORDER BY depth, id` — LockRows runs above
  // the sort). Soft-deleted rows included (no `deleted_at` term).
  await lockProjectRanks(tx, projectId);
  const nums = [...numbers];
  const rows = await tx.$queryRaw<
    {
      id: string;
      number: number;
      project_id: string;
      visibility: string;
      parent_id: string | null;
      root_id: string;
      deleted: boolean;
    }[]
  >`
    SELECT id, number, project_id, visibility::text AS visibility, parent_id, root_id,
           (deleted_at IS NOT NULL) AS deleted
      FROM work_item
     WHERE tenant_id = ${tenantId}
       AND id IN (
         SELECT w.id FROM work_item w
          WHERE w.tenant_id = ${tenantId} AND w.project_id = ${projectId} AND w.number = ANY(${nums}::int[])
         UNION
         SELECT w.parent_id FROM work_item w
          WHERE w.tenant_id = ${tenantId} AND w.project_id = ${projectId} AND w.number = ANY(${nums}::int[])
            AND w.parent_id IS NOT NULL
         UNION
         SELECT w.root_id FROM work_item w
          WHERE w.tenant_id = ${tenantId} AND w.project_id = ${projectId} AND w.number = ANY(${nums}::int[])
       )
     ORDER BY depth, id
     FOR SHARE`;
  const visibilityOf = new Map(rows.map((r) => [r.id, r.visibility]));
  const shared = new Set(
    rows
      .filter((r) => r.project_id === projectId && numbers.has(r.number))
      .filter((r) =>
        namedTaskShared({
          visibility: r.visibility,
          deleted: r.deleted,
          ancestors: [r.parent_id, r.root_id === r.id ? null : r.root_id].map((a) =>
            a === null ? null : (visibilityOf.get(a) ?? "INTERNAL"),
          ),
        }),
      )
      .map((r) => r.number),
  );
  for (const n of numbers) {
    if (!shared.has(n)) fail("REPORT_NAMES_PRIVATE_TASK", "a named task is private now");
  }
}

/**
 * THE ONE RULE for "may a report NAME this task" — the generator's and the
 * publish check's, so the two cannot drift (they did once: the publish side
 * learned about soft-deleted rows and the generator did not, and every
 * report over such time became unpublishable — slice 72 fix review). A
 * LIVE shared task: yes — its ancestors are shared by construction (child
 * ≤ parent, the tree trigger). A SOFT-DELETED one is held to nothing by
 * the trigger (a make-private leaves deleted rows alone), so it is named
 * only while every task above it is still shared: a task shared and then
 * deleted was still shared; one whose parent went private since is not.
 * `ancestors` holds the parent's and the root's visibility, `null` where
 * there is none (the root is its own).
 */
function namedTaskShared(t: {
  visibility: string;
  deleted: boolean;
  ancestors: readonly (string | null)[];
}): boolean {
  if (t.visibility !== "CLIENT_VISIBLE") return false;
  if (!t.deleted) return true;
  return t.ancestors.every((a) => a === null || a === "CLIENT_VISIBLE");
}

/** time_report:publish — PUBLISHED + CLIENT_VISIBLE + publishedAt/By in ONE audited tx. */
export async function publishReport(ctx: TimeCtx, id: string): Promise<ReportView> {
  // RETRIED ON A DEADLOCK, and told when every attempt is spent (slice 72
  // fix review): `assertNamesStillShared` share-locks work items a
  // make-private cascade may be locking in another order. The transaction
  // is database-only, so a re-run is the whole remedy; a spent retry is the
  // sharing UI's own "someone else was changing this project" sentence.
  try {
    return await retryOnDeadlock(() => publishReportOnce(ctx, id));
  } catch (e) {
    if (isDeadlock(e)) fail("VISIBILITY_BUSY", "deadlock");
    throw e;
  }
}

async function publishReportOnce(ctx: TimeCtx, id: string): Promise<ReportView> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "time_report:publish");
      const existing = await tx.timeReport.findFirst({ where: { tenantId: ctx.tenantId, id }, select });
      if (!existing) fail("INVALID_INPUT", "unknown report");
      await assertInScope(tx, ctx.actor, { projectId: existing!.projectId });
      if (existing!.status === "ARCHIVED") fail("REPORT_IMMUTABLE", "archived");
      await assertNamesStillShared(tx, ctx.tenantId, existing!.projectId, existing!.snapshot as ReportSnapshot);
      // THE WRITE IS CONDITIONAL ON THE SNAPSHOT THAT WAS CHECKED (slice 72,
      // the fourth review): the report was read unlocked, and the check
      // waits on the project's queue — behind, possibly, the very
      // make-private it guards against — so a colleague could REGENERATE
      // the draft in that wait and this publish would put an unchecked
      // snapshot on the portal. A regenerate restamps `generatedAt`, so the
      // row still carrying the one read is the row that was checked; a
      // changed, deleted or archived report — or one a colleague published
      // first — writes nothing and is told.
      // (Not a lock on the report before the queue: the portal fan-out
      // updates `work_item` and then `time_report`, and that order would
      // cycle with it.)
      const [row] = await tx.timeReport.updateManyAndReturn({
        where: {
          tenantId: ctx.tenantId,
          id,
          status: existing!.status,
          // The millisecond the JS Date truncates to: the column is
          // `timestamptz(6)`, and a row stamped by the database's own
          // default carries microseconds an exact `=` would never match.
          generatedAt: { gte: existing!.generatedAt, lt: new Date(existing!.generatedAt.getTime() + 1) },
        },
        data:
          existing!.status === "DRAFT"
            ? { status: "PUBLISHED", visibility: "CLIENT_VISIBLE", publishedAt: new Date(), publishedByMemberId: ctx.actor.memberId }
            : { visibility: "CLIENT_VISIBLE" }, // republish after an unpublish
        select,
      });
      if (!row) fail("REPORT_CHANGED", "the report changed while it was being published");
      await record(tx, {
        action: "time_report.published",
        targetType: "TimeReport",
        targetId: id,
        metadata: idsOnly({ projectId: row!.projectId, republish: existing!.status === "PUBLISHED" }),
      });
      return toView(row!, true);
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
