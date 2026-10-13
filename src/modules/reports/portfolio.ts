import { scopeWhere, type MemberActor } from "@/authz/authorize";
import { withTenant } from "@/db";
import { accessibleCodes, requireAccess } from "@/entitlements/resolver";
import type { ProjectHealth, ProjectStatus } from "@/generated/prisma/enums";
import { localDateString } from "@/lib/duration";
import { activeBudgetBurns } from "@/modules/time/budgets";
import { scheduleInputOf, updateScheduleAt, type UpdateScheduleState } from "@/modules/work/update-schedule";
import { readPreferences } from "@/preferences/service";

import { portfolioOrder, RUNNING_PROJECT_STATUSES } from "./portfolio-order";

/**
 * THE PROJECT HEALTH TABLE (Phase 6 slice 116, founder decision C92;
 * design `docs/research/2026-10-13-slice-116-project-health-design.md`).
 * Every project in the member's scope on one screen: its newest published
 * health, when that was, whether its update is late, how many of its tasks
 * are done, and how much of its budget is used. READ-ONLY — no verb, no
 * audit row: the member could assemble the same list project by project.
 *
 * ONE member transaction, every read in SEQUENCE (AGENTS.md's `Promise.all`
 * trap) and none per project. EACH COLUMN IS GATED BY THE CODE THAT GATES
 * ITS OWN SOURCE, as the update's internal snapshot is: health by the
 * project page's rule (its header's chip, for anyone who can open the
 * project); the last update's DATE and the schedule by `project_update:view`
 * (the date is otherwise only on the Updates tab, the schedule is the
 * header's badge — slice 116's security review); tasks by `work_item:view`;
 * the budget by `budget:view` — and as a PERCENT only, so no amount is shown
 * and `rate:view_bill` is never needed. Nothing here reads a cost rate.
 */

/** Rows read at most; one more is read to know there are more. */
export const PORTFOLIO_LIMIT = 300;

export type PortfolioCtx = {
  readonly tenantId: string;
  /** From requireTenantContext() — never from form params. */
  readonly actor: MemberActor;
};

export type PortfolioRow = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly clientId: string;
  readonly clientName: string;
  /** Planned, active or paused and not archived (C92 (a)). */
  readonly running: boolean;
  /** The newest PUBLISHED post's — null until one is published (health is chosen, never computed). */
  readonly health: ProjectHealth | null;
  /** Null without `project_update:view`, and until a post is published. */
  readonly lastUpdateAt: Date | null;
  /** Null without `project_update:view`, and for a project with no schedule. */
  readonly schedule: { readonly state: UpdateScheduleState; readonly dueOn: string } | null;
  /** Null without `work_item:view`. */
  readonly tasks: { readonly done: number; readonly total: number } | null;
  /** Null without `budget:view`, and for a project with no ACTIVE budget. */
  readonly budget: { readonly percent: number } | null;
};

export type Portfolio = {
  readonly rows: readonly PortfolioRow[];
  /** The clients the (unfiltered) list spans, by name — the filter's options. */
  readonly clients: readonly { readonly id: string; readonly name: string }[];
  readonly capped: boolean;
  /** Which columns the viewer's codes draw — `updates` is the last update's date and its schedule. */
  readonly show: { readonly updates: boolean; readonly tasks: boolean; readonly budget: boolean };
};

const COLUMN_CODES = ["project_update:view", "work_item:view", "budget:view"] as const;

const PROJECT_SCOPE = { clientField: "clientId", projectField: "id" } as const;

