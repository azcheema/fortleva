/**
 * THE CHROME UX REPORT CLIENT'S SHAPES (Phase 6 slice 118; founder decision
 * C94; docs/research/2026-10-14-slice-118-website-speed-design.md §3). One
 * interface, two transports: `live.ts` (Google's History API) and `fake.ts`
 * (deterministic, for the harnesses); `index.ts` picks the one `src/config`
 * names. The weekly fetch (`src/modules/reports/speed-fetch.ts`) is the one
 * caller.
 */

export type CruxFormFactor = "PHONE" | "DESKTOP";

/** One metric in one period: Google's 75th percentile and the share of visits in each of its bands. */
export type CruxMetric = {
  /** LCP and INP in whole milliseconds; CLS unitless, to three decimals. */
  readonly p75: number;
  readonly good: number;
  readonly needsWork: number;
  readonly poor: number;
};

/** One of Google's rolling 28-day periods, as `YYYY-MM-DD` dates; a metric Google has no data for is null. */
export type CruxPeriod = {
  readonly start: string;
  readonly end: string;
  readonly lcp: CruxMetric | null;
  readonly inp: CruxMetric | null;
  readonly cls: CruxMetric | null;
};

export type CruxHistory = {
  /** Oldest first, as Google answers. */
  readonly periods: readonly CruxPeriod[];
};

export interface CruxTransport {
  readonly kind: "fake" | "live";
  /**
   * The History API's record for an ORIGIN and a device kind: up to 40
   * periods, or null when Google has no data for that origin (its 404 —
   * the normal answer for a small site).
   */
  history(origin: string, formFactor: CruxFormFactor, deadline: number): Promise<CruxHistory | null>;
}

/**
 * Why a call failed — the design's §3:
 *  - `refused` — 400 (a bad origin) or 403 (the key refused, restricted, or
 *    over its daily budget): nothing to retry until someone changes something;
 *  - `rate` — 429, the per-minute quota: the run stops for every workspace;
 *  - `unknown` — 5xx, a timeout, the network;
 *  - `shape` — an answer out of the shape we read.
 */
export type CruxErrorKind = "refused" | "rate" | "unknown" | "shape";

/**
 * A failed call. NEVER carries the URL (it holds the key), a header or a
 * body: the kind and the HTTP status, which is all a log line may say.
 */
export class CruxError extends Error {
  constructor(
    readonly kind: CruxErrorKind,
    readonly status: number | null,
  ) {
    super(`crux: ${kind}${status === null ? "" : ` ${status}`}`);
    this.name = "CruxError";
  }
}

export const isCruxError = (e: unknown): e is CruxError => e instanceof CruxError;
