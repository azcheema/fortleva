import { scopeWhere } from "@/authz/authorize";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import type { MilestoneStatus, ProjectStatus } from "@/generated/prisma/enums";
import { isoDateOf, localDateString } from "@/lib/duration";

import type { ProjectCtx } from "./service";

/**
 * ALL PROJECTS ON ONE TIMELINE — the Projects page's Timeline view's one read
 * (slice 130; founder decision C107 (d) — docs/research/2026-10-17-slice-130-all-tasks-and-lineup-design.md
 * §3.6, §4).
 *
 * WHO: exactly what `/projects` asks — `project:view` (`requireAccess`, which
 * throws as `listProjects` does) and the member's scope, composed with `AND`.
 *
 * WHAT: every project that is PLANNED, ACTIVE or PAUSED and not archived — a
 * finished or cancelled project is on nobody's lineup — with its start and
 * launch days and its milestones that are not cancelled (the projects list's
 * meter leaves those out too), in rank order. Where a project's dates are
 * missing or reversed is the PAGE's to say; this hands over the days as they
 * are. Every milestone is the member plane's to see: the project's own
 * Timeline tab shows them all, and no portal projection reads this.
 *
 * Bounded at `LINEUP_PROJECT_CAP` projects; past it the page says so. And at
 * `LINEUP_MILESTONE_CAP` milestones a project, in rank order (the security
 * review's LOW: nothing caps how many a project may hold, and this page reads
 * up to 300 projects' worth into every viewer's render).
 */

export const LINEUP_PROJECT_CAP = 300;
export const LINEUP_MILESTONE_CAP = 100;

const LINEUP_STATUSES: readonly ProjectStatus[] = ["PLANNED", "ACTIVE", "PAUSED"];

export type LineupMilestone = {
  readonly id: string;
  readonly name: string;
  readonly done: boolean;
  /** The day it is drawn on — its due day, or the day it was done when it has none — or null (not drawn). */
  readonly day: string | null;
};

export type LineupProject = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly clientName: string;
  /** `YYYY-MM-DD`, or null when not set. */
  readonly start: string | null;
  readonly launch: string | null;
  readonly milestones: readonly LineupMilestone[];
};

export type ProjectLineup = {
  readonly projects: readonly LineupProject[];
  /** More projects than `LINEUP_PROJECT_CAP` qualified. */
  readonly truncated: boolean;
};

/** The day of a date written as UTC midnight (the Overview's `dateField`, a milestone's due date). */
const dayOf = (d: Date | null): string | null => (d ? isoDateOf(d) : null);

export async function readProjectLineup(
  ctx: ProjectCtx,
  opts: {
    /**
     * The reader's zone, the one the page's "today" is in. A milestone's
     * `completedAt` is an INSTANT (stamped when it was marked done), not a
     * day at UTC midnight: done at 00:30 in Stockholm is the 14th there and
     * the 13th in UTC (the code review's LOW).
     */
    readonly timeZone: string;
  },
): Promise<ProjectLineup> {
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project:view");
    const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "id" });
    const rows = await tx.project.findMany({
      where: { AND: [scope, { tenantId: ctx.tenantId, archivedAt: null, status: { in: [...LINEUP_STATUSES] } }] },
      orderBy: [{ startDate: { sort: "asc", nulls: "last" } }, { launchDate: { sort: "asc", nulls: "last" } }, { name: "asc" }, { key: "asc" }],
      take: LINEUP_PROJECT_CAP + 1,
      select: {
        id: true,
        key: true,
        name: true,
        status: true,
        startDate: true,
        launchDate: true,
        client: { select: { name: true } },
        milestones: {
          where: { status: { not: "CANCELLED" satisfies MilestoneStatus } },
          orderBy: { rank: "asc" },
          take: LINEUP_MILESTONE_CAP,
          select: { id: true, name: true, status: true, dueAt: true, completedAt: true },
        },
      },
    });
    return {
      truncated: rows.length > LINEUP_PROJECT_CAP,
      projects: rows.slice(0, LINEUP_PROJECT_CAP).map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        status: r.status,
        clientName: r.client.name,
        start: dayOf(r.startDate),
        launch: dayOf(r.launchDate),
        milestones: r.milestones.map((m) => ({
          id: m.id,
          name: m.name,
          done: m.status === "DONE",
          // Drawn where it was PLANNED, as the bar is: a milestone done late
          // still sits on its due day (the dot is filled, its words say done).
          // The project's own Timeline tab orders by the day it was done; this
          // is the plan seen across projects, and says so (design §3.6).
          day: dayOf(m.dueAt) ?? (m.status === "DONE" && m.completedAt ? localDateString(m.completedAt, opts.timeZone) : null),
        })),
      })),
    };
  });
}
