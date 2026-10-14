import { describe, expect, it } from "vitest";

import { addMonths, foldTop, isChartPeriod, lastDayOf, monthWindow, periodRange } from "./chart-shapes";

describe("the team charts' periods (slice 117, C93 (b))", () => {
  it("runs this month to today", () => {
    expect(periodRange("this", "2026-10-14")).toEqual({ from: "2026-10-01", to: "2026-10-14", months: ["2026-10"] });
  });

  it("takes the whole of last month, across a year end", () => {
    expect(periodRange("last", "2026-01-05")).toEqual({ from: "2025-12-01", to: "2025-12-31", months: ["2025-12"] });
    expect(periodRange("last", "2024-03-31")).toEqual({ from: "2024-02-01", to: "2024-02-29", months: ["2024-02"] });
  });

  it("takes the last 3 months as two whole months and this one to today", () => {
    expect(periodRange("3m", "2026-02-10")).toEqual({
      from: "2025-12-01",
      to: "2026-02-10",
      months: ["2025-12", "2026-01", "2026-02"],
    });
  });

  it("draws six months ending with the period's last month", () => {
    expect(monthWindow(periodRange("this", "2026-03-02"))).toEqual(["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"]);
    expect(monthWindow(periodRange("last", "2026-03-02")).at(-1)).toBe("2026-02");
  });

  it("does month arithmetic on strings", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2025-12", 1)).toBe("2026-01");
    expect(addMonths("2026-05", -17)).toBe("2024-12");
    expect(lastDayOf("2026-02")).toBe("2026-02-28");
  });

  it("knows its own values and nothing else", () => {
    expect(isChartPeriod("3m")).toBe(true);
    expect(isChartPeriod("30d")).toBe(false);
    expect(isChartPeriod(undefined)).toBe(false);
  });
});

describe("folding a ranked list into the top eight and Other", () => {
  const merge = (rest: readonly number[]) => rest.reduce((a, b) => a + b, 0);

  it("folds only what is past the cut", () => {
    expect(foldTop([9, 8, 7, 6, 5, 4, 3, 2, 1, 1], 8, merge)).toEqual({ shown: [9, 8, 7, 6, 5, 4, 3, 2], other: 2 });
  });

  it("draws no Other when nothing is left over", () => {
    expect(foldTop([3, 2, 1], 8, merge)).toEqual({ shown: [3, 2, 1], other: null });
    expect(foldTop([], 8, merge)).toEqual({ shown: [], other: null });
  });
});
