import { describe, expect, it } from "vitest";

import {
  DEFAULT_UPDATE_WEEKDAY,
  UPDATE_MIN_GAP_DAYS,
  firstDueDayOnOrAfter,
  isoWeekdayOf,
  reminderSlotOn,
  reminderStepOn,
  updateDueOn,
  updateScheduleAt,
  type UpdateScheduleInput,
} from "./update-schedule";

// October 2026: Fridays are the 2nd, 9th, 16th, 23rd and 30th; the first
// Friday of November is the 6th, of December the 4th, of January 2027 the
// 1st. Europe/Stockholm leaves summer time on Sunday 25 October.
const ZONE = "Europe/Stockholm";
/** Noon in Stockholm on a day — far from any midnight, either side of the clock change. */
const noon = (isoDate: string) => new Date(`${isoDate}T10:00:00.000Z`);

const weekly = (over: Partial<UpdateScheduleInput> = {}): UpdateScheduleInput => ({
  cadence: "WEEKLY",
  active: true,
  weekday: 5,
  since: noon("2026-09-01"),
  lastPublishedAt: null,
  timeZone: ZONE,
  ...over,
});

describe("the calendar helpers", () => {
  it("names ISO weekdays", () => {
    expect(isoWeekdayOf("2026-10-05")).toBe(1);
    expect(isoWeekdayOf("2026-10-09")).toBe(5);
    expect(isoWeekdayOf("2026-10-11")).toBe(7);
  });

  it("finds the next chosen weekday, the floor itself included", () => {
    expect(firstDueDayOnOrAfter("WEEKLY", 5, "2026-10-09")).toBe("2026-10-09");
    expect(firstDueDayOnOrAfter("WEEKLY", 5, "2026-10-10")).toBe("2026-10-16");
    expect(firstDueDayOnOrAfter("BIWEEKLY", 1, "2026-10-10")).toBe("2026-10-12");
  });

  it("finds the first chosen weekday of a month, rolling into the next month and year", () => {
    expect(firstDueDayOnOrAfter("MONTHLY", 5, "2026-10-01")).toBe("2026-10-02");
    expect(firstDueDayOnOrAfter("MONTHLY", 5, "2026-10-03")).toBe("2026-11-06");
    expect(firstDueDayOnOrAfter("MONTHLY", 5, "2026-12-24")).toBe("2027-01-01");
    expect(firstDueDayOnOrAfter("MONTHLY", 1, "2026-11-03")).toBe("2026-12-07");
  });

  it("keeps Friday as the default day and the gaps the design names", () => {
    expect(DEFAULT_UPDATE_WEEKDAY).toBe(5);
    expect(UPDATE_MIN_GAP_DAYS).toEqual({ WEEKLY: 4, BIWEEKLY: 11, MONTHLY: 20 });
  });
});

describe("when the next update is due", () => {
  it("has no answer for a project that is not ACTIVE (planned, paused, done, archived)", () => {
    expect(updateDueOn(weekly({ active: false }))).toBeNull();
    expect(updateScheduleAt(weekly({ active: false }), noon("2026-12-01"))).toBeNull();
  });

  it("has no answer without a schedule, or with a day this build never writes", () => {
    expect(updateDueOn(weekly({ cadence: "NONE" }))).toBeNull();
    expect(updateDueOn(weekly({ since: null }))).toBeNull();
    expect(updateDueOn(weekly({ weekday: 6 }))).toBeNull();
    expect(updateDueOn(weekly({ weekday: 0 }))).toBeNull();
    expect(updateDueOn(weekly({ weekday: 2.5 }))).toBeNull();
  });

  it("with no post yet, falls on the first chosen day AFTER the day the schedule was set", () => {
    expect(updateDueOn(weekly({ since: noon("2026-10-07") }))).toBe("2026-10-09"); // a Wednesday: this Friday
    expect(updateDueOn(weekly({ since: noon("2026-10-09") }))).toBe("2026-10-16"); // set on the Friday: next
  });

  it("weekly: a post on time, early or late moves the next one so nothing counts twice", () => {
    expect(updateDueOn(weekly({ lastPublishedAt: noon("2026-10-09") }))).toBe("2026-10-16"); // Friday → Friday
    expect(updateDueOn(weekly({ lastPublishedAt: noon("2026-10-08") }))).toBe("2026-10-16"); // Thursday → 8 days
    expect(updateDueOn(weekly({ lastPublishedAt: noon("2026-10-12") }))).toBe("2026-10-16"); // late Monday → 4 days
    expect(updateDueOn(weekly({ lastPublishedAt: noon("2026-10-13") }))).toBe("2026-10-23"); // Tuesday covers this week
  });

  it("never falls on or before the day the schedule was set, however old the last post", () => {
    expect(
      updateDueOn(weekly({ since: noon("2026-10-07"), lastPublishedAt: noon("2026-07-01") })),
    ).toBe("2026-10-09");
    // …and a post the day before it was set still counts.
    expect(
      updateDueOn(weekly({ since: noon("2026-10-07"), lastPublishedAt: noon("2026-10-06") })),
    ).toBe("2026-10-16");
  });

  it("fortnightly", () => {
    const fortnightly = (last: string) => updateDueOn(weekly({ cadence: "BIWEEKLY", lastPublishedAt: noon(last) }));
    expect(fortnightly("2026-10-09")).toBe("2026-10-23");
    expect(fortnightly("2026-10-12")).toBe("2026-10-23"); // late: 11 days
    expect(fortnightly("2026-10-08")).toBe("2026-10-23"); // early: 15 days
  });

  it("monthly falls on the first chosen weekday of a month (C70 (c))", () => {
    const monthly = (over: Partial<UpdateScheduleInput>) => updateDueOn(weekly({ cadence: "MONTHLY", ...over }));
    expect(monthly({ lastPublishedAt: noon("2026-10-02") })).toBe("2026-11-06");
    expect(monthly({ lastPublishedAt: noon("2026-11-10") })).toBe("2026-12-04"); // late for 6 Nov
    expect(monthly({ lastPublishedAt: noon("2026-10-30") })).toBe("2026-12-04"); // early: covers November
    expect(monthly({ lastPublishedAt: noon("2026-12-04") })).toBe("2027-01-01");
    expect(monthly({ since: noon("2026-10-08") })).toBe("2026-11-06");
  });

  it("reads the post's day in the WORKSPACE's zone, not UTC's", () => {
    // 22:30 UTC on Monday 12 October is 00:30 on Tuesday in Stockholm.
    const late = new Date("2026-10-12T22:30:00.000Z");
    expect(updateDueOn(weekly({ lastPublishedAt: late }))).toBe("2026-10-23");
    expect(updateDueOn(weekly({ lastPublishedAt: late, timeZone: "UTC" }))).toBe("2026-10-16");
  });
});

