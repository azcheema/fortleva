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
 * at most `max` events (but a first unit always fits) — and an event is
 * never taken before, or without, what it waits on.
 *
 * UNITS (slice 111b; its design review's M1): candidates linked by
 * `companion` are taken TOGETHER — all in one file or none — when they share
 * a group; a unit waits on what any member waits on outside it, and its
 * members keep their order. (A year end's withdrawal and the late payment
 * that justifies it: filed apart, an unmark between the two files would take
 * the sale out of that year for good.) Linked candidates of different groups
 * stand alone, their dependencies still holding.
 */
export function selectForFile<C extends { readonly key: string; readonly dependsOn: readonly string[]; readonly companion?: string }>(
  /** Earliest first. */
  sorted: readonly C[],
  groupOf: (c: C) => string,
  max: number,
): C[] {
  const units = unitsOf(sorted, groupOf);
  const outside = (u: readonly C[]) => u.flatMap((m) => m.dependsOn).filter((k) => !u.some((m) => m.key === k));
  const roots = units.filter((u) => outside(u).length === 0);
  if (roots.length === 0 || max <= 0) return [];
  const group = groupOf(roots[0]![0]!);
  const picked: C[] = [];
  const chosen = new Set<string>();
  const take = (u: readonly C[]) => {
    for (const m of u) {
      picked.push(m);
      chosen.add(m.key);
    }
  };
  // An empty file takes its first unit whole even past `max` (at most three
  // events — never stranded by a small cap; the re-check's NIT).
  for (const u of roots) if ((picked.length === 0 || picked.length + u.length <= max) && groupOf(u[0]!) === group) take(u);
  for (let added = true; added; ) {
    added = false;
    for (const u of units) {
      if (picked.length >= max) break;
      if (
        !chosen.has(u[0]!.key) &&
        groupOf(u[0]!) === group &&
        picked.length + u.length <= max &&
        outside(u).every((k) => chosen.has(k))
      ) {
        take(u);
        added = true;
      }
    }
  }
  return picked;
}

/**
 * The candidates as units, in order of each unit's earliest member; a unit's
 * members in `sorted`'s order, except that a member waiting on another comes
 * after it (a payment's reversal before the re-mark — the list reads in the
 * order the file books).
 */
function unitsOf<C extends { readonly key: string; readonly dependsOn: readonly string[]; readonly companion?: string }>(
  sorted: readonly C[],
  groupOf: (c: C) => string,
): C[][] {
  // Union-find over the companion links whose two ends share a group.
  const index = new Map(sorted.map((c, i) => [c.key, i]));
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  sorted.forEach((c, i) => {
    const j = c.companion === undefined ? undefined : index.get(c.companion);
    if (j !== undefined && groupOf(sorted[j]!) === groupOf(c)) parent[find(i)] = find(j);
  });
  const byRoot = new Map<number, C[]>();
  const order: number[] = [];
  sorted.forEach((c, i) => {
    const r = find(i);
    if (!byRoot.has(r)) {
      byRoot.set(r, []);
      order.push(r);
    }
    byRoot.get(r)!.push(c);
  });
  return order.map((r) => insideOrder(byRoot.get(r)!));
}

/** A unit's members, each after the members it waits on (stable otherwise; a unit is at most three). */
function insideOrder<C extends { readonly key: string; readonly dependsOn: readonly string[] }>(members: C[]): C[] {
  if (members.length < 2) return members;
  const out: C[] = [];
  const placed = new Set<string>();
  const inUnit = new Set(members.map((m) => m.key));
  while (out.length < members.length) {
    const next = members.find((m) => !placed.has(m.key) && m.dependsOn.every((k) => !inUnit.has(k) || placed.has(k)));
    // A cycle inside a unit is a planning bug — keep the given order rather than loop.
    const m = next ?? members.find((x) => !placed.has(x.key))!;
    out.push(m);
    placed.add(m.key);
  }
  return out;
}
