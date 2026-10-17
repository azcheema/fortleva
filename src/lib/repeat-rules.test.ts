import { describe, expect, it } from "vitest";

import { addIntervals } from "@/services/renewal-dates";

import {
  REPEAT_MAX_DAYS_AHEAD,
  REPEAT_RHYTHMS,
  anchorFor,
  copyDueDate,
  firstRepeatDay,
  isRepeatRhythm,
  nextDayAllowed,
  owedCopy,
  parseRepeatValue,
  repeatAfter,
  repeatValue,
} from "./repeat-rules";

describe("repeatAfter — the repeat day after a day", () => {
  it("steps a week rhythm by 7 or 14 days, keeping the weekday", () => {
    expect(repeatAfter("2026-10-19", "WEEKLY", null)).toBe("2026-10-26");
    expect(repeatAfter("2026-12-28", "WEEKLY", null)).toBe("2027-01-04");
    expect(repeatAfter("2026-10-19", "BIWEEKLY", null)).toBe("2026-11-02");
  });

  it("steps a month rhythm by one, three and twelve months on its anchor", () => {
    expect(repeatAfter("2026-11-01", "MONTHLY", 1)).toBe("2026-12-01");
    expect(repeatAfter("2026-12-01", "MONTHLY", 1)).toBe("2027-01-01");
    expect(repeatAfter("2026-11-15", "QUARTERLY", 15)).toBe("2027-02-15");
    expect(repeatAfter("2026-11-15", "YEARLY", 15)).toBe("2027-11-15");
  });

  it("lands on a shorter month's last day and goes back to the anchor after it", () => {
    expect(repeatAfter("2027-01-31", "MONTHLY", 31)).toBe("2027-02-28");
    expect(repeatAfter("2027-02-28", "MONTHLY", 31)).toBe("2027-03-31");
    expect(repeatAfter("2028-01-30", "MONTHLY", 30)).toBe("2028-02-29");
    expect(repeatAfter("2026-11-30", "QUARTERLY", 31)).toBe("2027-02-28");
    // A yearly 29 February: the 28th in a common year, the 29th again in a leap year.
    expect(repeatAfter("2028-02-29", "YEARLY", 29)).toBe("2029-02-28");
    expect(repeatAfter("2031-02-28", "YEARLY", 29)).toBe("2032-02-29");
  });

  it("is the agreements' month rule exactly (renewal-dates' addIntervals)", () => {
    const map = { MONTHLY: "MONTHLY", QUARTERLY: "QUARTERLY", YEARLY: "YEARLY" } as const;
    for (const rhythm of ["MONTHLY", "QUARTERLY", "YEARLY"] as const) {
      for (const anchor of [1, 15, 28, 29, 30, 31]) {
        let day = `2027-01-${String(Math.min(anchor, 31)).padStart(2, "0")}`;
        for (let i = 0; i < 30; i++) {
          const ours = repeatAfter(day, rhythm, anchor);
          expect(ours).toBe(addIntervals(day, map[rhythm], 1, anchor));
          day = ours!;
        }
      }
    }
  });

  it("refuses a malformed day, a missing anchor on a month rhythm, and a year past the calendar", () => {
    expect(repeatAfter("2026-02-30", "WEEKLY", null)).toBeNull();
    expect(repeatAfter("not a day", "MONTHLY", 1)).toBeNull();
    expect(repeatAfter("2026-11-01", "MONTHLY", null)).toBeNull();
    expect(repeatAfter("2026-11-01", "MONTHLY", 32)).toBeNull();
    expect(repeatAfter("2100-12-31", "WEEKLY", null)).toBeNull();
    expect(repeatAfter("2100-06-01", "YEARLY", 1)).toBeNull();
  });
});

describe("anchorFor + firstRepeatDay — starting a repeat", () => {
  it("anchors a month rhythm on the day of the month, a week rhythm on nothing", () => {
    expect(anchorFor("MONTHLY", "2026-10-31")).toBe(31);
    expect(anchorFor("YEARLY", "2026-02-01")).toBe(1);
    expect(anchorFor("WEEKLY", "2026-10-31")).toBeNull();
    expect(anchorFor("BIWEEKLY", "2026-10-31")).toBeNull();
  });

  it("starts one period from today", () => {
    expect(firstRepeatDay("WEEKLY", "2026-10-17")).toBe("2026-10-24");
    expect(firstRepeatDay("BIWEEKLY", "2026-10-17")).toBe("2026-10-31");
    expect(firstRepeatDay("MONTHLY", "2026-10-17")).toBe("2026-11-17");
    expect(firstRepeatDay("QUARTERLY", "2026-10-17")).toBe("2027-01-17");
    expect(firstRepeatDay("YEARLY", "2026-10-17")).toBe("2027-10-17");
    // The 31st of a month followed by a shorter one: its last day.
    expect(firstRepeatDay("MONTHLY", "2026-10-31")).toBe("2026-11-30");
    expect(firstRepeatDay("WEEKLY", "nope")).toBeNull();
  });

  it("every rhythm's first day is an allowed next day", () => {
    for (const rhythm of REPEAT_RHYTHMS) {
      for (const today of ["2026-01-31", "2026-10-17", "2028-02-29", "2026-12-31"]) {
        expect(nextDayAllowed(firstRepeatDay(rhythm, today)!, today)).toBe(true);
      }
    }
  });
});

