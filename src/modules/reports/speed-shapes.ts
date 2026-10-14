import type { CruxFormFactor, CruxMetric } from "@/integrations/crux";

/**
 * THE SHAPES BOTH SPEED SURFACES DRAW (Phase 6 slice 118) — pure: a stored
 * week as the charts read it, and the origin a Production URL names. No
 * database import, so the portal projection and the team's read share it
 * without either reaching into the other.
 */

/** One stored period, oldest first in a series. */
export type SpeedWeek = {
  /** `YYYY-MM-DD`. */
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly lcp: CruxMetric | null;
  readonly inp: CruxMetric | null;
  readonly cls: CruxMetric | null;
};

export type SpeedSeries = Readonly<Record<CruxFormFactor, readonly SpeedWeek[]>>;

/** The columns a week's row is read with — both projections select exactly these. */
export const SPEED_WEEK_SELECT = {
  formFactor: true,
  periodStart: true,
  periodEnd: true,
  lcpP75Ms: true,
  inpP75Ms: true,
  clsP75: true,
  lcpGood: true,
  lcpNeedsWork: true,
  lcpPoor: true,
  inpGood: true,
  inpNeedsWork: true,
  inpPoor: true,
  clsGood: true,
  clsNeedsWork: true,
  clsPoor: true,
} as const;

/** What Prisma hands back for `SPEED_WEEK_SELECT` — decimals as objects with a `toNumber`. */
export type SpeedWeekRow = {
  readonly formFactor: CruxFormFactor;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly lcpP75Ms: number | null;
  readonly inpP75Ms: number | null;
  readonly clsP75: { toNumber(): number } | null;
  readonly lcpGood: { toNumber(): number } | null;
  readonly lcpNeedsWork: { toNumber(): number } | null;
  readonly lcpPoor: { toNumber(): number } | null;
  readonly inpGood: { toNumber(): number } | null;
  readonly inpNeedsWork: { toNumber(): number } | null;
  readonly inpPoor: { toNumber(): number } | null;
  readonly clsGood: { toNumber(): number } | null;
  readonly clsNeedsWork: { toNumber(): number } | null;
  readonly clsPoor: { toNumber(): number } | null;
};

/** How many period ends a series holds at most — a year of weeks. */
export const SPEED_WEEKS_SHOWN = 52;

const n = (d: { toNumber(): number } | null): number | null => (d === null ? null : d.toNumber());

const metric = (
  p75: number | null,
  good: number | null,
  needsWork: number | null,
  poor: number | null,
): CruxMetric | null =>
  p75 === null || good === null || needsWork === null || poor === null ? null : { p75, good, needsWork, poor };

/** A row → a week; the date columns are UTC midnights. */
export function weekOf(row: SpeedWeekRow): SpeedWeek {
  return {
    periodStart: row.periodStart.toISOString().slice(0, 10),
    periodEnd: row.periodEnd.toISOString().slice(0, 10),
    lcp: metric(row.lcpP75Ms, n(row.lcpGood), n(row.lcpNeedsWork), n(row.lcpPoor)),
    inp: metric(row.inpP75Ms, n(row.inpGood), n(row.inpNeedsWork), n(row.inpPoor)),
    cls: metric(n(row.clsP75), n(row.clsGood), n(row.clsNeedsWork), n(row.clsPoor)),
  };
}

/**
 * Rows read NEWEST FIRST (so a `take` keeps the latest), both kinds mixed →
 * a series per kind, oldest first, each cut to `SPEED_WEEKS_SHOWN`.
 */
export function seriesOf(rows: readonly SpeedWeekRow[]): SpeedSeries {
  const out: Record<CruxFormFactor, SpeedWeek[]> = { PHONE: [], DESKTOP: [] };
  for (const row of rows) {
    const list = out[row.formFactor];
    if (list.length < SPEED_WEEKS_SHOWN) list.push(weekOf(row));
  }
  out.PHONE.reverse();
  out.DESKTOP.reverse();
  return out;
}

/**
 * The origin a Production URL names — scheme and host (and a port), or null
 * for anything that is not an http(s) URL. What Google is asked about and
 * what the rows record; a page URL is reduced to its site.
 */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  return u.origin;
}
