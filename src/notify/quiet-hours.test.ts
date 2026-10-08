import { describe, expect, it } from "vitest";

import { isQuietAt, localHour, NO_QUIET_HOURS, quietHoursOf, quietRelease, type QuietHours } from "./quiet-hours";

/**
 * Quiet hours decide when a work email may leave (C73 (e), (f)). A wrong
 * answer either wakes someone at night or holds their mail a day too long, so
 * the rule is pinned on the wall clocks it is read on — both of Stockholm's
 * clock changes, a zone a half-hour off UTC, a span over midnight and one
 * inside the day, the weekend alone and with nights.
 */

const STHLM = "Europe/Stockholm";
const nights: QuietHours = { from: 19, to: 7, weekends: false };
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

describe("isQuietAt", () => {
  it("nights 19 → 7: from is inside, to is outside", () => {
    // 2026-10-07 is a Wednesday; Stockholm is on summer time (UTC+2).
    expect(isQuietAt(new Date("2026-10-07T17:00:00Z"), nights, STHLM)).toBe(true); // 19:00
    expect(isQuietAt(new Date("2026-10-07T16:59:59Z"), nights, STHLM)).toBe(false); // 18:59
    expect(isQuietAt(new Date("2026-10-08T04:59:59Z"), nights, STHLM)).toBe(true); // 06:59
    expect(isQuietAt(new Date("2026-10-08T05:00:00Z"), nights, STHLM)).toBe(false); // 07:00
  });

  it("a daytime span 12 → 14", () => {
    const lunch: QuietHours = { from: 12, to: 14, weekends: false };
    expect(isQuietAt(new Date("2026-10-07T11:00:00Z"), lunch, STHLM)).toBe(true); // 13:00
    expect(isQuietAt(new Date("2026-10-07T09:59:00Z"), lunch, STHLM)).toBe(false); // 11:59
    expect(isQuietAt(new Date("2026-10-07T12:00:00Z"), lunch, STHLM)).toBe(false); // 14:00
  });

  it("the weekend alone is Saturday and Sunday, midnight to midnight, local", () => {
    const weekend: QuietHours = { from: null, to: null, weekends: true };
    expect(isQuietAt(new Date("2026-10-09T21:59:00Z"), weekend, STHLM)).toBe(false); // Fri 23:59
    expect(isQuietAt(new Date("2026-10-09T22:00:00Z"), weekend, STHLM)).toBe(true); // Sat 00:00
    expect(isQuietAt(new Date("2026-10-11T21:59:00Z"), weekend, STHLM)).toBe(true); // Sun 23:59
    expect(isQuietAt(new Date("2026-10-11T22:00:00Z"), weekend, STHLM)).toBe(false); // Mon 00:00
  });

  it("nothing set is never quiet", () => {
    expect(isQuietAt(new Date("2026-10-10T02:00:00Z"), NO_QUIET_HOURS, STHLM)).toBe(false);
    expect(quietRelease(new Date("2026-10-10T02:00:00Z"), NO_QUIET_HOURS, STHLM)).toBeNull();
  });
});

