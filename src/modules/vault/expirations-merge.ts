import type { ExpirationEntry } from "./expirations";

/**
 * MERGING THE FEED'S SOURCES (Phase 3V slice 88) — pure, so the unit suite
 * can drive the cut with a limit of two instead of 201 database rows (the
 * fix-pass review: nothing ran this code). Each source is read soonest
 * first and capped at `limit`; one past the cap is read to know it was cut.
 */

/** One source's rows, and — when it had more than the cap — the day of the LAST row it kept. */
export type Source = { readonly entries: readonly ExpirationEntry[]; readonly cut: string | null };

/** The day of the last row kept (`YYYY-MM-DD`) when `rows` ran past `limit`; null when nothing was cut. */
export const cutOf = <T>(rows: readonly T[], limit: number, dayOf: (row: T) => string): string | null =>
  rows.length > limit ? dayOf(rows[limit - 1]!) : null;

/**
 * One list, soonest first (ties by name), cut to the earliest day any
 * source was cut on (`cutAt`). What that buys, exactly: every source is
 * complete for every day BEFORE `cutAt` — a source's rows before its own
 * cut day sort ahead of the last row it kept — while ON `cutAt` a cut
 * source may be missing rows that share the day with its last kept one.
 * So the page claims "everything before" that day, never "up to" it.
 *
 * The cut is NOT moved back to the day before the first row left out: with
 * a source's rows all on one day, that would empty it, and the page would
 * say "nothing to renew" under "there is more" (the fix-pass review).
 */
export function mergeSources(sources: readonly Source[]): { entries: ExpirationEntry[]; cutAt: string | null } {
  const cuts = sources.flatMap((src) => (src.cut === null ? [] : [src.cut]));
  const cutAt = cuts.length === 0 ? null : cuts.reduce((a, b) => (a < b ? a : b));
  const entries = sources
    .flatMap((src) => src.entries)
    .filter((e) => cutAt === null || e.date <= cutAt)
    .sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date < b.date ? -1 : 1));
  return { entries, cutAt };
}
