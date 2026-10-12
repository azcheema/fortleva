import { describe, expect, it } from "vitest";

import { MAX_RENEWAL_STEPS, addIntervals, anchorOf, daysCovered, nextRenewal, periodOf } from "./renewal-dates";

describe("addIntervals — whole months from the date, on the anchor day", () => {
  it("steps by one, three and twelve months", () => {
    expect(addIntervals("2026-11-01", "MONTHLY", 1, 1)).toBe("2026-12-01");
    expect(addIntervals("2026-11-01", "MONTHLY", 2, 1)).toBe("2027-01-01");
    expect(addIntervals("2026-11-15", "QUARTERLY", 1, 15)).toBe("2027-02-15");
    expect(addIntervals("2026-11-15", "YEARLY", 1, 15)).toBe("2027-11-15");
    expect(addIntervals("2026-11-15", "MONTHLY", 0, 15)).toBe("2026-11-15");
  });

  it("lands on a shorter month's last day, and back on the anchor after it", () => {
    expect(addIntervals("2027-01-31", "MONTHLY", 1, 31)).toBe("2027-02-28");
    expect(addIntervals("2028-01-31", "MONTHLY", 1, 31)).toBe("2028-02-29");
    // From the moved date, with the anchor kept: back to the 31st, never the 28th for good.
    expect(addIntervals("2027-02-28", "MONTHLY", 1, 31)).toBe("2027-03-31");
    expect(addIntervals("2027-03-31", "MONTHLY", 1, 31)).toBe("2027-04-30");
    expect(addIntervals("2026-11-30", "QUARTERLY", 1, 30)).toBe("2027-02-28");
    expect(addIntervals("2028-02-29", "YEARLY", 1, 29)).toBe("2029-02-28");
    expect(addIntervals("2029-02-28", "YEARLY", 1, 29)).toBe("2030-02-28");
    expect(addIntervals("2031-02-28", "YEARLY", 1, 29)).toBe("2032-02-29");
  });

  it("refuses a malformed day, a bad anchor or a negative count", () => {
    expect(addIntervals("2026-02-30", "MONTHLY", 1, 30)).toBeNull();
    expect(addIntervals("2026-1-01", "MONTHLY", 1, 1)).toBeNull();
    expect(addIntervals("2026-11-01", "MONTHLY", 1, 0)).toBeNull();
    expect(addIntervals("2026-11-01", "MONTHLY", 1, 32)).toBeNull();
    expect(addIntervals("2026-11-01", "MONTHLY", -1, 1)).toBeNull();
    expect(addIntervals("2026-11-01", "MONTHLY", 1.5, 1)).toBeNull();
  });
});

describe("anchorOf — the stored day, else the date's own", () => {
  it("takes renewal_day when it is set, else the date's day", () => {
    expect(anchorOf("2027-02-28", 31)).toBe(31);
    expect(anchorOf("2027-02-28", null)).toBe(28);
    expect(anchorOf("2027-02-28", 0)).toBe(28);
    expect(anchorOf("2027-02-30", null)).toBeNull();
  });
});

describe("nextRenewal — a passed date moves on to the first renewal after today", () => {
  it("moves a date that passed yesterday by one interval", () => {
    expect(nextRenewal("2026-11-01", "2026-11-02", "MONTHLY", 1)).toEqual({ next: "2026-12-01", steps: 1 });
    expect(nextRenewal("2026-11-01", "2026-11-02", "YEARLY", 1)).toEqual({ next: "2027-11-01", steps: 1 });
  });

  it("leaves a date due today, or still to come, where it is", () => {
    expect(nextRenewal("2026-11-01", "2026-11-01", "MONTHLY", 1)).toBeNull();
    expect(nextRenewal("2026-12-01", "2026-11-01", "MONTHLY", 1)).toBeNull();
  });

  it("catches up several intervals at once, never stopping on today", () => {
    expect(nextRenewal("2026-01-01", "2026-10-12", "MONTHLY", 1)).toEqual({ next: "2026-11-01", steps: 10 });
    expect(nextRenewal("2026-01-12", "2026-10-12", "MONTHLY", 12)).toEqual({ next: "2026-11-12", steps: 10 });
    expect(nextRenewal("2024-03-01", "2026-10-12", "QUARTERLY", 1)).toEqual({ next: "2026-12-01", steps: 11 });
  });

  it("keeps a month-end anchor through the catch-up", () => {
    expect(nextRenewal("2027-01-31", "2027-03-01", "MONTHLY", 31)).toEqual({ next: "2027-03-31", steps: 2 });
    expect(nextRenewal("2027-02-28", "2027-03-01", "MONTHLY", 31)).toEqual({ next: "2027-03-31", steps: 1 });
  });

  it("refuses a date further behind than the step bound", () => {
    expect(MAX_RENEWAL_STEPS).toBe(600);
    expect(nextRenewal("1976-11-01", "2026-10-12", "MONTHLY", 1)).toEqual({ next: "2026-11-01", steps: 600 });
    expect(nextRenewal("1976-10-01", "2026-10-12", "MONTHLY", 1)).toBeNull(); // 601 steps
    expect(nextRenewal("1900-01-01", "2026-10-12", "MONTHLY", 1)).toBeNull();
    expect(nextRenewal("2000-01-01", "2026-10-12", "YEARLY", 1)).toEqual({ next: "2027-01-01", steps: 27 });
  });

  it("refuses malformed input", () => {
    expect(nextRenewal("2026-13-01", "2026-10-12", "MONTHLY", 1)).toBeNull();
    expect(nextRenewal("2026-01-01", "nope", "MONTHLY", 1)).toBeNull();
    expect(nextRenewal("2026-01-01", "2026-10-12", "MONTHLY", 40)).toBeNull();
  });
});

describe("periodOf and daysCovered — the days one renewal bills", () => {
  it("runs from the renewal day to the day before the next", () => {
    expect(periodOf("2026-11-01", "MONTHLY", 1)).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(periodOf("2026-12-15", "MONTHLY", 15)).toEqual({ start: "2026-12-15", end: "2027-01-14" });
    expect(periodOf("2026-10-01", "QUARTERLY", 1)).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(periodOf("2026-01-01", "YEARLY", 1)).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(periodOf("2027-01-31", "MONTHLY", 31)).toEqual({ start: "2027-01-31", end: "2027-02-27" });
    expect(periodOf("2027-02-28", "MONTHLY", 31)).toEqual({ start: "2027-02-28", end: "2027-03-30" });
  });

  it("counts both ends", () => {
    expect(daysCovered("2026-11-01", "2026-11-30")).toBe(30);
    expect(daysCovered("2026-11-01", "2026-11-15")).toBe(15);
    expect(daysCovered("2026-11-01", "2026-11-01")).toBe(1);
    expect(daysCovered("2028-01-01", "2028-12-31")).toBe(366);
    expect(daysCovered("2026-03-01", "2026-03-31")).toBe(31); // across the clocks' change: whole days, never hours
  });
});
