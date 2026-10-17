import { describe, expect, it } from "vitest";

import {
  LINEUP_DAYS,
  barGeometry,
  dayIndex,
  dayOffset,
  lineupWindow,
  monthTicks,
  parseProjectsParams,
  projectsHref,
  weekLines,
} from "./lineup-plan";

// Thursday 2026-10-15; its Monday week starts 2026-10-12.
const today = "2026-10-15";

describe("parseProjectsParams / projectsHref", () => {
  it("reads the view, the list's archived switch and the timeline's first day strictly", () => {
    expect(parseProjectsParams({})).toEqual({ view: "list", archived: false, from: null });
    expect(parseProjectsParams({ view: "timeline", from: "2026-11-03", archived: "1" })).toEqual({
      view: "timeline",
      archived: true,
      from: "2026-11-03",
    });
    expect(parseProjectsParams({ view: "gantt", from: "2026-02-30" })).toEqual({ view: "list", archived: false, from: null });
    expect(parseProjectsParams({ from: "1969-12-29" }).from).toBeNull();
  });

  it("writes each parameter only where its view reads it", () => {
    expect(projectsHref({ view: "list", archived: false, from: "2026-11-03" })).toBe("/projects");
    expect(projectsHref({ view: "list", archived: true, from: null })).toBe("/projects?archived=1");
    expect(projectsHref({ view: "timeline", archived: true, from: null })).toBe("/projects?view=timeline");
    expect(projectsHref({ view: "timeline", archived: false, from: "2026-11-02" })).toBe("/projects?view=timeline&from=2026-11-02");
  });
});

describe("lineupWindow", () => {
  it("by default starts two weeks before the week holding today, 13 weeks wide", () => {
    const w = lineupWindow(null, today, "MONDAY");
    expect(w.from).toBe("2026-09-28");
    expect(w.to).toBe("2026-12-27");
    expect(dayIndex(w.from, w.to)).toBe(LINEUP_DAYS - 1);
    expect(w.home).toBe(w.from);
  });

  it("snaps a requested day to its week start, in the workspace's week", () => {
    expect(lineupWindow("2026-11-05", today, "MONDAY").from).toBe("2026-11-02");
    expect(lineupWindow("2026-11-05", today, "SUNDAY").from).toBe("2026-11-01");
    expect(lineupWindow("2026-11-05", today, "SATURDAY").from).toBe("2026-10-31");
  });

  it("moves four weeks either way, and Today goes home", () => {
    const w = lineupWindow("2026-11-02", today, "MONDAY");
    expect(w.prev).toBe("2026-10-05");
    expect(w.next).toBe("2026-11-30");
    expect(w.home).toBe("2026-09-28");
  });
});

describe("barGeometry", () => {
  const w = lineupWindow(null, today, "MONDAY"); // 2026-09-28 … 2026-12-27

  it("places a bar wholly inside, the launch day drawn whole", () => {
    const g = barGeometry("2026-09-28", "2026-10-04", w);
    expect(g).toEqual({ kind: "inside", left: 0, width: Math.round((7 / 91) * 100_000) / 1000, cutStart: false, cutEnd: false });
  });

  it("a one-day project is one day wide", () => {
    const g = barGeometry("2026-10-15", "2026-10-15", w);
    expect(g.kind).toBe("inside");
    if (g.kind === "inside") expect(g.width).toBeCloseTo((1 / 91) * 100, 2);
  });

  it("cuts a bar at either edge and says which end is cut", () => {
    expect(barGeometry("2026-09-01", "2026-10-10", w)).toMatchObject({ kind: "inside", left: 0, cutStart: true, cutEnd: false });
    expect(barGeometry("2026-12-01", "2027-03-01", w)).toMatchObject({ kind: "inside", cutStart: false, cutEnd: true });
    const both = barGeometry("2026-01-01", "2027-12-31", w);
    expect(both).toEqual({ kind: "inside", left: 0, width: 100, cutStart: true, cutEnd: true });
  });

  it("is before or after the window when it never touches it", () => {
    expect(barGeometry("2026-08-01", "2026-09-27", w)).toEqual({ kind: "before" });
    expect(barGeometry("2026-12-28", "2027-02-01", w)).toEqual({ kind: "after" });
    // The window's first and last days still touch.
    expect(barGeometry("2026-08-01", "2026-09-28", w).kind).toBe("inside");
    expect(barGeometry("2026-12-27", "2027-02-01", w).kind).toBe("inside");
  });
});

describe("dayOffset, weekLines, monthTicks", () => {
  const w = lineupWindow(null, today, "MONDAY"); // 2026-09-28 … 2026-12-27

  it("puts a day at its middle, and nothing outside the window", () => {
    expect(dayOffset("2026-09-28", w)).toBeCloseTo((0.5 / 91) * 100, 2);
    expect(dayOffset("2026-12-27", w)).toBeCloseTo((90.5 / 91) * 100, 2);
    expect(dayOffset("2026-09-27", w)).toBeNull();
    expect(dayOffset("2026-12-28", w)).toBeNull();
  });

  it("draws the twelve week lines inside the track", () => {
    const lines = weekLines();
    expect(lines).toHaveLength(12);
    expect(lines[0]).toBeCloseTo((7 / 91) * 100, 2);
    expect(lines.every((l) => l > 0 && l < 100)).toBe(true);
  });

  it("names each month that begins inside the window, across a new year", () => {
    expect(monthTicks(w).map((t) => t.day)).toEqual(["2026-10-01", "2026-11-01", "2026-12-01"]);
    const winter = lineupWindow("2026-12-14", today, "MONDAY"); // 2026-12-14 … 2027-03-14
    expect(monthTicks(winter).map((t) => t.day)).toEqual(["2027-01-01", "2027-02-01", "2027-03-01"]);
  });

  it("leaves out a month that begins in the window's last days — its name would run off the edge", () => {
    const w2 = lineupWindow("2026-10-05", today, "MONDAY"); // 2026-10-05 … 2027-01-03; 1 Jan is day 88
    expect(w2.to).toBe("2027-01-03");
    expect(monthTicks(w2).map((t) => t.day)).toEqual(["2026-11-01", "2026-12-01"]);
  });

  it("finds a month that begins on the window's first day", () => {
    const w2 = lineupWindow("2027-02-01", today, "MONDAY"); // a Monday
    expect(w2.from).toBe("2027-02-01");
    // The first day's own month is the page's lead label; ticks start with the next one.
    expect(monthTicks(w2)[0]!.day).toBe("2027-03-01");
  });
});
