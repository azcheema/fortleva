import { withTenant } from "@/db";
import { accessibleCodes } from "@/entitlements/resolver";
import { localDateString } from "@/lib/duration";
import type { DurationStyle } from "@/lib/format";
import { activeBudgetBurns } from "@/modules/time/budgets";
import { readPreferences } from "@/preferences/service";

import { monthWindow, periodRange, type ChartPeriod, type PeriodRange } from "./chart-shapes";
import { openPortfolio, RUNNING_PROJECT, type PortfolioCtx } from "./portfolio";

/**
 * THE TEAM CHARTS (Phase 6 slice 117, founder decision C93; design
 * docs/research/2026-10-14-slice-117-team-charts-design.md). Below the
 * project health table on `/reports`: the open and late tasks, what was done
 * and how long it took, where the hours went, and how much of each budget is
 * used — over every project in the member's scope, narrowed by the page's
 * client filter. READ-ONLY.
 *
 * The page's door (`openPortfolio`: both gates and the scope), then ONE
 * `accessibleCodes` read; every statement in SEQUENCE (AGENTS.md's
 * `Promise.all` trap) and none per project. EACH VIEW IS GATED BY ITS
 * SOURCE'S CODE, as the table's columns are: tasks by `work_item:view`, hours
 * by `time:view_team` (the team view's rule — another person's hours), the
 * budget meters by `budget:view` as a percent. Nothing reads a cost.
 *
 * WHICH PROJECTS: open and late tasks and the budgets, the RUNNING ones (the
 * table's default set); done tasks, time to done and hours, EVERY project in
 * scope — work done and hours logged in the period happened whether or not
 * the project has since closed. Hours on NO project (`/time/team`'s ad-hoc
 * rows, which any `time:view_team` holder sees) count while no client is
 * chosen, as their own bar.
 *
 * NEVER HOURS PER PERSON (C93 (e)). A chart of people by their hours is an
 * hour ranking — SECURITY.md §9.7.2's never-list and the staff notice every
 * member acknowledges forbid it in any tier. Hours here are by PROJECT; a
 * person's hours are the Team time page's (`/time/team`, billing and
 * planning). Do not add a per-member read to this file.
 */

const VIEW_CODES = ["work_item:view", "time:view_team", "budget:view"] as const;

/** A task's parts in "Open tasks by project": not late, by category, and late. */
export type OpenParts = { readonly todo: number; readonly doing: number; readonly late: number };
export type HourParts = { readonly billable: number; readonly nonBillable: number };

export type ProjectBar<P> = {
  /** Null for hours on no project. */
  readonly id: string | null;
  readonly key: string | null;
  readonly name: string | null;
  readonly parts: P;
};

export type MonthPoint = {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly inPeriod: boolean;
  readonly done: number;
  /** Done tasks that went through In progress — the ones the median is over. */
  readonly timed: number;
  /** Median days started → done, null when no task in the month has a start. */
  readonly medianDays: number | null;
};

export type TeamCharts = {
  readonly range: PeriodRange;
  /** The workspace's `ui.durationStyle`, for the hours' labels. */
  readonly durationStyle: DurationStyle;
  readonly show: { readonly tasks: boolean; readonly hours: boolean; readonly budget: boolean };
  readonly tasks: {
    readonly open: number;
    readonly late: number;
    readonly done: number;
    readonly timed: number;
    readonly medianDays: number | null;
    /** Running projects with open tasks, most open first. */
    readonly byProject: readonly ProjectBar<OpenParts>[];
    readonly months: readonly MonthPoint[];
  } | null;
  readonly hours: {
    readonly total: HourParts;
    /** Most hours first; `id` null is the hours on no project. */
    readonly byProject: readonly ProjectBar<HourParts>[];
  } | null;
  /** Running projects with an ACTIVE budget, the most used first. */
  readonly budgets: readonly { readonly id: string; readonly key: string; readonly name: string; readonly percent: number }[] | null;
};

const total = (p: HourParts) => p.billable + p.nonBillable;

