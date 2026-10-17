import { isAuthorized, scopeWhere } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { CALENDAR_ENTRY_CAP, CALENDAR_PROJECTION_CAP, CALENDAR_PROJECTION_HORIZON_DAYS, projectCopies } from "@/lib/calendar-plan";
import { dateColumn, isoDateOf } from "@/lib/duration";
import { addDays } from "@/lib/week";
import { isRepeatRhythm, type RepeatRhythm } from "@/lib/repeat-rules";

import { PROJECT_MAKES_COPIES_WHERE } from "./repeat";
import { principalOf, type WorkCtx } from "./states";

/**
 * THE CALENDAR OF TASKS — its one read (slice 128; founder decision C105 —
 * docs/research/2026-10-17-slice-128-task-calendar-design.md §3.2–§3.3, §4).
 *
 * WHO: `work_item:view` on all four gates, and `project:view` — every entry
 * links into a project, and a lens must never be a way round the page that
 * opens it (`listMyWork`'s pair, for the same reason). Either refused → null:
 * the page draws its forbidden state.
 *
 * WHAT (C105 (b)): every task with a due day in `[from, to]` in the member's
 * SCOPE — composed into the query with `AND`, never spread (the inbox's
 * page-2 bug) — not deleted, not archived, in a project not archived, not
 * Cancelled and not in Triage (an unaccepted request is the lane's). Done
 * tasks are in: the page draws them struck through. "Only mine" narrows to the
 * member's own; the project filter to ONE project found in that same scope (an
 * unknown or out-of-scope key is no filter, never an error that could tell a
 * project exists).
 *
 * AND THE COPIES REPEATING TASKS WILL MAKE (C105 (c)): from every series whose
 * NEWEST task passes the same scope and filters, is not deleted and sits in a
 * project that makes copies (`PROJECT_MAKES_COPIES_WHERE`) — "Only mine"
 * meaning that task is the member's, since its copies go to the same person.
 * The days come from the pure walk (`projectCopies`).
 *
 * Sequential reads on the one transaction (AGENTS.md's `Promise.all` trap).
 * Bounded: `CALENDAR_ENTRY_CAP` tasks and `CALENDAR_PROJECTION_CAP` copies a
 * period, each with its own truncation flag. Member-plane only: no portal
 * projection reads this, and a class-A repeat row is never a contact's.
 */

export type CalendarEntry = {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly stateCategory: string;
  /** The due day, `YYYY-MM-DD`. */
  readonly dueOn: string;
  /** The rhythm when this task holds a repeat (the newest of its series) — the marker. */
  readonly repeatRhythm: RepeatRhythm | null;
};

export type CalendarCopy = {
  /** Unique per drawn copy: the series and the day it will appear. */
  readonly key: string;
  /** The series' newest task — what the copy links to and is made from. */
  readonly holderNumber: number;
  readonly title: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly rhythm: RepeatRhythm;
  readonly appearsOn: string;
  readonly dueOn: string;
};

export type CalendarRead = {
  readonly entries: readonly CalendarEntry[];
  readonly copies: readonly CalendarCopy[];
  /** More tasks than `CALENDAR_ENTRY_CAP` were due in the period. */
  readonly truncated: boolean;
  /** Not every series' copies were looked at (more series than the cap) — some may be missing. */
  readonly copiesTruncated: boolean;
  /** The period starts past the projection horizon: no copies are drawn, and the page says why. */
  readonly copiesBeyondHorizon: boolean;
  /** The projects the filter offers — every one in scope and not archived, by name. */
  readonly projects: readonly { readonly key: string; readonly name: string }[];
  /** The filter as applied: the key when it named a project in scope, else null. */
  readonly projectKey: string | null;
  /** `work_item:edit` — entries are draggable and have "Move to…". The move asks again, with scope. */
  readonly canEdit: boolean;
};

const HIDDEN_CATEGORIES = ["CANCELLED", "TRIAGE"] as const;

