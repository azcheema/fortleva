import { describe, expect, it } from "vitest";

import { matchesQuery } from "./text-match";

/**
 * The one type-ahead matcher the palette and every picker share: a
 * subsequence match over a folded string (NFD, diacritics stripped,
 * lower-cased). Pinned here because it stayed untested until a label
 * name — the first member-coined vocabulary a picker filters — showed
 * that the needle was indexed by UTF-16 unit while the haystack was
 * walked by code point, so an emoji never matched itself.
 */
describe("matchesQuery", () => {
  it("matches a subsequence, case and diacritics aside", () => {
    expect(matchesQuery("Designgranskning", "dsg")).toBe(true);
    expect(matchesQuery("Café", "cafe")).toBe(true);
    expect(matchesQuery("Resume", "résumé")).toBe(true);
    expect(matchesQuery("Backend", "bakc")).toBe(false);
  });

  it("a blank needle matches everything", () => {
    expect(matchesQuery("anything", "")).toBe(true);
    expect(matchesQuery("", "")).toBe(true);
  });

  it("an astral character (an emoji) matches itself — code points on both sides", () => {
    expect(matchesQuery("🔥 Hot", "🔥 Hot")).toBe(true);
    expect(matchesQuery("🔥 Hot", "🔥")).toBe(true);
    expect(matchesQuery("Hot 🔥", "h🔥")).toBe(true);
    expect(matchesQuery("Hot", "🔥")).toBe(false);
  });
});