describe("nextDayAllowed — the bounds a member's next day is held to", () => {
  it("takes a day after today, up to two years ahead", () => {
    expect(nextDayAllowed("2026-10-18", "2026-10-17")).toBe(true);
    expect(nextDayAllowed("2026-10-17", "2026-10-17")).toBe(false);
    expect(nextDayAllowed("2026-10-16", "2026-10-17")).toBe(false);
    expect(REPEAT_MAX_DAYS_AHEAD).toBe(731);
    expect(nextDayAllowed("2028-10-17", "2026-10-17")).toBe(true); // 731 days on (2028 is a leap year)
    expect(nextDayAllowed("2028-10-18", "2026-10-17")).toBe(false);
    expect(nextDayAllowed("2026-02-30", "2026-01-01")).toBe(false);
  });
});

describe("owedCopy — ONE copy, for the latest repeat day (C103 (b), design §3.5)", () => {
  it("owes nothing before the next day", () => {
    expect(owedCopy("2026-11-01", "2026-10-31", "MONTHLY", 1)).toBeNull();
  });

  it("owes the copy for the next day on that day, and moves past today", () => {
    expect(owedCopy("2026-11-01", "2026-11-01", "MONTHLY", 1)).toEqual({ madeFor: "2026-11-01", nextOn: "2026-12-01", skipped: 0 });
    expect(owedCopy("2026-10-19", "2026-10-19", "WEEKLY", null)).toEqual({ madeFor: "2026-10-19", nextOn: "2026-10-26", skipped: 0 });
  });

  it("owes it the day after too (a kick that came late)", () => {
    expect(owedCopy("2026-11-01", "2026-11-02", "MONTHLY", 1)).toEqual({ madeFor: "2026-11-01", nextOn: "2026-12-01", skipped: 0 });
  });

  it("after a gap, owes ONE copy for the latest day and skips the earlier ones", () => {
    // Weekly from Mon 5 Oct; nothing ran until Wed 28 Oct: the 26th is the latest day.
    expect(owedCopy("2026-10-05", "2026-10-28", "WEEKLY", null)).toEqual({ madeFor: "2026-10-26", nextOn: "2026-11-02", skipped: 3 });
    // Monthly on the 31st, three months behind, through February.
    expect(owedCopy("2027-01-31", "2027-04-15", "MONTHLY", 31)).toEqual({ madeFor: "2027-03-31", nextOn: "2027-04-30", skipped: 2 });
  });

  it("never makes a copy that is born late: its due date is today or later", () => {
    for (const rhythm of REPEAT_RHYTHMS) {
      const start = "2026-01-31";
      const anchor = anchorFor(rhythm, start);
      for (const today of ["2026-01-31", "2026-02-01", "2026-03-15", "2026-12-31", "2027-06-30"]) {
        const owed = owedCopy(start, today, rhythm, anchor)!;
        expect(owed.madeFor <= today).toBe(true);
        expect(owed.nextOn > today).toBe(true);
        expect(copyDueDate(owed.madeFor, rhythm, anchor)! >= today).toBe(true);
      }
    }
  });

  it("refuses a malformed row", () => {
    expect(owedCopy("2026-11-01", "2026-12-01", "MONTHLY", null)).toBeNull();
    expect(owedCopy("garbage", "2026-12-01", "WEEKLY", null)).toBeNull();
  });
});

describe("copyDueDate — due the day before the next copy (C103 (d))", () => {
  it("is the period's last day", () => {
    expect(copyDueDate("2026-11-01", "MONTHLY", 1)).toBe("2026-11-30");
    expect(copyDueDate("2027-01-31", "MONTHLY", 31)).toBe("2027-02-27");
    expect(copyDueDate("2026-10-19", "WEEKLY", null)).toBe("2026-10-25");
    expect(copyDueDate("2026-10-19", "BIWEEKLY", null)).toBe("2026-11-01");
    expect(copyDueDate("2026-11-15", "QUARTERLY", 15)).toBe("2027-02-14");
    expect(copyDueDate("2026-11-15", "YEARLY", 15)).toBe("2027-11-14");
  });
});

describe("repeatValue / parseRepeatValue — the history row's text", () => {
  it("round-trips, and refuses anything else", () => {
    expect(repeatValue({ rhythm: "MONTHLY", nextOn: "2026-11-01" })).toBe("MONTHLY:2026-11-01");
    expect(repeatValue(null)).toBeNull();
    expect(parseRepeatValue("MONTHLY:2026-11-01")).toEqual({ rhythm: "MONTHLY", nextOn: "2026-11-01" });
    expect(parseRepeatValue("DAILY:2026-11-01")).toBeNull();
    expect(parseRepeatValue("MONTHLY:2026-11-31")).toBeNull();
    expect(parseRepeatValue("MONTHLY")).toBeNull();
    expect(parseRepeatValue(null)).toBeNull();
    expect(isRepeatRhythm("YEARLY")).toBe(true);
    expect(isRepeatRhythm("yearly")).toBe(false);
  });
});
