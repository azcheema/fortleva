import { describe, expect, it } from "vitest";

import { addDays, daysBetween, isIsoDate, isoWeekOf, monthContaining, shiftMonth, spanDays, weekContaining } from "./week";

describe("week arithmetic (UI.md §8 — ISO weeks, configurable grid start)", () => {
  it("Monday-first grid: 2026-08-20 (Thursday) → Mon 17 … Sun 23, ISO week 34", () => {
    const w = weekContaining("2026-08-20", "MONDAY");
    expect(w.from).toBe("2026-08-17");
    expect(w.to).toBe("2026-08-23");
    expect(w.days).toHaveLength(7);
    expect(w.isoWeek).toBe(34);
    expect(w.isoYear).toBe(2026);
  });

  it("Sunday-first grid starts the day before, same ISO label for the bulk of the week", () => {
    const w = weekContaining("2026-08-20", "SUNDAY");
    expect(w.from).toBe("2026-08-16");
    expect(w.to).toBe("2026-08-22");
    expect(w.isoWeek).toBe(34);
  });

  it("year boundary: 2026-01-01 is ISO week 1 of 2026; 2027-01-01 is ISO week 53 of 2026", () => {
    expect(isoWeekOf("2026-01-01")).toEqual({ year: 2026, week: 1 });
    expect(isoWeekOf("2027-01-01")).toEqual({ year: 2026, week: 53 });
  });

  it("helpers", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(daysBetween("2026-08-30", "2026-09-02")).toEqual(["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
    expect(monthContaining("2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(isIsoDate("2026-08-20")).toBe(true);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-02-30")).toBe(false); // not a calendar date, even where Date.parse rolls it over
    expect(isIsoDate("0001-01-01")).toBe(false); // outside MIN_YEAR..MAX_YEAR — a range loop must stay finite
    expect(isIsoDate("9999-12-31")).toBe(false);
    expect(isIsoDate("garbage")).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
    // Reversed ranges are empty, never infinite; spanDays is the arithmetic twin.
    expect(daysBetween("2026-09-02", "2026-08-30")).toEqual([]);
    expect(spanDays("2026-08-30", "2026-09-02")).toBe(4);
    expect(spanDays("2026-09-02", "2026-08-30")).toBe(0);
    expect(spanDays("garbage", "2026-08-30")).toBe(0); // unparsable → 0, never NaN (a range cap compares against it)
    expect(spanDays("2026-01-01", "2026-12-31")).toBe(365);
    // Month arithmetic crosses the year both ways.
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-08", 0)).toBe("2026-08");
  });
});
