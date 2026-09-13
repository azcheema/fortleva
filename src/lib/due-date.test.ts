import { describe, expect, it } from "vitest";

import { DUE_TOKENS, dueChoiceToIso, isDueToken, parseDueQuery, resolveDueToken, todayIn } from "./due-date";
import { addDays, weekContaining, type WeekStart } from "./week";

const WEEK_STARTS: readonly WeekStart[] = ["MONDAY", "SUNDAY", "SATURDAY"];
const DOW: Record<WeekStart, number> = { MONDAY: 1, SUNDAY: 0, SATURDAY: 6 };
const dow = (iso: string): number => new Date(`${iso}T00:00:00.000Z`).getUTCDay();
const daysAhead = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);

describe("todayIn — the member's day, in THEIR zone", () => {
  const instant = new Date("2026-09-14T22:30:00Z");

  it("is already tomorrow in Stockholm", () => {
    expect(todayIn("Europe/Stockholm", instant)).toBe("2026-09-15");
  });

  it("is still today in Los Angeles", () => {
    expect(todayIn("America/Los_Angeles", instant)).toBe("2026-09-14");
  });
});

describe("resolveDueToken", () => {
  // 2026-09-14 is a Monday; the week runs through Sunday the 20th.
  const week = Array.from({ length: 7 }, (_, i) => addDays("2026-09-14", i));

  it("today is today, tomorrow is +1", () => {
    for (const ws of WEEK_STARTS) {
      for (const today of week) {
        expect(resolveDueToken("today", today, ws)).toBe(today);
        expect(resolveDueToken("tomorrow", today, ws)).toBe(addDays(today, 1));
      }
    }
  });

  it("next week is the first day of the next grid week: 1–7 days ahead, on weekStart, for all 7 days × 3 starts", () => {
    for (const ws of WEEK_STARTS) {
      for (const today of week) {
        const next = resolveDueToken("nextWeek", today, ws);
        expect(next, `${today} ${ws}`).toBe(addDays(weekContaining(today, ws).from, 7));
        expect(daysAhead(today, next), `${today} ${ws}`).toBeGreaterThanOrEqual(1);
        expect(daysAhead(today, next), `${today} ${ws}`).toBeLessThanOrEqual(7);
        expect(dow(next), `${today} ${ws}`).toBe(DOW[ws]);
      }
    }
  });

  it("on a Sunday in a Monday tenant, next week IS tomorrow — the same day, never the same value", () => {
    expect(resolveDueToken("nextWeek", "2026-09-13", "MONDAY")).toBe("2026-09-14");
    expect(resolveDueToken("tomorrow", "2026-09-13", "MONDAY")).toBe("2026-09-14");
    expect(new Set(DUE_TOKENS).size).toBe(DUE_TOKENS.length);
  });

  it("rolls over month and year ends", () => {
    // 2026-12-31 is a Thursday.
    expect(resolveDueToken("tomorrow", "2026-12-31", "MONDAY")).toBe("2027-01-01");
    expect(resolveDueToken("nextWeek", "2026-12-31", "MONDAY")).toBe("2027-01-04");
    expect(resolveDueToken("nextWeek", "2026-12-31", "SUNDAY")).toBe("2027-01-03");
    expect(resolveDueToken("nextWeek", "2026-12-31", "SATURDAY")).toBe("2027-01-02");
    // 2026-09-30 is a Wednesday.
    expect(resolveDueToken("tomorrow", "2026-09-30", "MONDAY")).toBe("2026-10-01");
    expect(resolveDueToken("nextWeek", "2026-09-30", "MONDAY")).toBe("2026-10-05");
  });
});

describe("parseDueQuery", () => {
  it("accepts a padded ISO date", () => {
    expect(parseDueQuery(" 2026-09-15 ")).toBe("2026-09-15");
    expect(parseDueQuery("2031-03-14")).toBe("2031-03-14");
  });

  it("refuses what the server would refuse", () => {
    for (const q of ["2026-02-30", "1969-12-31", "2101-01-01", "15/9", "", "   ", "today", "2026-9-15"]) {
      expect(parseDueQuery(q), JSON.stringify(q)).toBeNull();
    }
  });
});

describe("dueChoiceToIso", () => {
  // 2026-09-16 is a Wednesday.
  const today = "2026-09-16";

  it('"none" clears', () => {
    expect(dueChoiceToIso("none", today, "MONDAY")).toBeNull();
  });

  it("tokens resolve against the given today", () => {
    expect(dueChoiceToIso("today", today, "MONDAY")).toBe("2026-09-16");
    expect(dueChoiceToIso("tomorrow", today, "MONDAY")).toBe("2026-09-17");
    expect(dueChoiceToIso("nextWeek", today, "MONDAY")).toBe("2026-09-21");
    expect(dueChoiceToIso("nextWeek", today, "SUNDAY")).toBe("2026-09-20");
  });

  it("an ISO date passes through", () => {
    expect(dueChoiceToIso("2031-03-14", today, "MONDAY")).toBe("2031-03-14");
  });

  it("anything else is not a value", () => {
    for (const c of ["", "junk", "NONE", "Today", "2026-02-30", "1969-12-31"]) {
      expect(dueChoiceToIso(c, today, "MONDAY"), JSON.stringify(c)).toBeUndefined();
    }
  });

  it("a token that resolves past 2100 is not a value either", () => {
    expect(dueChoiceToIso("tomorrow", "2100-12-31", "MONDAY")).toBeUndefined();
    expect(dueChoiceToIso("today", "2100-12-31", "MONDAY")).toBe("2100-12-31");
  });
});

describe("isDueToken", () => {
  it("accepts exactly the three token ids", () => {
    for (const t of DUE_TOKENS) expect(isDueToken(t)).toBe(true);
    for (const v of ["2026-09-15", "none", "Today", "next_week", ""]) {
      expect(isDueToken(v), JSON.stringify(v)).toBe(false);
    }
  });
});
