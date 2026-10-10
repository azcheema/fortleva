/**
 * WHAT THE NEXT BOOKKEEPING FILE HOLDS (Phase 4 slice 111; founder decision
 * C82) — pure, so a unit test can pin it (the code review's 5 (c)).
 *
 * Each candidate event names the events that must be filed before it (a
 * payment re-marked after its booked one was unmarked waits on that
 * reversal; a credit note waits on its invoice's pending payment events). A
 * file takes, in INSERTION order:
 *
 *  1. the GROUP — the financial year and the seller — of the earliest
 *     FILEABLE event (one with nothing left to wait on): a payment waiting on
 *     its own reversal never decides the year, so a reversal dated today is
 *     filed alone when older events are done, and the file after it holds the
 *     payment (the design re-check's 1 — the cut could otherwise stall for good);
 *  2. every fileable event of that group, earliest first;
 *  3. then, again and again, what that unblocks in the same group;
 *
 * at most `max` events — and an event is never taken before, or without,
 * what it waits on.
 */
export function selectForFile<C extends { readonly key: string; readonly dependsOn: readonly string[] }>(
  /** Earliest first. */
  sorted: readonly C[],
  groupOf: (c: C) => string,
  max: number,
): C[] {
  const roots = sorted.filter((c) => c.dependsOn.length === 0);
  if (roots.length === 0 || max <= 0) return [];
  const group = groupOf(roots[0]!);
  const picked: C[] = [];
  const chosen = new Set<string>();
  const take = (c: C) => {
    picked.push(c);
    chosen.add(c.key);
  };
  for (const c of roots) if (picked.length < max && groupOf(c) === group) take(c);
  for (let added = true; added; ) {
    added = false;
    for (const c of sorted) {
      if (picked.length >= max) break;
      if (!chosen.has(c.key) && groupOf(c) === group && c.dependsOn.every((k) => chosen.has(k))) {
        take(c);
        added = true;
      }
    }
  }
  return picked;
}
