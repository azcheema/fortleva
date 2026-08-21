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

/** Rebalance threshold (plan §3.1): a key longer than this triggers a
 * rewrite of the whole list. Today that happens INLINE, in the same
 * transaction as the move that produced it (`ordering.ts`), because no
 * maintenance job exists yet — `rebalanceProjectRanks` is the entry point
 * a sweep would call. */
export const RANK_REBALANCE_LENGTH = 50;

/** Byte-order comparison — the same order `COLLATE "C"` gives. */
export const compareRank = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
