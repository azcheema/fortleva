import { describe, expect, it } from "vitest";

import {
  CALENDAR_MAX,
  CALENDAR_MIN,
  addMonthsClamped,
  calendarMoveOf,
  canShowMonth,
  clampDate,
  monthGrid,
  moveDate,
  type CalendarMove,
} from "./calendar";
import { addDays, monthContaining, shiftMonth, type WeekStart } from "./week";

const WEEK_STARTS: readonly WeekStart[] = ["MONDAY", "SUNDAY", "SATURDAY"];
const DOW: Record<WeekStart, number> = { MONDAY: 1, SUNDAY: 0, SATURDAY: 6 };
const dow = (iso: string): number => new Date(`${iso}T00:00:00.000Z`).getUTCDay();

describe("monthGrid", () => {
  const months = Array.from({ length: 24 }, (_, i) => shiftMonth("2026-01", i));

  it("is ALWAYS 6 × 7, starts on weekStart, runs day by day, and holds the whole month — every month of 2026–2027", () => {
    for (const ws of WEEK_STARTS) {
      for (const ym of months) {
        const grid = monthGrid(ym, ws);
        expect(grid, `${ym} ${ws}`).toHaveLength(6);
        for (const row of grid) {
          expect(row.days, `${ym} ${ws}`).toHaveLength(7);
          expect(row.isoWeek, `${ym} ${ws}`).not.toBeNull();
        }
        const days = grid.flatMap((r) => r.days);
        expect(days.includes(null), `${ym} ${ws}`).toBe(false);
        const first = days[0]!;
        expect(dow(first), `${ym} ${ws}`).toBe(DOW[ws]);
        expect(days, `${ym} ${ws}`).toEqual(Array.from({ length: 42 }, (_, i) => addDays(first, i)));
        expect(days, `${ym} ${ws}`).toContain(`${ym}-01`);
        expect(days, `${ym} ${ws}`).toContain(monthContaining(`${ym}-01`).to);
      }
    }
  });

  it("a 4-row month (2027-02) and a 6-row month (2026-03) render at the same size", () => {
    // 2027-02-01 is a Monday and February 2027 has 28 days: four rows,
    // then two rows of March.
    const feb = monthGrid("2027-02", "MONDAY");
    expect(feb[0]!.days[0]).toBe("2027-02-01");
    expect(feb[3]!.days[6]).toBe("2027-02-28");
    expect(feb[4]!.days.every((d) => d!.startsWith("2027-03"))).toBe(true);
    expect(feb).toHaveLength(6);
    // 2026-03-01 is a Sunday: under MONDAY the 31st needs the sixth row.
    const march = monthGrid("2026-03", "MONDAY");
    expect(march[0]!.days[0]).toBe("2026-02-23");
    expect(march[5]!.days).toContain("2026-03-31");
  });

  it("2026-09 under MONDAY starts 2026-08-31 and labels ISO weeks 36–41", () => {
    const grid = monthGrid("2026-09", "MONDAY");
    expect(grid[0]!.days[0]).toBe("2026-08-31");
    expect(grid.map((r) => r.isoWeek)).toEqual([36, 37, 38, 39, 40, 41]);
  });

  it("the row starting 2026-12-28 is ISO week 53", () => {
    const row = monthGrid("2026-12", "MONDAY").find((r) => r.days[0] === "2026-12-28");
    expect(row?.isoWeek).toBe(53);
  });

  it("days before 1970-01-01 are spacers, and the row still has its week number", () => {
    for (const ws of WEEK_STARTS) {
      const grid = monthGrid("1970-01", ws);
      const days = grid.flatMap((r) => r.days);
      const firstReal = days.findIndex((d) => d !== null);
      expect(firstReal, ws).toBeGreaterThan(0);
      expect(days[firstReal], ws).toBe(CALENDAR_MIN);
      expect(days.slice(0, firstReal).every((d) => d === null), ws).toBe(true);
      expect(days.slice(firstReal).every((d) => d !== null), ws).toBe(true);
      const week = grid[0]!.isoWeek;
      expect(week !== null && Number.isInteger(week) && week > 0, ws).toBe(true);
    }
    // 1970-01-01 is a Thursday, so the Monday row is ISO week 1.
    expect(monthGrid("1970-01", "MONDAY")[0]!.isoWeek).toBe(1);
  });

  it("days after 2100-12-31 are spacers", () => {
    for (const ws of WEEK_STARTS) {
      const days = monthGrid("2100-12", ws).flatMap((r) => r.days);
      const last = days.indexOf(CALENDAR_MAX);
      expect(last, ws).toBeGreaterThan(0);
      expect(last, ws).toBeLessThan(41);
      expect(days.slice(last + 1).every((d) => d === null), ws).toBe(true);
      expect(days.slice(0, last + 1).every((d) => d !== null), ws).toBe(true);
    }
  });

  it("December 2100's sixth row is wholly past the bound, so it has no week number — under every week start", () => {
    // 2100-12-01 is a Wednesday and 2100-12-31 a Friday, so the sixth row
    // is January 2101 whatever the week start: 01-03…09 (MONDAY),
    // 01-02…08 (SUNDAY), 01-01…07 (SATURDAY). Its raw week would be "1".
    for (const ws of WEEK_STARTS) {
      const grid = monthGrid("2100-12", ws);
      expect(grid, ws).toHaveLength(6);
      expect(grid[5]!.days, ws).toHaveLength(7);
      expect(grid[5]!.days.every((d) => d === null), ws).toBe(true);
      expect(grid[5]!.isoWeek, ws).toBeNull();
      for (const [r, row] of grid.slice(0, 5).entries()) {
        expect(row.days.some((d) => d !== null), `${ws} row ${r}`).toBe(true);
        expect(row.isoWeek, `${ws} row ${r}`).not.toBeNull();
      }
    }
    // A row that only STRADDLES the bound keeps its number: under MONDAY
    // the fifth row is 2100-12-27 … 2101-01-02, ISO week 52 of 2100.
    const monday = monthGrid("2100-12", "MONDAY");
    expect(monday[4]!.days[0]).toBe("2100-12-27");
    expect(monday[4]!.days[4]).toBe(CALENDAR_MAX);
    expect(monday[4]!.days[5]).toBeNull();
    expect(monday[4]!.isoWeek).toBe(52);
  });

  it("a row has no week number exactly when it has no day — at both bounds, for every week start", () => {
    for (const ws of WEEK_STARTS) {
      for (const ym of ["1970-01", "1970-02", "2100-11", "2100-12"]) {
        for (const row of monthGrid(ym, ws)) {
          expect(row.isoWeek === null, `${ym} ${ws}`).toBe(row.days.every((d) => d === null));
        }
      }
    }
  });
});