describe("where the project stands", () => {
  const input = weekly({ lastPublishedAt: noon("2026-10-09") }); // due Friday 16 October

  it("is scheduled before the day, due on it, late after it", () => {
    expect(updateScheduleAt(input, noon("2026-10-15"))).toEqual({ dueOn: "2026-10-16", state: "scheduled" });
    expect(updateScheduleAt(input, noon("2026-10-16"))).toEqual({ dueOn: "2026-10-16", state: "due" });
    expect(updateScheduleAt(input, noon("2026-10-17"))).toEqual({ dueOn: "2026-10-16", state: "late" });
  });

  it("decides 'today' in the workspace's zone across the clock change", () => {
    const after = weekly({ lastPublishedAt: noon("2026-10-23") }); // due Friday 30 October, after the change
    // 23:30 UTC on Thursday 29 October is 00:30 on Friday in Stockholm (UTC+1 by then).
    expect(updateScheduleAt(after, new Date("2026-10-29T23:30:00.000Z"))?.state).toBe("due");
    expect(updateScheduleAt(after, new Date("2026-10-29T22:30:00.000Z"))?.state).toBe("scheduled");
  });

  it("has no answer without a schedule", () => {
    expect(updateScheduleAt(weekly({ cadence: "NONE", since: null }), noon("2026-10-16"))).toBeNull();
  });
});

describe("which reminder belongs to a day", () => {
  it("sends on the due day and on the next two WORKING days, never on a weekend", () => {
    const due = "2026-10-09"; // a Friday
    expect(reminderStepOn(due, "2026-10-08")).toBeNull();
    expect(reminderStepOn(due, "2026-10-09")).toBe(0);
    expect(reminderStepOn(due, "2026-10-10")).toBeNull();
    expect(reminderStepOn(due, "2026-10-11")).toBeNull();
    expect(reminderStepOn(due, "2026-10-12")).toBe(1);
    expect(reminderStepOn(due, "2026-10-13")).toBe(2);
    expect(reminderStepOn(due, "2026-10-14")).toBeNull();
    expect(reminderStepOn(due, "2026-12-01")).toBeNull();
  });

  it("counts working days from a midweek day too", () => {
    const due = "2026-10-07"; // a Wednesday
    expect(reminderStepOn(due, "2026-10-08")).toBe(1);
    expect(reminderStepOn(due, "2026-10-09")).toBe(2);
    expect(reminderStepOn(due, "2026-10-12")).toBeNull();
  });
});

describe("a missed update is reminded again on every due day after it (C70 (e))", () => {
  it("weekly: each later Friday opens a new round", () => {
    const due = "2026-10-09";
    expect(reminderSlotOn("WEEKLY", 5, due, "2026-10-08")).toBeNull();
    expect(reminderSlotOn("WEEKLY", 5, due, "2026-10-09")).toBe("2026-10-09");
    expect(reminderSlotOn("WEEKLY", 5, due, "2026-10-15")).toBe("2026-10-09");
    expect(reminderSlotOn("WEEKLY", 5, due, "2026-10-16")).toBe("2026-10-16");
    expect(reminderSlotOn("WEEKLY", 5, due, "2026-10-20")).toBe("2026-10-16");
    // …and the step counts from the round's own day.
    expect(reminderStepOn(reminderSlotOn("WEEKLY", 5, due, "2026-10-20")!, "2026-10-20")).toBe(2);
    expect(reminderStepOn(reminderSlotOn("WEEKLY", 5, due, "2026-10-21")!, "2026-10-21")).toBeNull();
  });

  it("fortnightly: every second Friday", () => {
    const due = "2026-10-09";
    expect(reminderSlotOn("BIWEEKLY", 5, due, "2026-10-16")).toBe("2026-10-09");
    expect(reminderSlotOn("BIWEEKLY", 5, due, "2026-10-23")).toBe("2026-10-23");
    expect(reminderSlotOn("BIWEEKLY", 5, due, "2026-11-05")).toBe("2026-10-23");
  });

  it("monthly: the first chosen weekday of each later month", () => {
    const due = "2026-11-06";
    expect(reminderSlotOn("MONTHLY", 5, due, "2026-11-30")).toBe("2026-11-06");
    expect(reminderSlotOn("MONTHLY", 5, due, "2026-12-03")).toBe("2026-11-06");
    expect(reminderSlotOn("MONTHLY", 5, due, "2026-12-04")).toBe("2026-12-04");
    expect(reminderSlotOn("MONTHLY", 5, due, "2027-01-04")).toBe("2027-01-01");
  });
});
