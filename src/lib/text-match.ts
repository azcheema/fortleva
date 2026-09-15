/**
 * Subsequence match, case- and accent-insensitive: "prj" reaches
 * Projects, "ins" reaches Settings > Notifications.
 *
 * It exists because every type-ahead in this product runs cmdk with
 * `shouldFilter={false}` — cmdk's own scorer RE-SORTS by fuzzy score,
 * which would scramble orderings that carry meaning (a state picker's
 * category groups follow `WorkflowState.rank`). Turning the scorer off
 * means owning the matching, and a plain `includes` would have been a
 * downgrade nobody asked for.
 *
 * Shared rather than copied so the palette and the pickers cannot
 * diverge on what "prg" reaches.
 */
export function matchesQuery(haystack: string, needle: string): boolean {
  const norm = (v: string) =>
    v.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const h = norm(haystack);
  // CODE POINTS on both sides: the haystack was already walked by code
  // point, but the needle was indexed by UTF-16 unit, so an astral
  // character (an emoji in a label name) could never match itself.
  const n = [...norm(needle)];
  if (n.length === 0) return true;
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i += 1;
    if (i === n.length) return true;
  }
  return false;
}