export async function readCalendar(
  ctx: WorkCtx,
  opts: { readonly from: string; readonly to: string; readonly today: string; readonly projectKey: string | null; readonly mine: boolean },
): Promise<CalendarRead | null> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    try {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
    } catch (e) {
      if (e instanceof AuthzError) return null;
      throw e;
    }
    if (!(await isAuthorized(tx, ctx.actor, "project:view"))) return null;
    const canEdit = await isAuthorized(tx, ctx.actor, "work_item:edit");

    const projectScope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "id" });
    const projects = await tx.project.findMany({
      where: { AND: [projectScope, { tenantId: ctx.tenantId, archivedAt: null }] },
      select: { id: true, key: true, name: true },
      orderBy: [{ name: "asc" }, { key: "asc" }],
    });
    // The filter, found among the projects in scope — or no filter at all.
    const filtered = opts.projectKey === null ? null : (projects.find((p) => p.key === opts.projectKey) ?? null);

    const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "projectId" });
    const narrow = {
      ...(filtered ? { projectId: filtered.id } : {}),
      ...(opts.mine ? { assigneeMemberId: ctx.actor.memberId } : {}),
    };

    const rows = await tx.workItem.findMany({
      where: {
        AND: [
          scope,
          {
            tenantId: ctx.tenantId,
            deletedAt: null,
            archivedAt: null,
            targetDate: { gte: dateColumn(opts.from), lte: dateColumn(opts.to) },
            stateCategory: { notIn: [...HIDDEN_CATEGORIES] },
            project: { archivedAt: null },
            ...narrow,
          },
        ],
      },
      orderBy: [{ targetDate: "asc" }, { project: { key: "asc" } }, { number: "asc" }],
      take: CALENDAR_ENTRY_CAP + 1,
      select: {
        id: true,
        number: true,
        title: true,
        stateCategory: true,
        targetDate: true,
        project: { select: { key: true, name: true } },
        repeatHeld: { select: { rhythm: true } },
      },
    });

    const series = await tx.workItemRepeat.findMany({
      where: {
        tenantId: ctx.tenantId,
        workItem: { AND: [scope, { deletedAt: null, project: PROJECT_MAKES_COPIES_WHERE, ...narrow }] },
      },
      orderBy: [{ nextOn: "asc" }, { id: "asc" }],
      // Every series a projected copy could come from, bounded: each yields
      // at least one copy in a month's range or none, so the copy cap is the
      // real bound; this one stops a pathological read.
      take: CALENDAR_PROJECTION_CAP + 1,
      select: {
        id: true,
        rhythm: true,
        anchorDay: true,
        nextOn: true,
        workItem: { select: { number: true, title: true, project: { select: { key: true, name: true } } } },
      },
    });

    const copies: CalendarCopy[] = [];
    // A HORIZON (both reviews' LOW): a `date` decades ahead would make every
    // series walk thousands of date steps in this one render — the event
    // loop held for seconds by a URL. Copies are drawn up to three years out,
    // and the page says so past it.
    const beyondHorizon = opts.from > addDays(opts.today, CALENDAR_PROJECTION_HORIZON_DAYS);
    let copiesTruncated = !beyondHorizon && series.length > CALENDAR_PROJECTION_CAP;
    for (const s of beyondHorizon ? [] : series.slice(0, CALENDAR_PROJECTION_CAP)) {
      if (copiesTruncated && copies.length >= CALENDAR_PROJECTION_CAP) break;
      if (!isRepeatRhythm(s.rhythm)) continue;
      for (const c of projectCopies({ nextOn: isoDateOf(s.nextOn), rhythm: s.rhythm, anchorDay: s.anchorDay }, opts.today, opts.from, opts.to)) {
        if (copies.length >= CALENDAR_PROJECTION_CAP) {
          copiesTruncated = true;
          break;
        }
        copies.push({
          key: `${s.id}:${c.appearsOn}`,
          holderNumber: s.workItem.number,
          title: s.workItem.title,
          projectKey: s.workItem.project.key,
          projectName: s.workItem.project.name,
          rhythm: s.rhythm,
          appearsOn: c.appearsOn,
          dueOn: c.dueOn,
        });
      }
    }

    return {
      entries: rows.slice(0, CALENDAR_ENTRY_CAP).map((r) => ({
        id: r.id,
        number: r.number,
        title: r.title,
        projectKey: r.project.key,
        projectName: r.project.name,
        stateCategory: r.stateCategory,
        dueOn: isoDateOf(r.targetDate!),
        repeatRhythm: r.repeatHeld && isRepeatRhythm(r.repeatHeld.rhythm) ? r.repeatHeld.rhythm : null,
      })),
      copies,
      truncated: rows.length > CALENDAR_ENTRY_CAP,
      copiesTruncated,
      copiesBeyondHorizon: beyondHorizon && series.length > 0,
      projects: projects.map((p) => ({ key: p.key, name: p.name })),
      projectKey: filtered?.key ?? null,
      canEdit,
    };
  });
}
