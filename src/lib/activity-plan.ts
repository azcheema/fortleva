import { TASKS_PROJECT_KEY_RE } from "@/lib/task-list-plan";
import { addDays, isIsoDate } from "@/lib/week";

/**
 * THE ACTIVITY PAGE'S PURE HALF (slice 133; founder decision C110 — design
 * docs/research/2026-10-18-slice-133-activity-design.md §3.1–§3.2). No
 * database, no clock: the page's parameters read strictly, the links built
 * from what was parsed, the window of days a page shows, and the merge of the
 * read's kinds newest first. Shared by the read (`src/modules/work/activity-feed.ts`)
 * and the page; pinned by `activity-plan.test.ts`.
 *
 * Days are `YYYY-MM-DD` in the READER's zone.
 */

/** Days one page shows, the last one "until" (today by default). */
export const ACTIVITY_WINDOW_DAYS = 7;
/** Events one page draws at most — past it, "Show earlier" goes on from the last one drawn. */
export const ACTIVITY_PAGE_CAP = 300;

export type ActivityParams = {
  /** A project key to narrow to — still to be found in the member's scope. */
  readonly project: string | null;
  /** A client id to narrow to — still to be found among the projects' clients in scope. */
  readonly client: string | null;
  /** The window's last day; null is today. */
  readonly until: string | null;
  /**
   * Events of the window's LAST day already drawn by the page before (a page
   * cut at the cap goes on inside that day — nothing is out of reach: the
   * code review's L1). 0 without `until`.
   */
  readonly skip: number;
};

/**
 * How far into ONE day the paging goes (ten pages): past it the next page is
 * the day before. Only an import of thousands of tasks at once makes such a
 * day; the bound keeps a page's reads bounded (each kind reads skip + cap).
 */
export const ACTIVITY_MAX_SKIP = 3_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKIP = /^[1-9]\d{0,3}$/;

const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** The page's search parameters, read strictly: anything unknown is the default, nothing is echoed. */
export function parseActivityParams(params: Readonly<Record<string, string | string[] | undefined>>): ActivityParams {
  const project = one(params["project"]);
  const client = one(params["client"]);
  const until = one(params["until"]);
  const skip = one(params["skip"]);
  const day = until !== undefined && isIsoDate(until) ? until : null;
  return {
    project: project !== undefined && TASKS_PROJECT_KEY_RE.test(project) ? project : null,
    client: client !== undefined && UUID.test(client) ? client.toLowerCase() : null,
    until: day,
    // Only with a day (a continued page — today's too), never past the ceiling.
    skip: day !== null && skip !== undefined && SKIP.test(skip) ? Math.min(Number(skip), ACTIVITY_MAX_SKIP) : 0,
  };
}

/** `/activity` with these parameters — the defaults written as no parameter. */
export function activityHref(p: ActivityParams): string {
  const q = new URLSearchParams();
  if (p.project) q.set("project", p.project);
  if (p.client) q.set("client", p.client);
  if (p.until) q.set("until", p.until);
  if (p.until && p.skip > 0) q.set("skip", String(p.skip));
  const s = q.toString();
  return s === "" ? "/activity" : `/activity?${s}`;
}

/**
 * The days a page shows: `ACTIVITY_WINDOW_DAYS` ending at "until" — never
 * after today, so a URL with a future day shows this week.
 */
export function activityWindow(until: string | null, today: string): { readonly from: string; readonly to: string } {
  const to = until !== null && until < today ? until : today;
  return { from: addDays(to, -(ACTIVITY_WINDOW_DAYS - 1)), to };
}

type Timed = { readonly id: string; readonly at: Date };

/**
 * The read's kinds as one list, newest first (an id breaks a tie, so a page
 * draws the same order every time), cut at `cap`. `truncated` says some were
 * left out — the next page goes on from there.
 */
export function mergeNewestFirst<T extends Timed>(lists: readonly (readonly T[])[], cap: number): { readonly events: T[]; readonly truncated: boolean } {
  const all: T[] = [];
  for (const list of lists) for (const e of list) all.push(e);
  all.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return { events: all.slice(0, cap), truncated: all.length > cap };
}

/** Events grouped by their day, newest day first, each group in the order it arrived. */
export function groupByDay<T>(events: readonly T[], dayOf: (e: T) => string): { readonly day: string; readonly events: T[] }[] {
  const groups: { day: string; events: T[] }[] = [];
  for (const e of events) {
    const day = dayOf(e);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.events.push(e);
    else groups.push({ day, events: [e] });
  }
  return groups;
}
