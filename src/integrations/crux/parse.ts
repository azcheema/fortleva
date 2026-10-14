import { CruxError, type CruxHistory, type CruxMetric, type CruxPeriod } from "./types";

/**
 * READING GOOGLE'S ANSWER (Phase 6 slice 118) — pure, so a unit test pins
 * the shape. The History API's record
 * (https://developer.chrome.com/docs/crux/history-api):
 *
 *   record.collectionPeriods[i]            { firstDate: {year, month, day}, lastDate: {…} }
 *   record.metrics.<name>.percentilesTimeseries.p75s[i]   a number, a numeric STRING (CLS), or null
 *   record.metrics.<name>.histogramTimeseries[b].densities[i]   a number, or the string "NaN"
 *
 * The three bins of a histogram come in band order — good, needs work, poor
 * — by their `start`. A period with no data has a null p75 and "NaN"
 * densities; a metric Google never measured is absent from `metrics`. Every
 * field is checked; anything else is a `shape` error, never a guess.
 */

const METRICS = {
  lcp: "largest_contentful_paint",
  inp: "interaction_to_next_paint",
  cls: "cumulative_layout_shift",
} as const;

/** What the request asks for — the three Core Web Vitals and nothing else. */
export const CRUX_METRIC_NAMES = Object.values(METRICS);

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const shape = (): CruxError => new CruxError("shape", null);

const two = (n: number): string => String(n).padStart(2, "0");

const dateOf = (v: unknown): string => {
  const o = obj(v);
  if (!o) throw shape();
  const { year, month, day } = o;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) throw shape();
  const y = year as number;
  const m = month as number;
  const d = day as number;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) throw shape();
  return `${y}-${two(m)}-${two(d)}`;
};

/** A p75 or a density: a finite number, a numeric string, or "no value" (null / "NaN"). */
const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    if (v === "NaN") return null;
    if (!/^-?\d+(\.\d+)?$/.test(v)) throw shape();
    return Number(v);
  }
  throw shape();
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** One metric's series, as per-period values; absent → every period null. */
function metricSeries(metrics: Record<string, unknown>, name: string, count: number, integer: boolean): (CruxMetric | null)[] {
  const m = obj(metrics[name]);
  if (!m) return new Array<CruxMetric | null>(count).fill(null);
  const p75s = obj(m.percentilesTimeseries)?.p75s;
  const bins = m.histogramTimeseries;
  if (!Array.isArray(p75s) || p75s.length !== count || !Array.isArray(bins) || bins.length !== 3) throw shape();
  const densities = bins.map((b) => {
    const d = obj(b)?.densities;
    if (!Array.isArray(d) || d.length !== count) throw shape();
    return d;
  });
  const out: (CruxMetric | null)[] = [];
  for (let i = 0; i < count; i += 1) {
    const raw = num(p75s[i]);
    const good = num(densities[0]![i]);
    const needsWork = num(densities[1]![i]);
    const poor = num(densities[2]![i]);
    if (raw === null || good === null || needsWork === null || poor === null || raw < 0) {
      out.push(null);
      continue;
    }
    out.push({
      p75: integer ? Math.round(raw) : Math.round(raw * 1000) / 1000,
      good: clamp01(good),
      needsWork: clamp01(needsWork),
      poor: clamp01(poor),
    });
  }
  return out;
}

/** The whole record → the periods, oldest first; a `shape` error for anything unexpected. */
export function parseHistory(answer: unknown): CruxHistory {
  const record = obj(obj(answer)?.record);
  if (!record) throw shape();
  const periods = record.collectionPeriods;
  if (!Array.isArray(periods) || periods.length === 0 || periods.length > 40) throw shape();
  const count = periods.length;
  const metrics = obj(record.metrics) ?? {};
  const lcp = metricSeries(metrics, METRICS.lcp, count, true);
  const inp = metricSeries(metrics, METRICS.inp, count, true);
  const cls = metricSeries(metrics, METRICS.cls, count, false);
  const out: CruxPeriod[] = [];
  for (let i = 0; i < count; i += 1) {
    const p = obj(periods[i]);
    if (!p) throw shape();
    out.push({ start: dateOf(p.firstDate), end: dateOf(p.lastDate), lcp: lcp[i]!, inp: inp[i]!, cls: cls[i]! });
  }
  return { periods: out };
}
