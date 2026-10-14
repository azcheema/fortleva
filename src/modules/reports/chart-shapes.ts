/**
 * THE TEAM CHARTS' PURE SHAPES (Phase 6 slice 117, founder decision C93;
 * design docs/research/2026-10-14-slice-117-team-charts-design.md). No
 * database import, so the periods and the fold are unit tests.
 *
 * Every date here is a LOCAL `YYYY-MM-DD` in the workspace's zone (the
 * caller's `localDateString(now, zone)`), and every month a `YYYY-MM`:
 * calendar arithmetic on strings, never on a `Date` in the process zone.
 */

/** C93 (b): calendar months — this month (to today), last month, the last 3 months. */
export const CHART_PERIODS = ["this", "last", "3m"] as const;
export type ChartPeriod = (typeof CHART_PERIODS)[number];
export const DEFAULT_CHART_PERIOD: ChartPeriod = "this";

export const isChartPeriod = (v: unknown): v is ChartPeriod =>
  typeof v === "string" && (CHART_PERIODS as readonly string[]).includes(v);

/** How many months "How long tasks take" draws, ending with the period's last month. */
export const MONTH_WINDOW = 6;

/** How many bars a ranked chart draws before folding the rest into "Other". */
export const TOP_BARS = 8;

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM` plus `k` months (k may be negative). */
export function addMonths(month: string, k: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const index = y * 12 + (m - 1) + k;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** The last day of a `YYYY-MM`, as `YYYY-MM-DD`. */
export function lastDayOf(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

export type PeriodRange = {
  /** First local day, inclusive. */
  readonly from: string;
  /** Last local day, inclusive — today while the period is still running. */
  readonly to: string;
  /** The period's months, oldest first. */
  readonly months: readonly string[];
};

/** The period's local date range from today's local date. */
export function periodRange(period: ChartPeriod, today: string): PeriodRange {
  const thisMonth = today.slice(0, 7);
  switch (period) {
    case "this":
      return { from: `${thisMonth}-01`, to: today, months: [thisMonth] };
    case "last": {
      const last = addMonths(thisMonth, -1);
      return { from: `${last}-01`, to: lastDayOf(last), months: [last] };
    }
    case "3m": {
      const first = addMonths(thisMonth, -2);
      return { from: `${first}-01`, to: today, months: [first, addMonths(thisMonth, -1), thisMonth] };
    }
  }
}

/** The `MONTH_WINDOW` months ending with the period's last month, oldest first. */
export function monthWindow(range: PeriodRange): string[] {
  const end = range.months[range.months.length - 1]!;
  return Array.from({ length: MONTH_WINDOW }, (_, i) => addMonths(end, i - (MONTH_WINDOW - 1)));
}

/**
 * The first `n` rows as they come (the caller ranks them), and the rest
 * folded into ONE row by `merge` — or none when nothing is left over. The
 * dataviz series-count ladder: past eight bars, one "Other", never more.
 */
export function foldTop<T, O>(
  rows: readonly T[],
  n: number,
  merge: (rest: readonly T[]) => O,
): { readonly shown: T[]; readonly other: O | null } {
  if (rows.length <= n) return { shown: [...rows], other: null };
  return { shown: rows.slice(0, n), other: merge(rows.slice(n)) };
}
