import { describe, expect, it } from "vitest";

import { dueAt, selectOptIns, type OptInCandidate } from "./weekly-reminder";

/**
 * The two decisions in the weekly reminder that can send someone mail
 * they did not ask for, or send it at the wrong hour. Both are pure, so
 * both are tested here rather than against a database.
 */

const row = (over: Partial<OptInCandidate> = {}): OptInCandidate => ({
  tenantId: "t1",
  receiverId: "m1",
  perKind: { "time.weekly_reminder": { email: true } },
  emailLevel: "PARTICIPATING",
  ...over,
});

describe("selectOptIns", () => {
  it("takes only the rows that ticked the box", () => {
    expect(selectOptIns([row()])).toEqual([{ tenantId: "t1", memberId: "m1" }]);
  });

  it("IT IS OPT-IN: every shape that is not an explicit true is off", () => {
    const off: unknown[] = [
      null,
      undefined,
      {},
      [],
      "nope",
      42,
      { "time.weekly_reminder": {} },
      { "time.weekly_reminder": { email: false } },
      // A truthy value that is not `true` — a JSON column can hold this
      // and "1" must not be read as consent.
      { "time.weekly_reminder": { email: "1" } },
      { "time.weekly_reminder": { inApp: true } },
      { "some.other_kind": { email: true } },
    ];
    for (const perKind of off) {
      expect(selectOptIns([row({ perKind })]), JSON.stringify(perKind) ?? "undefined").toEqual([]);
    }
  });

  it("emailLevel NONE outranks the opt-in — no mail means no mail", () => {
    expect(selectOptIns([row({ emailLevel: "NONE" })])).toEqual([]);
    for (const level of ["ALL", "PARTICIPATING", "MENTIONS"]) {
      expect(selectOptIns([row({ emailLevel: level })]).length, level).toBe(1);
    }
  });

  it("an emailLevel this build does not recognise is treated as consent, not as silence", () => {
    // A value outside the enum can only come from a newer deploy. The
    // safe reading is the one that does NOT silently drop a member's
    // explicit opt-in; only a literal NONE stops the mail.
    expect(selectOptIns([row({ emailLevel: "SOMETHING_NEW" })]).length).toBe(1);
  });

  it("keeps rows apart by tenant and member", () => {
    const rows = [row(), row({ tenantId: "t2", receiverId: "m2" }), row({ perKind: {} })];
    expect(selectOptIns(rows)).toEqual([
      { tenantId: "t1", memberId: "m1" },
      { tenantId: "t2", memberId: "m2" },
    ]);
  });
});

describe("dueAt", () => {
  const ZONE = "Europe/Stockholm";

  it("Monday 08:00 local, for a `now` in the middle of that week", () => {
    // 2026-10-07 is a Wednesday.
    const due = dueAt(new Date("2026-10-07T12:00:00Z"), ZONE, 1, 8);
    expect(due).not.toBeNull();
    // 08:00 in Stockholm on Monday 5 October (CEST, UTC+2) = 06:00 UTC.
    expect(due!.at.toISOString()).toBe("2026-10-05T06:00:00.000Z");
    expect([due!.isoYear, due!.isoWeek]).toEqual([2026, 41]);
  });

  it("the same instant is a different week for two members in different zones", () => {
    // Sunday 23:30 UTC: already Monday lunchtime in Auckland (+13),
    // still Sunday afternoon in Los Angeles (-7). Lisbon would NOT do —
    // at +1 it has already tipped into Monday too.
    const instant = new Date("2026-10-11T23:30:00Z");
    const nz = dueAt(instant, "Pacific/Auckland", 1, 8)!;
    const la = dueAt(instant, "America/Los_Angeles", 1, 8)!;
    expect(nz.isoWeek).toBe(42);
    expect(la.isoWeek).toBe(41);
    // And that is the point: each is reminded on THEIR Monday.
    expect(nz.at.getTime()).toBeGreaterThan(la.at.getTime());
  });

  it("a due moment still ahead of `now` is what stops an early send", () => {
    // Monday 05:00 UTC = 07:00 Stockholm, an hour before the 08:00 slot.
    const now = new Date("2026-10-05T05:00:00Z");
    const due = dueAt(now, ZONE, 1, 8)!;
    expect(now.getTime()).toBeLessThan(due.at.getTime());
  });

  it("a run later in the week still resolves to that week's slot, so a missed cron is not a missed week", () => {
    const friday = dueAt(new Date("2026-10-09T12:00:00Z"), ZONE, 1, 8)!;
    const monday = dueAt(new Date("2026-10-05T12:00:00Z"), ZONE, 1, 8)!;
    expect(friday.at.toISOString()).toBe(monday.at.toISOString());
    expect(friday.isoWeek).toBe(monday.isoWeek);
  });

  it("honours a weekday and hour other than the defaults", () => {
    const due = dueAt(new Date("2026-10-07T12:00:00Z"), ZONE, 5, 17)!;
    // Friday 9 October, 17:00 CEST = 15:00 UTC.
    expect(due.at.toISOString()).toBe("2026-10-09T15:00:00.000Z");
  });

  it("refuses a weekday or hour outside its range rather than guessing", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    for (const weekday of [0, 8, -1, 1.5, Number.NaN]) {
      expect(dueAt(now, ZONE, weekday, 8), String(weekday)).toBeNull();
    }
    for (const hour of [-1, 24, 8.5, Number.NaN]) {
      expect(dueAt(now, ZONE, 1, hour), String(hour)).toBeNull();
    }
  });

  it("crosses a year boundary into the right ISO week", () => {
    // 1 January 2027 is a Friday, in ISO week 53 of 2026.
    const due = dueAt(new Date("2027-01-01T12:00:00Z"), ZONE, 1, 8)!;
    expect([due.isoYear, due.isoWeek]).toEqual([2026, 53]);
    // Monday of that week is 28 December 2026, 08:00 CET (UTC+1).
    expect(due.at.toISOString()).toBe("2026-12-28T07:00:00.000Z");
  });
});