export async function readPortfolio(
  ctx: PortfolioCtx,
  opts: { readonly finished?: boolean; readonly clientId?: string | null } = {},
  now: Date = new Date(),
): Promise<Portfolio> {
  const { tenantId } = ctx;
  return withTenant(tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    await requireAccess(tx, tenantId, ctx.actor, "report:view_portfolio");
    // A role holding the table but not projects must not read project names
    // it could not open.
    await requireAccess(tx, tenantId, ctx.actor, "project:view");
    const codes = await accessibleCodes(tx, tenantId, ctx.actor, COLUMN_CODES);
    const show = {
      updates: codes.has("project_update:view"),
      tasks: codes.has("work_item:view"),
      budget: codes.has("budget:view"),
    };

    // AND, never a spread: the scope may itself be a `clientId` term, which
    // a spread client filter would OVERWRITE — widening it.
    const scope = await scopeWhere(tx, ctx.actor, PROJECT_SCOPE);
    const running = { status: { in: [...RUNNING_PROJECT_STATUSES] }, archivedAt: null };
    const clientRows = await tx.project.findMany({
      where: { AND: [{ tenantId }, scope, opts.finished ? {} : running] },
      distinct: ["clientId"],
      select: { clientId: true, client: { select: { name: true } } },
    });
    const clients = clientRows
      .map((c) => ({ id: c.clientId, name: c.client.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const clientId = opts.clientId && clients.some((c) => c.id === opts.clientId) ? opts.clientId : null;

    // RUNNING projects first, and the finished ones only into what room the
    // cap leaves — so a cap never drops a running project for a finished
    // one (the code review's LOW). Past the cap the order is client, then
    // name, and the page says so; ranking a list that long in the database
    // is not worth its cost for an agency's project count (design §8).
    const select = {
      id: true,
      key: true,
      name: true,
      status: true,
      clientId: true,
      archivedAt: true,
      portalEnabled: true,
      updateCadence: true,
      updateWeekday: true,
      updateScheduleSince: true,
      client: { select: { name: true } },
    } as const;
    const order = [{ client: { name: "asc" } }, { name: "asc" }, { id: "asc" }] as const;
    const narrowed = clientId ? { clientId } : {};
    const projects = await tx.project.findMany({
      where: { AND: [{ tenantId }, scope, running, narrowed] },
      orderBy: [...order],
      take: PORTFOLIO_LIMIT + 1,
      select,
    });
    if (opts.finished && projects.length <= PORTFOLIO_LIMIT) {
      projects.push(
        ...(await tx.project.findMany({
          where: { AND: [{ tenantId }, scope, { NOT: running }, narrowed] },
          orderBy: [...order],
          take: PORTFOLIO_LIMIT + 1 - projects.length,
          select,
        })),
      );
    }
    const capped = projects.length > PORTFOLIO_LIMIT;
    const page = projects.slice(0, PORTFOLIO_LIMIT);
    const ids = page.map((p) => p.id);
    if (ids.length === 0) return { rows: [], clients, capped: false, show };

    const prefs = await readPreferences(tx, tenantId);

    // The newest PUBLISHED post per project — `latestPublishedHealth`'s order.
    const newest = await tx.$queryRaw<{ project_id: string; health: ProjectHealth; published_at: Date }[]>`
      SELECT DISTINCT ON (project_id) project_id, health::text AS health, published_at
        FROM project_update
       WHERE tenant_id = ${tenantId} AND project_id = ANY(${ids}::text[]) AND status = 'PUBLISHED'
       ORDER BY project_id, published_at DESC, seq DESC`;
    const newestBy = new Map(newest.map((r) => [r.project_id, r]));

    // The post the SCHEDULE counts (`lastCountingPostAt`, C70 (g)): while a
    // project's portal is on, only one the client can see.
    const scheduled = show.updates
      ? page.filter((p) => p.updateCadence !== "NONE" && p.status === "ACTIVE" && p.archivedAt === null)
      : [];
    const sharedIds = scheduled.filter((p) => p.portalEnabled).map((p) => p.id);
    const shared =
      sharedIds.length === 0
        ? []
        : await tx.$queryRaw<{ project_id: string; published_at: Date }[]>`
            SELECT DISTINCT ON (project_id) project_id, published_at
              FROM project_update
             WHERE tenant_id = ${tenantId} AND project_id = ANY(${sharedIds}::text[])
               AND status = 'PUBLISHED' AND visibility = 'CLIENT_VISIBLE'
             ORDER BY project_id, published_at DESC, seq DESC`;
    const sharedBy = new Map(shared.map((r) => [r.project_id, r.published_at]));
    const scheduleBy = new Map(
      scheduled.map((p) => {
        const last = p.portalEnabled ? (sharedBy.get(p.id) ?? null) : (newestBy.get(p.id)?.published_at ?? null);
        return [p.id, updateScheduleAt(scheduleInputOf(p, last, prefs.timezone), now)];
      }),
    );

    // % done (C92 (b)): tasks and subtasks — an epic is a container —
    // neither cancelled nor an unaccepted request (TRIAGE); an ARCHIVED task
    // counts only if it was done (done work put away is still done).
    const counts = show.tasks
      ? await tx.workItem.groupBy({
          by: ["projectId", "stateCategory"],
          where: {
            tenantId,
            projectId: { in: ids },
            deletedAt: null,
            type: { not: "EPIC" },
            stateCategory: { notIn: ["CANCELLED", "TRIAGE"] },
            OR: [{ archivedAt: null }, { stateCategory: "DONE" }],
          },
          _count: { _all: true },
        })
      : [];
    const tasksBy = new Map<string, { done: number; total: number }>();
    for (const c of counts) {
      const t = tasksBy.get(c.projectId) ?? { done: 0, total: 0 };
      t.total += c._count._all;
      if (c.stateCategory === "DONE") t.done += c._count._all;
      tasksBy.set(c.projectId, t);
    }

    // `money: false` — the table shows the percent alone.
    const budgets: Awaited<ReturnType<typeof activeBudgetBurns>> = show.budget
      ? await activeBudgetBurns(tx, tenantId, ids, localDateString(now, prefs.timezone), { money: false })
      : new Map();

    const rows: PortfolioRow[] = page.map((p) => {
      const post = newestBy.get(p.id);
      const schedule = scheduleBy.get(p.id) ?? null;
      const budget = budgets.get(p.id);
      return {
        id: p.id,
        key: p.key,
        name: p.name,
        status: p.status,
        clientId: p.clientId,
        clientName: p.client.name,
        running: (RUNNING_PROJECT_STATUSES as readonly string[]).includes(p.status) && p.archivedAt === null,
        health: post?.health ?? null,
        lastUpdateAt: show.updates ? (post?.published_at ?? null) : null,
        schedule: schedule ? { state: schedule.state, dueOn: schedule.dueOn } : null,
        tasks: show.tasks ? (tasksBy.get(p.id) ?? { done: 0, total: 0 }) : null,
        budget: budget ? { percent: budget.burn.percent } : null,
      };
    });
    return { rows: portfolioOrder(rows), clients, capped, show };
  });
}
