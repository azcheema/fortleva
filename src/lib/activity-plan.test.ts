import { describe, expect, it } from "vitest";

import {
  ACTIVITY_MAX_SKIP,
  ACTIVITY_WINDOW_DAYS,
  activityHref,
  activityWindow,
  groupByDay,
  mergeNewestFirst,
  parseActivityParams,
} from "./activity-plan";

/** The Activity page's pure half (slice 133, C110). */

describe("parseActivityParams / activityHref", () => {
  it("reads a project key, a client id, a day and a skip strictly — anything else is no parameter", () => {
    expect(parseActivityParams({ project: "ACME", client: "01A14C87-5C2E-7220-8068-FA5454CDE4D9", until: "2026-10-12", skip: "120" })).toEqual({
      project: "ACME",
      client: "01a14c87-5c2e-7220-8068-fa5454cde4d9",
      until: "2026-10-12",
      skip: 120,
    });
    expect(parseActivityParams({ project: "acme", client: "x", until: "2026-13-40", skip: "5" })).toEqual({ project: null, client: null, until: null, skip: 0 });
    expect(parseActivityParams({ project: ["A", "B"] })).toEqual({ project: null, client: null, until: null, skip: 0 });
    // A skip only with a day, never negative, never past the ceiling.
    expect(parseActivityParams({ until: "2026-10-12", skip: "-3" }).skip).toBe(0);
    expect(parseActivityParams({ until: "2026-10-12", skip: "9999" }).skip).toBe(ACTIVITY_MAX_SKIP);
  });

  it("writes the defaults as no parameter", () => {
    expect(activityHref({ project: null, client: null, until: null, skip: 0 })).toBe("/activity");
    expect(activityHref({ project: "ACME", client: null, until: "2026-10-12", skip: 0 })).toBe("/activity?project=ACME&until=2026-10-12");
    expect(activityHref({ project: null, client: null, until: "2026-10-12", skip: 300 })).toBe("/activity?until=2026-10-12&skip=300");
    expect(activityHref({ project: null, client: null, until: null, skip: 300 })).toBe("/activity");
  });
});

describe("activityWindow", () => {
  it("is seven days ending at until — never after today", () => {
    expect(ACTIVITY_WINDOW_DAYS).toBe(7);
    expect(activityWindow(null, "2026-10-18")).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(activityWindow("2026-10-01", "2026-10-18")).toEqual({ from: "2026-09-25", to: "2026-10-01" });
    expect(activityWindow("2026-11-30", "2026-10-18")).toEqual({ from: "2026-10-12", to: "2026-10-18" });
  });
});

describe("mergeNewestFirst / groupByDay", () => {
  const ev = (id: string, iso: string) => ({ id, at: new Date(iso) });

  it("merges the kinds newest first, an id breaking a tie, and cuts at the cap", () => {
    const merged = mergeNewestFirst(
      [
        [ev("a", "2026-10-18T09:00:00Z"), ev("b", "2026-10-17T09:00:00Z")],
        [ev("c", "2026-10-18T09:00:00Z"), ev("d", "2026-10-18T10:00:00Z")],
      ],
      3,
    );
    expect(merged.events.map((e) => e.id)).toEqual(["d", "c", "a"]);
    expect(merged.truncated).toBe(true);
    expect(mergeNewestFirst([[ev("a", "2026-10-18T09:00:00Z")]], 3).truncated).toBe(false);
  });

  it("groups by day in the order given", () => {
    const groups = groupByDay(["2026-10-18", "2026-10-18", "2026-10-16"], (d) => d);
    expect(groups.map((g) => [g.day, g.events.length])).toEqual([
      ["2026-10-18", 2],
      ["2026-10-16", 1],
    ]);
  });
});