describe("moveDate", () => {
  it("moves by day and by week across month and year ends", () => {
    expect(moveDate("2026-12-31", "nextDay", "MONDAY")).toBe("2027-01-01");
    expect(moveDate("2027-01-01", "prevDay", "MONDAY")).toBe("2026-12-31");
    expect(moveDate("2026-09-30", "nextDay", "MONDAY")).toBe("2026-10-01");
    expect(moveDate("2026-12-28", "nextWeek", "MONDAY")).toBe("2027-01-04");
    expect(moveDate("2027-01-02", "prevWeek", "MONDAY")).toBe("2026-12-26");
    expect(moveDate("2026-03-03", "prevWeek", "MONDAY")).toBe("2026-02-24");
  });

  it("Home and End are the grid week's first and last day for each week start", () => {
    // 2026-09-16 is a Wednesday.
    const expected: Record<WeekStart, [string, string]> = {
      MONDAY: ["2026-09-14", "2026-09-20"],
      SUNDAY: ["2026-09-13", "2026-09-19"],
      SATURDAY: ["2026-09-12", "2026-09-18"],
    };
    for (const ws of WEEK_STARTS) {
      const [from, to] = expected[ws];
      expect(moveDate("2026-09-16", "weekStart", ws), ws).toBe(from);
      expect(moveDate("2026-09-16", "weekEnd", ws), ws).toBe(to);
      // Already there: a no-op, so the grid does not re-focus.
      expect(moveDate(from, "weekStart", ws), ws).toBe(from);
      expect(moveDate(to, "weekEnd", ws), ws).toBe(to);
    }
  });

  it("months keep the day, clamped to the target month's length", () => {
    expect(moveDate("2026-01-31", "nextMonth", "MONDAY")).toBe("2026-02-28");
    expect(moveDate("2026-03-31", "prevMonth", "MONDAY")).toBe("2026-02-28");
    expect(moveDate("2028-01-31", "nextMonth", "MONDAY")).toBe("2028-02-29");
    expect(moveDate("2026-12-15", "nextMonth", "MONDAY")).toBe("2027-01-15");
  });

  it("years keep the day, clamped — a leap day lands on the 28th", () => {
    expect(moveDate("2028-02-29", "nextYear", "MONDAY")).toBe("2029-02-28");
    expect(moveDate("2028-02-29", "prevYear", "MONDAY")).toBe("2027-02-28");
    expect(moveDate("2026-09-16", "nextYear", "MONDAY")).toBe("2027-09-16");
  });

  it("clamps at both bounds, whatever the move", () => {
    const back: CalendarMove[] = ["prevDay", "prevWeek", "weekStart", "prevMonth", "prevYear"];
    const forward: CalendarMove[] = ["nextDay", "nextWeek", "weekEnd", "nextMonth", "nextYear"];
    for (const ws of WEEK_STARTS) {
      for (const move of back) expect(moveDate(CALENDAR_MIN, move, ws), `${move} ${ws}`).toBe(CALENDAR_MIN);
      for (const move of forward) expect(moveDate(CALENDAR_MAX, move, ws), `${move} ${ws}`).toBe(CALENDAR_MAX);
    }
    expect(moveDate("1970-01-15", "prevMonth", "MONDAY")).toBe(CALENDAR_MIN);
    expect(moveDate("2100-12-28", "nextWeek", "MONDAY")).toBe(CALENDAR_MAX);
    expect(moveDate("2100-12-20", "nextWeek", "MONDAY")).toBe("2100-12-27");
  });
});

