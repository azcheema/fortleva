import { describe, expect, it } from "vitest";

import { SNOOZE_PRESETS, snoozeUntil, type SnoozePreset } from "./snooze";

/**
 * The presets are the one piece of the inbox that is arithmetic rather
 * than a query, and they are computed on the CLIENT — so the failure
 * mode is a row parked at the wrong hour, or (worse) an instant in the
 * past that the service then refuses with a generic toast. Every case
 * below is written against a LOCAL wall clock, because that is the
 * clock the member reads.
 */

/** Local, not UTC: these tests are about what the member's clock says. */
const at = (y: number, m: number, d: number, h: number, min = 0): Date =>
  new Date(y, m - 1, d, h, min, 0, 0);

const isMorning = (d: Date) =>
  d.getHours() === 9 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;

describe("snoozeUntil", () => {
  it.each(SNOOZE_PRESETS.map((p) => [p] as [SnoozePreset]))(
    "%s is always in the future — the service refuses anything else",
    (preset) => {
      // Every hour of a whole week: the boundary cases (a Monday before
      // nine, a Sunday at midnight, 23:00 on any day) are all in here.
      for (let day = 5; day <= 11; day++) {
        for (let hour = 0; hour < 24; hour++) {
          const now = at(2026, 10, day, hour, 30);
          expect(snoozeUntil(preset, now).getTime()).toBeGreaterThan(now.getTime());
        }
      }
    },
  );

  it("inThreeHours is exactly three hours, even across midnight", () => {
    const now = at(2026, 10, 5, 23, 15);
    const till = snoozeUntil("inThreeHours", now);
    expect(till.getTime() - now.getTime()).toBe(3 * 60 * 60 * 1000);
    expect(till.getDate()).toBe(6);
  });

  it("tomorrow is the next calendar day at 09:00 local, from any hour", () => {
    for (const hour of [0, 8, 9, 10, 23]) {
      const till = snoozeUntil("tomorrow", at(2026, 10, 5, hour));
      expect(till.getDate()).toBe(6);
      expect(isMorning(till)).toBe(true);
    }
  });

  it("tomorrow crosses a month boundary", () => {
    const till = snoozeUntil("tomorrow", at(2026, 10, 31, 22));
    expect([till.getMonth(), till.getDate()]).toEqual([10, 1]); // 1 November
    expect(isMorning(till)).toBe(true);
  });

  it("nextWeek is the NEXT Monday — on a Monday that is seven days, not today", () => {
    // 2026-10-05 is a Monday.
    const monday = at(2026, 10, 5, 7);
    expect(monday.getDay()).toBe(1);
    const till = snoozeUntil("nextWeek", monday);
    expect(till.getDay()).toBe(1);
    expect(till.getDate()).toBe(12);
    expect(isMorning(till)).toBe(true);
  });

  it("nextWeek from a Sunday is tomorrow, not eight days away", () => {
    const sunday = at(2026, 10, 11, 20);
    expect(sunday.getDay()).toBe(0);
    const till = snoozeUntil("nextWeek", sunday);
    expect(till.getDay()).toBe(1);
    expect(till.getDate()).toBe(12);
  });

  it("every day of a week resolves nextWeek to a Monday at 09:00", () => {
    for (let day = 5; day <= 11; day++) {
      const till = snoozeUntil("nextWeek", at(2026, 10, day, 13));
      expect(till.getDay()).toBe(1);
      expect(isMorning(till)).toBe(true);
    }
  });
});
