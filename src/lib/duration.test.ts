import { describe, expect, it } from "vitest";

import {
  dateColumn,
  floorToSecond,
  intervalsOverlap,
  isoDateOf,
  localDateString,
  monthStartOf,
  parseDurationSeconds,
  secondsBetween,
  startOfLocalDay,
  zoneOffsetMinutes,
} from "./duration";

describe("duration text → seconds (UI.md rule 9)", () => {
  it.each([
    ["1h 30m", 5400],
    ["1h30m", 5400],
    ["1 h 30 min", 5400],
    ["2h", 7200],
    ["90m", 5400],
    ["45 min", 2700],
    ["1:30", 5400],
    ["0:45", 2700],
    ["1,5", 5400],
    ["1.5", 5400],
    ["2", 7200],
    ["  8H  ", 28800],
    ["1,25", 4500],
  ])("%s → %d", (input, seconds) => {
    expect(parseDurationSeconds(input)).toBe(seconds);
  });

  it("rejects empty, zero, negative, over 24 h and garbage", () => {
    for (const bad of ["", "   ", "0", "0m", "25h", "24:01", "abc", "1h x", "-1", "1:60", "90s"]) {
      expect(parseDurationSeconds(bad), bad).toBeNull();
    }
  });

  it("accepts exactly 24 h and drops sub-minute remainders", () => {
    expect(parseDurationSeconds("24h")).toBe(86400);
    expect(parseDurationSeconds("1.001")).toBe(3600); // 3603.6 s → whole minutes → 3600
  });
});

describe("whole-second arithmetic (the *_duration_exact CHECKs)", () => {
  it("floors to the second and never goes negative", () => {
    const a = new Date("2026-08-20T10:00:00.999Z");
    const b = new Date("2026-08-20T10:00:05.001Z");
    expect(floorToSecond(a).toISOString()).toBe("2026-08-20T10:00:00.000Z");
    expect(secondsBetween(a, b)).toBe(5);
    expect(secondsBetween(b, a)).toBe(0);
  });
});

describe("local dates (DST-safe, Intl-based)", () => {
  it("attributes a midnight-spanning start to its local start date", () => {
    // 23:30 Stockholm summer time = 21:30Z the same day
    const start = new Date("2026-08-20T21:30:00Z");
    expect(localDateString(start, "Europe/Stockholm")).toBe("2026-08-20");
    expect(localDateString(start, "UTC")).toBe("2026-08-20");
    // 00:30 Stockholm = 22:30Z the previous UTC day
    expect(localDateString(new Date("2026-08-20T22:30:00Z"), "Europe/Stockholm")).toBe("2026-08-21");
  });

  it("month start + date columns round-trip", () => {
    expect(monthStartOf("2026-08-20")).toBe("2026-08-01");
    expect(isoDateOf(dateColumn("2026-02-28"))).toBe("2026-02-28");
  });

  it("start of a local day crosses DST correctly", () => {
    // CEST (+2) in August, CET (+1) in January
    expect(startOfLocalDay("2026-08-20", "Europe/Stockholm").toISOString()).toBe("2026-08-19T22:00:00.000Z");
    expect(startOfLocalDay("2026-01-20", "Europe/Stockholm").toISOString()).toBe("2026-01-19T23:00:00.000Z");
    // The DST fall-back day (2026-10-25) still starts at 00:00 CEST
    expect(startOfLocalDay("2026-10-25", "Europe/Stockholm").toISOString()).toBe("2026-10-24T22:00:00.000Z");
    // Spring-forward gap AT local midnight (Santiago: 2026-09-06 00:00 → 01:00):
    // the day has no 00:00 and starts at 01:00 local — never on the day before.
    expect(startOfLocalDay("2026-09-06", "America/Santiago").toISOString()).toBe("2026-09-06T04:00:00.000Z");
    expect(localDateString(startOfLocalDay("2026-09-06", "America/Santiago"), "America/Santiago")).toBe("2026-09-06");
    expect(localDateString(startOfLocalDay("2026-03-08", "America/Havana"), "America/Havana")).toBe("2026-03-08");
    expect(zoneOffsetMinutes(new Date("2026-08-20T12:00:00Z"), "Europe/Stockholm")).toBe(120);
    expect(zoneOffsetMinutes(new Date("2026-01-20T12:00:00Z"), "America/New_York")).toBe(-300);
  });
});

describe("interval overlap (D6 allow + flag)", () => {
  const t = (s: string) => new Date(`2026-08-20T${s}:00Z`);
  it("detects intersections, treats touching edges as disjoint, open end as infinite", () => {
    expect(intervalsOverlap(t("09:00"), t("10:00"), t("09:30"), t("11:00"))).toBe(true);
    expect(intervalsOverlap(t("09:00"), t("10:00"), t("10:00"), t("11:00"))).toBe(false);
    expect(intervalsOverlap(t("09:00"), null, t("12:00"), t("13:00"))).toBe(true);
    expect(intervalsOverlap(t("12:00"), t("13:00"), t("09:00"), null)).toBe(true);
    expect(intervalsOverlap(t("08:00"), t("09:00"), t("09:00"), null)).toBe(false);
  });
});