describe("addMonthsClamped", () => {
  it("clamps the day to the target month and crosses year ends both ways", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2026-05-31", -1)).toBe("2026-04-30");
    expect(addMonthsClamped("2026-11-15", 2)).toBe("2027-01-15");
    expect(addMonthsClamped("2026-01-15", -1)).toBe("2025-12-15");
    expect(addMonthsClamped("2100-12-31", 1)).toBe(CALENDAR_MAX);
  });
});

describe("canShowMonth and clampDate", () => {
  it("allows 1970-01 through 2100-12 and nothing else", () => {
    expect(canShowMonth("1970-01")).toBe(true);
    expect(canShowMonth("2100-12")).toBe(true);
    expect(canShowMonth("2026-09")).toBe(true);
    expect(canShowMonth("1969-12")).toBe(false);
    expect(canShowMonth("2101-01")).toBe(false);
    expect(canShowMonth("junk")).toBe(false);
  });

  it("clamps into [CALENDAR_MIN, CALENDAR_MAX]", () => {
    expect(clampDate("1969-12-31")).toBe(CALENDAR_MIN);
    expect(clampDate("2101-01-01")).toBe(CALENDAR_MAX);
    expect(clampDate("2026-09-16")).toBe("2026-09-16");
  });
});

describe("calendarMoveOf — the keys a focused day owns", () => {
  const key = (k: string, over: Partial<Parameters<typeof calendarMoveOf>[0]> = {}) =>
    calendarMoveOf({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over });

  it("maps the grid keys", () => {
    expect(key("ArrowLeft")).toBe("prevDay");
    expect(key("ArrowRight")).toBe("nextDay");
    expect(key("ArrowUp")).toBe("prevWeek");
    expect(key("ArrowDown")).toBe("nextWeek");
    expect(key("Home")).toBe("weekStart");
    expect(key("End")).toBe("weekEnd");
    expect(key("PageUp")).toBe("prevMonth");
    expect(key("PageDown")).toBe("nextMonth");
    expect(key("PageUp", { shiftKey: true })).toBe("prevYear");
    expect(key("PageDown", { shiftKey: true })).toBe("nextYear");
  });

  it("returns null for ANY Ctrl/Meta/Alt chord — ⌘K must reach the window dispatcher", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
      for (const k of ["ArrowLeft", "ArrowDown", "Home", "PageDown", "k", "K"]) {
        expect(key(k, { [mod]: true }), `${mod}+${k}`).toBeNull();
      }
    }
    expect(key("PageDown", { shiftKey: true, altKey: true })).toBeNull();
  });

  it("returns null for Shift with anything but PageUp/PageDown", () => {
    expect(key("ArrowLeft", { shiftKey: true })).toBeNull();
    expect(key("Home", { shiftKey: true })).toBeNull();
    expect(key("Tab", { shiftKey: true })).toBeNull();
  });

  it("returns null for every key it does not own — Enter/Space click, Tab and Escape stay Radix's", () => {
    for (const k of ["Enter", " ", "p", "?", "Escape", "Tab", "g", "d"]) {
      expect(key(k), JSON.stringify(k)).toBeNull();
    }
  });
});
