import { addDays, isIsoDate, weekContaining, type WeekStart } from "@/lib/week";

/**
 * THE PROJECTS TIMELINE'S PURE HALF (slice 130; founder decision C107 (a), (d)
 * — docs/research/2026-10-17-slice-130-all-tasks-and-lineup-design.md §3.6).
 * No database, no clock: the Projects page's parameters read strictly, the
 * 13-week window, and where a bar, a milestone dot, the today line and the
 * month names sit in it — as percentages of the track, so the server draws
 * the whole chart and the browser only lays it out. Pinned by
 * `lineup-plan.test.ts`.
 *
 * Days are `YYYY-MM-DD`. A project's dates are stored as UTC midnight of
 * their day, so their UTC day IS their day; "today" is the caller's.
 */

/** The window's width in weeks (C107 (d): "about 13 weeks across"). */
export const LINEUP_WEEKS = 13;
export const LINEUP_DAYS = LINEUP_WEEKS * 7;
/** How far Earlier and Later move the window. */
export const LINEUP_STEP_WEEKS = 4;
/** By default the window starts this many weeks before the week holding today. */
export const LINEUP_LEAD_WEEKS = 2;

export const PROJECTS_VIEWS = ["list", "timeline"] as const;
export type ProjectsView = (typeof PROJECTS_VIEWS)[number];

export type ProjectsParams = {
  readonly view: ProjectsView;
  /** The list's "Show archived". */
  readonly archived: boolean;
  /** Any day of the timeline's first week, or null for the default window. */
  readonly from: string | null;
};

const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** The Projects page's search parameters, read strictly: anything unknown is the default, nothing is echoed. */
export function parseProjectsParams(params: Readonly<Record<string, string | string[] | undefined>>): ProjectsParams {
  const from = one(params["from"]);
  return {
    view: one(params["view"]) === "timeline" ? "timeline" : "list",
    archived: one(params["archived"]) === "1",
    from: isIsoDate(from) ? from : null,
  };
}

/** `/projects` with these parameters — each only where its view reads it, the defaults as no parameter. */
export function projectsHref(p: ProjectsParams): string {
  const q = new URLSearchParams();
  if (p.view === "timeline") {
    q.set("view", "timeline");
    if (p.from) q.set("from", p.from);
  } else if (p.archived) {
    q.set("archived", "1");
  }
  const s = q.toString();
  return s === "" ? "/projects" : `/projects?${s}`;
}

export type LineupWindow = {
  /** The first day shown — always a week start. */
  readonly from: string;
  /** The last day shown, `LINEUP_DAYS - 1` after `from`. */
  readonly to: string;
  /** The `from` of the window four weeks earlier, and later. */
  readonly prev: string;
  readonly next: string;
  /** The default window's first day — the Today link's target. */
  readonly home: string;
};

/** The window for a requested first day (snapped to its week start), or the default one around today. */
export function lineupWindow(requested: string | null, today: string, weekStart: WeekStart): LineupWindow {
  const home = addDays(weekContaining(today, weekStart).from, -7 * LINEUP_LEAD_WEEKS);
  const from = requested === null ? home : weekContaining(requested, weekStart).from;
  return {
    from,
    to: addDays(from, LINEUP_DAYS - 1),
    prev: addDays(from, -7 * LINEUP_STEP_WEEKS),
    next: addDays(from, 7 * LINEUP_STEP_WEEKS),
    home,
  };
}

const DAY_MS = 86_400_000;
/** Whole days from `from` to `day` — negative before it. Arithmetic, never a loop. */
export const dayIndex = (from: string, day: string): number =>
  Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

const pct = (days: number): number => Math.round((days / LINEUP_DAYS) * 100_000) / 1000;

export type BarGeometry =
  | {
      readonly kind: "inside";
      /** Left edge and width, in percent of the track. */
      readonly left: number;
      readonly width: number;
      /** The window cuts the bar here — that end is drawn square, not as a data end. */
      readonly cutStart: boolean;
      readonly cutEnd: boolean;
    }
  /** The whole span ended before the window, or starts after it. */
  | { readonly kind: "before" }
  | { readonly kind: "after" };

/** A project's bar, from its start day to its launch day inclusive (`start <= end`). */
export function barGeometry(start: string, end: string, w: LineupWindow): BarGeometry {
  const a = dayIndex(w.from, start);
  const b = dayIndex(w.from, end) + 1; // the launch day is drawn whole
  if (b <= 0) return { kind: "before" };
  if (a >= LINEUP_DAYS) return { kind: "after" };
  const left = Math.max(0, a);
  const right = Math.min(LINEUP_DAYS, b);
  return { kind: "inside", left: pct(left), width: pct(right - left), cutStart: a < 0, cutEnd: b > LINEUP_DAYS };
}

/** The middle of a day, in percent of the track — or null outside the window (a dot, the today line). */
export function dayOffset(day: string, w: LineupWindow): number | null {
  const i = dayIndex(w.from, day);
  return i < 0 || i >= LINEUP_DAYS ? null : pct(i + 0.5);
}

/** Where each week after the first begins — the track's hairlines. */
export const weekLines = (): readonly number[] => Array.from({ length: LINEUP_WEEKS - 1 }, (_, i) => pct((i + 1) * 7));

/**
 * A month name starting past this share of the track is not drawn: it begins
 * in the window's last week and would run off the card's edge (the review's
 * NIT — "Jan 2027" is ~50 px). The next window names it.
 */
export const LINEUP_LAST_LABEL_PCT = 92;

/** Each month's first day inside the window, with its offset — the month names over the track. */
export function monthTicks(w: LineupWindow): readonly { readonly day: string; readonly left: number }[] {
  const out: { day: string; left: number }[] = [];
  let y = Number(w.from.slice(0, 4));
  let m = Number(w.from.slice(5, 7));
  // 91 days hold at most four first-of-months, so five steps always reach past the window.
  for (let i = 0; i < 5; i++) {
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    const day = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
    const at = dayIndex(w.from, day);
    if (at >= LINEUP_DAYS || pct(at) > LINEUP_LAST_LABEL_PCT) break;
    out.push({ day, left: pct(at) });
  }
  return out;
}
