import { describe, expect, it } from "vitest";

import { compareRank, rankBetween, ranksBetween } from "./rank";

describe("rank (fractional indexing, COLLATE \"C\" semantics)", () => {
  it("generates keys strictly between neighbours in byte order", () => {
    const first = rankBetween(null, null);
    const after = rankBetween(first, null);
    const before = rankBetween(null, first);
    const mid = rankBetween(first, after);
    expect(compareRank(before, first)).toBe(-1);
    expect(compareRank(first, mid)).toBe(-1);
    expect(compareRank(mid, after)).toBe(-1);
  });

  it("stays sorted after many inserts at the same gap", () => {
    let a = rankBetween(null, null);
    const b = rankBetween(a, null);
    const keys = [a, b];
    for (let i = 0; i < 40; i++) {
      a = rankBetween(a, b);
      keys.push(a);
    }
    const sorted = [...keys].sort(compareRank);
    expect(new Set(keys).size).toBe(keys.length);
    expect(sorted).toEqual([...keys].sort());
  });

  it("ranksBetween yields ascending distinct keys", () => {
    const ks = ranksBetween(null, null, 5);
    expect(ks).toHaveLength(5);
    expect([...ks].sort(compareRank)).toEqual(ks);
  });
});
