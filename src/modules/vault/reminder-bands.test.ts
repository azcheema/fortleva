import { describe, expect, it } from "vitest";

import { REMINDER_BANDS, addDays, bandFor, dayStart, daysUntil, isReminderBand, loginWindowOf, utcDayOf } from "./reminder-bands";

describe("bandFor — the smallest band the date has entered", () => {
  it("names each band at its own edge and just inside it", () => {
    expect(bandFor(60)).toBe(60);
    expect(bandFor(31)).toBe(60);
    expect(bandFor(30)).toBe(30);
    expect(bandFor(15)).toBe(30);
    expect(bandFor(14)).toBe(14);
    expect(bandFor(10)).toBe(14); // added 10 days out: the 14-day reminder, never 60 or 30
    expect(bandFor(8)).toBe(14);
    expect(bandFor(7)).toBe(7);
    expect(bandFor(2)).toBe(7);
    expect(bandFor(1)).toBe(1);
  });

  it("a date due today is inside the 1-day band; a passed one sends nothing", () => {
    expect(bandFor(0)).toBe(1);
    expect(bandFor(-1)).toBeNull();
    expect(bandFor(-30)).toBeNull();
  });

  it("beyond the horizon, or not a whole number of days, sends nothing", () => {
    expect(bandFor(61)).toBeNull();
    expect(bandFor(365)).toBeNull();
    expect(bandFor(Number.NaN)).toBeNull();
    expect(bandFor(6.5)).toBeNull();
    expect(bandFor(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("every day from 0 to 60 has exactly the band its distance names, and the bands are the database's set", () => {
    for (let d = 0; d <= 60; d++) {
      const band = bandFor(d);
      expect(band).not.toBeNull();
      // The smallest band at least `d`: no smaller band would also hold it.
      expect(REMINDER_BANDS.filter((b) => b >= d)[0]).toBe(band);
    }
    // `expiration_reminder_sent_offset_days` (migration 20261003180000).
    expect([...REMINDER_BANDS].sort((a, b) => b - a)).toEqual([60, 30, 14, 7, 1]);
    expect(isReminderBand(14)).toBe(true);
    expect(isReminderBand(15)).toBe(false);
    expect(isReminderBand("14")).toBe(false);
  });
});

describe("loginWindowOf — the expiries a login reminder could have been about", () => {
  it("is exactly the instants the job would have reminded in that band, for every band, at both edges", () => {
    const from = "2031-06-15";
    // The job's own rule: a login is in band B on day `from` when its UTC
    // expiry day is 0..B days after `from` (the smallest band holding it is ≤ B).
    const jobWouldInclude = (t: number, band: number) => {
      const b = bandFor(daysUntil(from, utcDayOf(new Date(t))));
      return b !== null && b <= band;
    };
    for (const band of REMINDER_BANDS) {
      const w = loginWindowOf(from, band)!;
      const inside = (t: number) => t >= w.start && t < w.end;
      for (const t of [w.start, w.start - 1, w.end - 1, w.end, w.start + 12 * 3_600_000]) {
        expect(inside(t), `${band}: ${new Date(t).toISOString()}`).toBe(jobWouldInclude(t, band));
      }
      expect(new Date(w.start).toISOString()).toBe(`${from}T00:00:00.000Z`);
      expect(new Date(w.end).toISOString()).toBe(`${addDays(from, band + 1)}T00:00:00.000Z`);
    }
  });

  it("fails closed on a day that is not one, or a band that is not one", () => {
    expect(loginWindowOf("2031-02-30", 7)).toBeNull();
    expect(loginWindowOf("31-06-15", 7)).toBeNull();
    expect(loginWindowOf("2031-06-15", 15)).toBeNull();
  });
});

describe("days", () => {
  it("counts whole days between two real days, across a month and a DST change", () => {
    expect(daysUntil("2031-06-15", "2031-06-15")).toBe(0);
    expect(daysUntil("2031-06-15", "2031-06-25")).toBe(10);
    expect(daysUntil("2031-06-15", "2031-06-14")).toBe(-1);
    expect(daysUntil("2031-03-29", "2031-03-31")).toBe(2); // Europe's spring change is invisible to UTC days
    expect(daysUntil("2031-12-31", "2032-03-01")).toBe(61);
    expect(addDays("2031-06-15", 60)).toBe("2031-08-14");
    expect(addDays("2031-06-15", -1)).toBe("2031-06-14");
  });

  it("refuses a day that does not exist rather than rolling it over", () => {
    expect(dayStart("2031-02-30")).toBeNaN();
    expect(dayStart("2031-6-15")).toBeNaN();
    expect(daysUntil("2031-06-15", "2031-02-30")).toBeNaN();
    expect(bandFor(daysUntil("2031-06-15", "2031-02-30"))).toBeNull();
  });

  it("an instant's UTC day is its date in UTC, whatever its time", () => {
    expect(utcDayOf(new Date("2031-06-15T00:00:00Z"))).toBe("2031-06-15");
    expect(utcDayOf(new Date("2031-06-15T23:59:59Z"))).toBe("2031-06-15");
  });
});
