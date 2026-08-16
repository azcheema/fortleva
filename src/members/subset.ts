/** Pure grant-subset arithmetic (AUTHZ.md §7.1), DB-free for unit tests. */

/** The codes of `wanted` the actor does not hold, in `wanted` order. */
export const missingFrom = (
  actorSet: ReadonlySet<string>,
  wanted: Iterable<string>,
): string[] => [...wanted].filter((c) => !actorSet.has(c));