describe("quietRelease", () => {
  it("is null when the instant is not quiet", () => {
    expect(quietRelease(new Date("2026-10-07T10:00:00Z"), nights, STHLM)).toBeNull();
  });

  it("an evening mail waits for the next morning's 07:00", () => {
    // Wed 20:30 local → Thu 07:00 local.
    expect(iso(quietRelease(new Date("2026-10-07T18:30:00Z"), nights, STHLM))).toBe("2026-10-08T05:00:00.000Z");
  });

  it("an early-morning mail waits for the same morning's 07:00", () => {
    expect(iso(quietRelease(new Date("2026-10-08T04:59:00Z"), nights, STHLM))).toBe("2026-10-08T05:00:00.000Z");
  });

  it("a quiet lunch ends at 14:00 the same day", () => {
    const lunch: QuietHours = { from: 12, to: 14, weekends: false };
    expect(iso(quietRelease(new Date("2026-10-07T11:00:00Z"), lunch, STHLM))).toBe("2026-10-07T12:00:00.000Z");
  });

  it("23 → 0 ends at the next local midnight", () => {
    const late: QuietHours = { from: 23, to: 0, weekends: false };
    // Wed 23:30 local → Thu 00:00 local.
    expect(iso(quietRelease(new Date("2026-10-07T21:30:00Z"), late, STHLM))).toBe("2026-10-07T22:00:00.000Z");
  });

  it("the weekend alone ends at Monday 00:00", () => {
    const weekend: QuietHours = { from: null, to: null, weekends: true };
    // Sat 10:00 local → Mon 00:00 local.
    expect(iso(quietRelease(new Date("2026-10-10T08:00:00Z"), weekend, STHLM))).toBe("2026-10-11T22:00:00.000Z");
  });

  it("nights and the weekend: Friday evening and Saturday both wait for Monday 07:00", () => {
    const both: QuietHours = { from: 19, to: 7, weekends: true };
    // Fri 20:00 local — Saturday 07:00 and Monday 00:00 are still quiet.
    expect(iso(quietRelease(new Date("2026-10-09T18:00:00Z"), both, STHLM))).toBe("2026-10-12T05:00:00.000Z");
    // Sat 10:00 local.
    expect(iso(quietRelease(new Date("2026-10-10T08:00:00Z"), both, STHLM))).toBe("2026-10-12T05:00:00.000Z");
  });

  it("follows the wall clock over the autumn change (25 October 2026)", () => {
    // Sat 22:00 summer time (UTC+2) → Sun 07:00 winter time (UTC+1).
    expect(iso(quietRelease(new Date("2026-10-24T20:00:00Z"), nights, STHLM))).toBe("2026-10-25T06:00:00.000Z");
  });

  it("a `to` hour lost to the spring change (29 March 2026) resolves an hour later", () => {
    const toTwo: QuietHours = { from: 22, to: 2, weekends: false };
    // Sat 23:00 winter time; Sunday has no 02:00 — 03:00 summer time instead.
    expect(iso(quietRelease(new Date("2026-03-28T22:00:00Z"), toTwo, STHLM))).toBe("2026-03-29T01:00:00.000Z");
  });

  it("a zone a half-hour off UTC (Kolkata)", () => {
    const q: QuietHours = { from: 22, to: 6, weekends: false };
    // Wed 23:00 IST (UTC+5:30) → Thu 06:00 IST.
    expect(iso(quietRelease(new Date("2026-10-07T17:30:00Z"), q, "Asia/Kolkata"))).toBe("2026-10-08T00:30:00.000Z");
    expect(localHour(new Date("2026-10-07T17:30:00Z"), "Asia/Kolkata")).toBe(23);
  });

  it("a zone west of UTC (New York)", () => {
    // Wed 21:00 EDT (UTC-4) → Thu 07:00 EDT.
    expect(iso(quietRelease(new Date("2026-10-08T01:00:00Z"), nights, "America/New_York"))).toBe("2026-10-08T11:00:00.000Z");
  });
});

describe("quietHoursOf", () => {
  it("reads a whole pair and the weekend tick", () => {
    expect(quietHoursOf({ quietHoursFrom: 19, quietHoursTo: 7, quietWeekends: true })).toEqual({ from: 19, to: 7, weekends: true });
  });

  it("reads anything this build would not write as no hours", () => {
    for (const [from, to] of [
      [19, null],
      [null, 7],
      [7, 7],
      [24, 7],
      [-1, 7],
      [19.5, 7],
    ] as const) {
      expect(quietHoursOf({ quietHoursFrom: from, quietHoursTo: to, quietWeekends: false })).toEqual(NO_QUIET_HOURS);
    }
  });

  it("no row is no quiet time", () => {
    expect(quietHoursOf(null)).toEqual(NO_QUIET_HOURS);
  });
});
