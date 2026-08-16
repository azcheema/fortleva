import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/**
 * Ordering keys for ranked rows (Milestone now; WorkItem in 2W — UI.md
 * §7.1, plan §3.1). Wraps `fractional-indexing`: keys are ASCII strings
 * whose byte order IS the intended order, which is why the columns are
 * `text COLLATE "C"` (migration SQL) — Postgres compares them exactly
 * as JavaScript does. Rank is server-computed from neighbours, unique
 * per (tenantId, projectId), never rendered.
 */

/** A key strictly between `a` and `b`; null = open end (top / bottom). */
export const rankBetween = (a: string | null, b: string | null): string =>
  generateKeyBetween(a, b);

/** `n` keys strictly between `a` and `b`, ascending. */
export const ranksBetween = (a: string | null, b: string | null, n: number): string[] =>
  generateNKeysBetween(a, b, n);

/** Rebalance threshold (plan §3.1): keys longer than this get rewritten
 * by a maintenance pass — never on the hot path. */
export const RANK_REBALANCE_LENGTH = 50;

/** Byte-order comparison — the same order `COLLATE "C"` gives. */
export const compareRank = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
