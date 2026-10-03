import { describe, expect, it } from "vitest";

import type { ExpirationEntry } from "./expirations";
import { cutOf, mergeSources, type Source } from "./expirations-merge";

/**
 * The feed's merge and cut (Phase 3V slice 88), driven with a limit of
 * TWO — the database path needs 201 rows a source to reach it, which no
 * test builds (the fix-pass review). A mutation to the row `cutOf` reads,
 * to the filter's `<=`, or to the earliest-cut rule fails here.
 */

const entry = (name: string, date: string, kind: ExpirationEntry["kind"] = "asset"): ExpirationEntry => ({
  kind,
  id: `${kind}-${name}`,
  name,
  date,
  client: { id: "c", name: "Acme" },
  project: null,
  assetType: kind === "asset" ? "DOMAIN" : null,
  autoRenew: null,
  linkable: true,
});

/** A source read as the feed reads one: `limit + 1` rows at most, the cut taken from them. */
const source = (rows: ExpirationEntry[], limit = 2): Source => ({
  entries: rows.slice(0, limit),
  cut: cutOf(rows, limit, (r) => r.date),
});

describe("cutOf", () => {
  it("names the day of the LAST row kept, and only when the read ran past the cap", () => {
    expect(cutOf([entry("a", "2031-01-01"), entry("b", "2031-01-02")], 2, (r) => r.date)).toBeNull();
    expect(cutOf([entry("a", "2031-01-01"), entry("b", "2031-01-02"), entry("c", "2031-01-09")], 2, (r) => r.date)).toBe("2031-01-02");
  });
});

describe("mergeSources", () => {
  it("nothing cut: everything, soonest first, ties by name", () => {
    const out = mergeSources([
      source([entry("b.se", "2031-01-05"), entry("a.se", "2031-01-05")]),
      source([entry("Retainer", "2031-01-03", "agreementRenews")]),
    ]);
    expect(out.cutAt).toBeNull();
    expect(out.entries.map((e) => e.name)).toEqual(["Retainer", "a.se", "b.se"]);
  });

  it("a cut source cuts the WHOLE list at its last kept day, so no other source's later rows are drawn", () => {
    const assets = source([entry("a1", "2031-01-01"), entry("a2", "2031-01-04"), entry("a3", "2031-01-20")]);
    const renewals = source([entry("r1", "2031-01-02", "agreementRenews"), entry("r2", "2031-01-10", "agreementRenews")]);
    const out = mergeSources([assets, renewals]);
    expect(out.cutAt).toBe("2031-01-04");
    expect(out.entries.map((e) => e.name)).toEqual(["a1", "r1", "a2"]);
  });

  it("the EARLIEST of two cuts wins", () => {
    const assets = source([entry("a1", "2031-01-01"), entry("a2", "2031-01-08"), entry("a3", "2031-01-09")]);
    const ends = source([entry("e1", "2031-01-02", "agreementEnds"), entry("e2", "2031-01-05", "agreementEnds"), entry("e3", "2031-01-06", "agreementEnds")]);
    const out = mergeSources([assets, ends]);
    expect(out.cutAt).toBe("2031-01-05");
    expect(out.entries.map((e) => e.name)).toEqual(["a1", "e1", "e2"]);
  });

  it("a cut INSIDE a day keeps that day's kept rows — complete before it, partial on it — and never empties the list", () => {
    // Three rows on one day, two kept: the day is drawn (partially), not dropped.
    const same = source([entry("x", "2031-03-01"), entry("y", "2031-03-01"), entry("z", "2031-03-01")]);
    const out = mergeSources([same, source([entry("other", "2031-03-01", "agreementEnds")])]);
    expect(out.cutAt).toBe("2031-03-01");
    expect(out.entries.map((e) => e.name)).toEqual(["other", "x", "y"]);
  });

  it("a lapsed row before the cut is always kept", () => {
    const out = mergeSources([
      source([entry("lapsed", "2030-12-01"), entry("n1", "2031-01-01"), entry("n2", "2031-01-02")]),
      source([entry("old end", "2030-11-30", "agreementEnds")]),
    ]);
    expect(out.entries.map((e) => e.name)).toEqual(["old end", "lapsed", "n1"]);
  });
});