export async function readTeamCharts(
  ctx: PortfolioCtx,
  opts: { readonly period: ChartPeriod; readonly clientId?: string | null },
  now: Date = new Date(),
): Promise<TeamCharts> {
  const { tenantId } = ctx;
  return withTenant(tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    const scope = await openPortfolio(tx, ctx);
    const codes = await accessibleCodes(tx, tenantId, ctx.actor, VIEW_CODES);
    const show = { tasks: codes.has("work_item:view"), hours: codes.has("time:view_team"), budget: codes.has("budget:view") };
    const prefs = await readPreferences(tx, tenantId);
    const tz = prefs.timezone;
    const today = localDateString(now, tz);
    const range = periodRange(opts.period, today);
    const window = monthWindow(range);
    // The page's reading of `?client=`, ANDed with the scope — a client
    // outside it narrows to nothing, never widens.
    const clientId = opts.clientId ?? null;
    const narrowed = clientId ? { clientId } : {};

    const select = { id: true, key: true, name: true } as const;
    const runningProjects = await tx.project.findMany({ where: { AND: [{ tenantId }, scope, RUNNING_PROJECT, narrowed] }, select });
    const allProjects = await tx.project.findMany({ where: { AND: [{ tenantId }, scope, narrowed] }, select });
    const runningIds = runningProjects.map((p) => p.id);
    const allIds = allProjects.map((p) => p.id);
    const projectOf = new Map(allProjects.map((p) => [p.id, p]));

    let tasks: TeamCharts["tasks"] = null;
    if (show.tasks) {
      // Open work (the % done exclusions: not deleted, not put away, never an
      // epic, never Triage, Cancelled or Done); LATE = past its due date
      // (C93 (c)), counted once, before its category.
      const open = runningIds.length
        ? await tx.$queryRaw<{ project_id: string; todo: number; doing: number; late: number }[]>`
            SELECT project_id,
                   count(*) FILTER (WHERE (target_date IS NULL OR target_date >= ${today}::date)
                                      AND state_category IN ('BACKLOG', 'TODO'))::int AS todo,
                   count(*) FILTER (WHERE (target_date IS NULL OR target_date >= ${today}::date)
                                      AND state_category = 'IN_PROGRESS')::int AS doing,
                   count(*) FILTER (WHERE target_date < ${today}::date)::int AS late
              FROM work_item
             WHERE tenant_id = ${tenantId} AND project_id = ANY(${runningIds}::text[])
               AND deleted_at IS NULL AND archived_at IS NULL AND "type" <> 'EPIC'
               AND state_category IN ('BACKLOG', 'TODO', 'IN_PROGRESS')
             GROUP BY project_id`
        : [];
      // Done work, by month of completion in the workspace's zone, over the
      // six-month window (which holds the period): the count, and the median
      // days started → done over those that HAD a start (C93 (d)). A task
      // done and put away still counts; one reopened has no completed_at.
      const done = allIds.length
        ? await tx.$queryRaw<{ month: string; done: number; timed: number; median_days: number | null }[]>`
            SELECT to_char(completed_at AT TIME ZONE ${tz}, 'YYYY-MM') AS month,
                   count(*)::int AS done,
                   count(*) FILTER (WHERE started_at IS NOT NULL)::int AS timed,
                   percentile_cont(0.5) WITHIN GROUP (
                     ORDER BY greatest(extract(epoch FROM completed_at - started_at), 0) / 86400.0
                   ) FILTER (WHERE started_at IS NOT NULL) AS median_days
              FROM work_item
             WHERE tenant_id = ${tenantId} AND project_id = ANY(${allIds}::text[])
               AND deleted_at IS NULL AND "type" <> 'EPIC'
               AND state_category = 'DONE' AND completed_at IS NOT NULL
               AND (completed_at AT TIME ZONE ${tz})::date >= ${`${window[0]}-01`}::date
               AND (completed_at AT TIME ZONE ${tz})::date <= ${range.to}::date
             GROUP BY 1`
        : [];
      // …and the PERIOD's own median, over its tasks — never a median of
      // monthly medians.
      const period = allIds.length
        ? await tx.$queryRaw<{ done: number; timed: number; median_days: number | null }[]>`
            SELECT count(*)::int AS done,
                   count(*) FILTER (WHERE started_at IS NOT NULL)::int AS timed,
                   percentile_cont(0.5) WITHIN GROUP (
                     ORDER BY greatest(extract(epoch FROM completed_at - started_at), 0) / 86400.0
                   ) FILTER (WHERE started_at IS NOT NULL) AS median_days
              FROM work_item
             WHERE tenant_id = ${tenantId} AND project_id = ANY(${allIds}::text[])
               AND deleted_at IS NULL AND "type" <> 'EPIC'
               AND state_category = 'DONE' AND completed_at IS NOT NULL
               AND (completed_at AT TIME ZONE ${tz})::date >= ${range.from}::date
               AND (completed_at AT TIME ZONE ${tz})::date <= ${range.to}::date`
        : [];
      const byMonth = new Map(done.map((r) => [r.month, r]));
      const byProject = open
        .map((r) => {
          const p = projectOf.get(r.project_id)!;
          return { id: p.id, key: p.key, name: p.name, parts: { todo: r.todo, doing: r.doing, late: r.late } };
        })
        .filter((b) => b.parts.todo + b.parts.doing + b.parts.late > 0)
        .sort((a, b) => b.parts.todo + b.parts.doing + b.parts.late - (a.parts.todo + a.parts.doing + a.parts.late) || a.name.localeCompare(b.name));
      tasks = {
        open: byProject.reduce((n, b) => n + b.parts.todo + b.parts.doing + b.parts.late, 0),
        late: byProject.reduce((n, b) => n + b.parts.late, 0),
        done: period[0]?.done ?? 0,
        timed: period[0]?.timed ?? 0,
        medianDays: period[0]?.median_days ?? null,
        byProject,
        months: window.map((month) => {
          const m = byMonth.get(month);
          return {
            month,
            inPeriod: range.months.includes(month),
            done: m?.done ?? 0,
            timed: m?.timed ?? 0,
            medianDays: m?.median_days ?? null,
          };
        }),
      };
    }

    let hours: TeamCharts["hours"] = null;
    if (show.hours) {
      // Closed entries on the period's LOCAL days, on projects in scope — and
      // on no project while no client is chosen (`teamRollup`'s rule).
      const adhoc = clientId === null;
      const byProjectRows = await tx.$queryRaw<{ project_id: string | null; billable: number; non_billable: number }[]>`
        SELECT project_id,
               coalesce(sum(duration_seconds) FILTER (WHERE billable), 0)::int AS billable,
               coalesce(sum(duration_seconds) FILTER (WHERE NOT billable), 0)::int AS non_billable
          FROM time_entry
         WHERE tenant_id = ${tenantId} AND deleted_at IS NULL AND stopped_at IS NOT NULL
           AND local_date >= ${range.from}::date AND local_date <= ${range.to}::date
           AND (project_id = ANY(${allIds}::text[]) OR (${adhoc}::boolean AND project_id IS NULL))
         GROUP BY project_id`;
      const byProject = byProjectRows
        .map((r) => {
          const p = r.project_id ? projectOf.get(r.project_id) : undefined;
          return { id: p?.id ?? null, key: p?.key ?? null, name: p?.name ?? null, parts: { billable: r.billable, nonBillable: r.non_billable } };
        })
        .filter((b) => total(b.parts) > 0)
        .sort((a, b) => total(b.parts) - total(a.parts) || (a.name ?? "").localeCompare(b.name ?? ""));
      hours = {
        total: byProject.reduce((t, b) => ({ billable: t.billable + b.parts.billable, nonBillable: t.nonBillable + b.parts.nonBillable }), {
          billable: 0,
          nonBillable: 0,
        }),
        byProject,
      };
    }

    let budgets: TeamCharts["budgets"] = null;
    if (show.budget) {
      // `money: false` — a percent only, so `rate:view_bill` is never needed.
      const burns = await activeBudgetBurns(tx, tenantId, runningIds, today, { money: false });
      budgets = [...burns.entries()]
        .map(([projectId, { burn }]) => {
          const p = projectOf.get(projectId)!;
          return { id: p.id, key: p.key, name: p.name, percent: burn.percent };
        })
        .sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name));
    }

    return { range, durationStyle: prefs.durationStyle, show, tasks, hours, budgets };
  });
}
