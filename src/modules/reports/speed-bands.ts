/**
 * GOOGLE'S BANDS FOR THE THREE CORE WEB VITALS (Phase 6 slice 118; founder
 * decision C94) — the one place the thresholds live. Every surface names the
 * band of a 75th percentile through `bandOf`; the charts draw the band
 * edges from `BANDS`. Google's own values (web.dev/vitals): LCP good to
 * 2.5 s, poor from 4 s; INP good to 200 ms, poor from 500 ms; CLS good to
 * 0.1, poor from 0.25.
 */

export type SpeedMetric = "lcp" | "inp" | "cls";
export type SpeedBand = "GOOD" | "NEEDS_WORK" | "POOR";

export const SPEED_METRICS: readonly SpeedMetric[] = ["lcp", "inp", "cls"];

/** A metric's band edges: a p75 at or under `goodMax` is Good, over `needsMax` is Poor. */
export const BANDS: Readonly<Record<SpeedMetric, { readonly goodMax: number; readonly needsMax: number }>> = {
  lcp: { goodMax: 2500, needsMax: 4000 },
  inp: { goodMax: 200, needsMax: 500 },
  cls: { goodMax: 0.1, needsMax: 0.25 },
};

export const bandOf = (metric: SpeedMetric, p75: number): SpeedBand => {
  const { goodMax, needsMax } = BANDS[metric];
  return p75 <= goodMax ? "GOOD" : p75 <= needsMax ? "NEEDS_WORK" : "POOR";
};

/**
 * A p75 as people read it: LCP in seconds to one decimal ("2.1 s"), INP in
 * milliseconds ("180 ms"), CLS to two decimals ("0.05"). The unit is the
 * caller's to translate; this gives the number and which unit it is in.
 */
export function speedValue(metric: SpeedMetric, p75: number): { readonly value: number; readonly unit: "s" | "ms" | "none"; readonly digits: number } {
  if (metric === "lcp") return { value: Math.round(p75 / 100) / 10, unit: "s", digits: 1 };
  if (metric === "inp") return { value: Math.round(p75), unit: "ms", digits: 0 };
  return { value: Math.round(p75 * 100) / 100, unit: "none", digits: 2 };
}
