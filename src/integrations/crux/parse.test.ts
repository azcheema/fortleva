import { describe, expect, it } from "vitest";

import { parseHistory } from "./parse";

/**
 * READING THE HISTORY API'S RECORD (Phase 6 slice 118): the shape Google
 * documents — dates as {year, month, day}, CLS p75s as STRINGS, "NaN"
 * densities for a period with no data, a metric absent altogether.
 */

const period = (y: number, m: number, d: number) => ({ year: y, month: m, day: d });

const record = (over: Record<string, unknown> = {}) => ({
  record: {
    key: { origin: "https://example.com", formFactor: "PHONE" },
    collectionPeriods: [
      { firstDate: period(2026, 8, 30), lastDate: period(2026, 9, 26) },
      { firstDate: period(2026, 9, 6), lastDate: period(2026, 10, 3) },
    ],
    metrics: {
      largest_contentful_paint: {
        histogramTimeseries: [
          { start: 0, end: 2500, densities: [0.7, "NaN"] },
          { start: 2500, end: 4000, densities: [0.2, "NaN"] },
          { start: 4000, densities: [0.1, "NaN"] },
        ],
        percentilesTimeseries: { p75s: [2140.4, null] },
      },
      interaction_to_next_paint: {
        histogramTimeseries: [
          { start: 0, end: 200, densities: [0.8, 0.81] },
          { start: 200, end: 500, densities: [0.15, 0.14] },
          { start: 500, densities: [0.05, 0.05] },
        ],
        percentilesTimeseries: { p75s: [183, 190] },
      },
      cumulative_layout_shift: {
        histogramTimeseries: [
          { start: "0.00", end: "0.10", densities: ["0.9", "0.88"] },
          { start: "0.10", end: "0.25", densities: ["0.08", "0.1"] },
          { start: "0.25", densities: ["0.02", "0.02"] },
        ],
        percentilesTimeseries: { p75s: ["0.0549", "0.06"] },
      },
    },
    ...over,
  },
});

describe("parseHistory", () => {
  it("reads the periods oldest first, LCP and INP as whole milliseconds, CLS to three decimals, the shares in band order", () => {
    const h = parseHistory(record());
    expect(h.periods).toHaveLength(2);
    expect(h.periods[0]).toEqual({
      start: "2026-08-30",
      end: "2026-09-26",
      lcp: { p75: 2140, good: 0.7, needsWork: 0.2, poor: 0.1 },
      inp: { p75: 183, good: 0.8, needsWork: 0.15, poor: 0.05 },
      cls: { p75: 0.055, good: 0.9, needsWork: 0.08, poor: 0.02 },
    });
    // The second period has no LCP data (null p75, "NaN" densities).
    expect(h.periods[1]!.lcp).toBeNull();
    expect(h.periods[1]!.inp?.p75).toBe(190);
    expect(h.periods[1]!.cls?.p75).toBe(0.06);
  });

  it("a metric Google never measured is null in every period", () => {
    const h = parseHistory(record({ metrics: {} }));
    expect(h.periods.map((p) => [p.lcp, p.inp, p.cls])).toEqual([
      [null, null, null],
      [null, null, null],
    ]);
  });

  it("refuses an answer out of shape rather than guessing", () => {
    expect(() => parseHistory({})).toThrow(/shape/);
    expect(() => parseHistory({ record: { collectionPeriods: [] } })).toThrow(/shape/);
    // A series shorter than the periods.
    const short = record();
    (short.record.metrics.interaction_to_next_paint.percentilesTimeseries as { p75s: unknown[] }).p75s = [183];
    expect(() => parseHistory(short)).toThrow(/shape/);
    // A density that is not a number nor "NaN".
    const odd = record();
    (odd.record.metrics.largest_contentful_paint.histogramTimeseries[0] as { densities: unknown[] }).densities = ["lots", 0.1];
    expect(() => parseHistory(odd)).toThrow(/shape/);
    // A date out of range.
    const when = record();
    (when.record.collectionPeriods[0] as { lastDate: unknown }).lastDate = period(2026, 13, 1);
    expect(() => parseHistory(when)).toThrow(/shape/);
  });

  it("a metric with a p75 but a missing density (or the reverse) is NULL as a whole — never half a row the database refuses", () => {
    // The CHECK `website_speed_week_metric_whole` holds a metric's four values
    // together; one period that violated it would reject the project's whole
    // batch (the pre-apply review's 7).
    const half = record();
    (half.record.metrics.interaction_to_next_paint.histogramTimeseries[1] as { densities: unknown[] }).densities = ["NaN", 0.14];
    expect(parseHistory(half).periods[0]!.inp).toBeNull();
    const other = record();
    (other.record.metrics.cumulative_layout_shift.percentilesTimeseries as { p75s: unknown[] }).p75s = [null, "0.06"];
    expect(parseHistory(other).periods[0]!.cls).toBeNull();
  });

  it("clamps a density outside 0..1 and never keeps a negative p75", () => {
    const h = parseHistory(record());
    expect(h.periods[0]!.lcp!.good).toBeLessThanOrEqual(1);
    const neg = record();
    (neg.record.metrics.interaction_to_next_paint.percentilesTimeseries as { p75s: unknown[] }).p75s = [-5, 190];
    expect(parseHistory(neg).periods[0]!.inp).toBeNull();
  });
});
