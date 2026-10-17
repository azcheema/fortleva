import { describe, expect, it } from "vitest";

import {
  CALENDAR_DAY_LIMIT,
  CALENDAR_SERIES_STEPS,
  calendarHref,
  calendarPeriod,
  cutForCell,
  parseCalendarParams,
  projectCopies,
} from "./calendar-plan";

const TODAY = "2026-10-17"; // a Saturday

describe("parseCalendarParams + calendarHref — the page's parameters", () => {
  it("falls back on anything it does not know, and echoes nothing", () => {
    expect(parseCalendarParams({}, TODAY)).toEqual({ view: "month", date: TODAY, project: null, mine: false });
    expect(parseCalendarParams({ view: "year", date: "2026-02-30", project: "acme", mine: "yes" }, TODAY)).toEqual({
      view: "month",
      date: TODAY,
      project: null,
      mine: false,
    });
    expect(parseCalendarParams({ view: ["week", "month"], project: "TOOLONGKEY" }, TODAY)).toMatchObject({ view: "month", project: null });
  });

  it("reads what it knows", () => {
    expect(parseCalendarParams({ view: "week", date: "2026-11-03", project: "ACME", mine: "1" }, TODAY)).toEqual({
      view: "week",
      date: "2026-11-03",
      project: "ACME",
      mine: true,
    });
  });

  it("writes the defaults as no parameter", () => {
    expect(calendarHref({ view: "month", date: TODAY, project: null, mine: false }, TODAY)).toBe("/calendar");
    expect(calendarHref({ view: "week", date: "2026-11-03", project: "ACME", mine: true }, TODAY)).toBe(
      "/calendar?view=week&date=2026-11-03&project=ACME&mine=1",
    );
  });
});

describe("calendarPeriod — the days a view draws", () => {
  it("draws a month as its weeks in the workspace's week order, no week without a day of the month", () => {
    const p = calendarPeriod("month", "2026-10-17", "MONDAY");
    expect(p.month).toBe("2026-10");
    expect(p.from).toBe("2026-09-28"); // the Monday before 1 October
    expect(p.to).toBe("2026-11-01"); // the Sunday after 31 October
    expect(p.weeks).toHaveLength(5);
    for (const w of p.weeks) expect(w).toHaveLength(7);
    expect(p.prev).toBe("2026-09-01");
    expect(p.next).toBe("2026-11-01");
  });

  it("starts the week where the workspace does", () => {
    const sun = calendarPeriod("month", "2026-10-17", "SUNDAY");
    expect(sun.from).toBe("2026-09-27");
    expect(sun.weeks[0]![0]).toBe("2026-09-27");
  });

  it("draws February 2026 (starting on a Sunday) in four or five weeks, never six", () => {
    expect(calendarPeriod("month", "2026-02-10", "SUNDAY").weeks).toHaveLength(4);
    expect(calendarPeriod("month", "2026-02-10", "MONDAY").weeks).toHaveLength(5);
  });

  it("draws a week as the seven days containing the date", () => {
    const w = calendarPeriod("week", "2026-10-17", "MONDAY");
    expect(w).toMatchObject({ month: null, from: "2026-10-12", to: "2026-10-18", prev: "2026-10-10", next: "2026-10-24" });
    expect(w.weeks).toEqual([["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]]);
  });
});

describe("projectCopies — the copies a repeating task WILL make (C105 (c))", () => {
  it("draws each future copy on its due day within the range", () => {
    // Weekly from Mon 19 Oct: copies appear on the 19th, 26th, 2nd…, each due the Sunday after.
    expect(projectCopies({ nextOn: "2026-10-19", rhythm: "WEEKLY", anchorDay: null }, TODAY, "2026-09-28", "2026-11-01")).toEqual([
      { appearsOn: "2026-10-19", dueOn: "2026-10-25" },
      { appearsOn: "2026-10-26", dueOn: "2026-11-01" },
    ]);
  });

  it("draws the copy the copier owes now (its day has come, the job not run yet)", () => {
    expect(projectCopies({ nextOn: "2026-10-12", rhythm: "WEEKLY", anchorDay: null }, TODAY, "2026-10-12", "2026-10-25")).toEqual([
      { appearsOn: "2026-10-12", dueOn: "2026-10-18" },
      { appearsOn: "2026-10-19", dueOn: "2026-10-25" },
    ]);
  });

  it("finds a range years ahead without walking off the cap", () => {
    const far = projectCopies({ nextOn: "2026-10-19", rhythm: "WEEKLY", anchorDay: null }, TODAY, "2028-11-27", "2028-12-31");
    expect(far.length).toBeGreaterThanOrEqual(4);
    for (const c of far) expect(c.dueOn >= "2028-11-27" && c.dueOn <= "2028-12-31").toBe(true);
  });

  it("keeps a month rhythm on its anchor and is due the day before the next copy", () => {
    expect(projectCopies({ nextOn: "2026-11-30", rhythm: "MONTHLY", anchorDay: 31 }, TODAY, "2026-11-01", "2027-02-28")).toEqual([
      { appearsOn: "2026-11-30", dueOn: "2026-12-30" },
      { appearsOn: "2026-12-31", dueOn: "2027-01-30" },
      { appearsOn: "2027-01-31", dueOn: "2027-02-27" },
    ]);
  });

  it("collects at most CALENDAR_SERIES_STEPS copies per series", () => {
    const many = projectCopies({ nextOn: "2026-10-19", rhythm: "WEEKLY", anchorDay: null }, TODAY, "2026-10-19", "2028-12-31");
    expect(many).toHaveLength(CALENDAR_SERIES_STEPS);
    expect(many[0]).toEqual({ appearsOn: "2026-10-19", dueOn: "2026-10-25" });
  });

  it("draws nothing for a range wholly before its next copy, or for a malformed series", () => {
    expect(projectCopies({ nextOn: "2026-12-01", rhythm: "MONTHLY", anchorDay: 1 }, TODAY, "2026-10-01", "2026-10-31")).toEqual([]);
    expect(projectCopies({ nextOn: "2026-12-01", rhythm: "MONTHLY", anchorDay: null }, TODAY, "2026-12-01", "2027-01-31")).toEqual([]);
  });
});

describe("cutForCell — what a month cell draws", () => {
  it("keeps up to the limit and counts the rest", () => {
    expect(cutForCell([1, 2, 3])).toEqual({ shown: [1, 2, 3], more: 0 });
    expect(cutForCell([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2, 3], more: 2 });
    expect(CALENDAR_DAY_LIMIT).toBe(3);
  });
});
