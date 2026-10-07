import { describe, expect, it } from "vitest";

import { NOTIFICATION_KINDS, type NotificationKind } from "./catalog";
import {
  MEMBER_DIGEST_MAIL,
  SUMMARY_LINES,
  digestPeriod,
  DIGEST_CATCH_UP_HOURS,
  digestSince,
  insideCatchUp,
  memberDigestKey,
  periodDueNow,
  renderMemberDigest,
  summarisedKinds,
} from "./digest";
import { isEmailTemplate, renderEmail } from "./templates";

/**
 * THE TEAM'S SUMMARY EMAIL, its pure half (Phase 5 slice 100; founder
 * decision C68 (b), (e)): when one is due, what it counts, what it says.
 */

const LINKS = { inbox: "https://app.example/inbox", settings: "https://app.example/settings/notifications" };

describe("digestPeriod", () => {
  it("DAILY: due at the hour of the member's LOCAL day, keyed by that date", () => {
    // 05:30 UTC on 7 Oct = 07:30 in Stockholm (CEST, +2): not yet 08:00.
    const before = digestPeriod(new Date("2026-10-07T05:30:00Z"), "Europe/Stockholm", "DAILY", 8, 1);
    expect(before).not.toBeNull();
    expect(before!.at.toISOString()).toBe("2026-10-07T06:00:00.000Z");
    expect(before!.periodKey).toBe("2026-10-07");
    // 23:30 UTC on 7 Oct is already 8 Oct in Stockholm: the next period.
    const late = digestPeriod(new Date("2026-10-07T23:30:00Z"), "Europe/Stockholm", "DAILY", 8, 1);
    expect(late!.periodKey).toBe("2026-10-08");
    expect(late!.at.toISOString()).toBe("2026-10-08T06:00:00.000Z");
  });

  it("DAILY: a zone across the date line disagrees with UTC about the day, and the zone wins", () => {
    const p = digestPeriod(new Date("2026-10-07T20:00:00Z"), "Pacific/Auckland", "DAILY", 8, 1);
    // 20:00 UTC on 7 Oct is 09:00 on 8 Oct in Auckland (NZDT, +13).
    expect(p!.periodKey).toBe("2026-10-08");
    expect(p!.at.toISOString()).toBe("2026-10-07T19:00:00.000Z");
  });

  it("DAILY: the hour is local across a DST change (Stockholm, last Sunday of October)", () => {
    // 25 Oct 2026: CEST → CET at 03:00. 08:00 local that day is 07:00 UTC.
    const p = digestPeriod(new Date("2026-10-25T12:00:00Z"), "Europe/Stockholm", "DAILY", 8, 1);
    expect(p!.at.toISOString()).toBe("2026-10-25T07:00:00.000Z");
  });

  it("WEEKLY: due on the weekday of the member's ISO week, keyed by the week", () => {
    // Wednesday 7 Oct 2026, ISO week 41. Friday 16:00 Stockholm.
    const p = digestPeriod(new Date("2026-10-07T10:00:00Z"), "Europe/Stockholm", "WEEKLY", 16, 5);
    expect(p!.periodKey).toBe("2026-W41");
    expect(p!.at.toISOString()).toBe("2026-10-09T14:00:00.000Z");
  });

  it("NONE, and an hour or weekday this build never writes, give no period", () => {
    const now = new Date("2026-10-07T10:00:00Z");
    expect(digestPeriod(now, "UTC", "NONE", 8, 1)).toBeNull();
    expect(digestPeriod(now, "UTC", "DAILY", 24, 1)).toBeNull();
    expect(digestPeriod(now, "UTC", "DAILY", -1, 1)).toBeNull();
    expect(digestPeriod(now, "UTC", "DAILY", 8.5, 1)).toBeNull();
    expect(digestPeriod(now, "UTC", "WEEKLY", 8, 0)).toBeNull();
    expect(digestPeriod(now, "UTC", "WEEKLY", 8, 8)).toBeNull();
  });

  it("knows the previous period's time — where a first summary starts counting", () => {
    const daily = digestPeriod(new Date("2026-10-07T10:00:00Z"), "Europe/Stockholm", "DAILY", 8, 1);
    expect(daily!.previousAt.toISOString()).toBe("2026-10-06T06:00:00.000Z");
    // Across the October clock change the previous day's 08:00 is still 08:00 on the wall.
    const afterChange = digestPeriod(new Date("2026-10-26T10:00:00Z"), "Europe/Stockholm", "DAILY", 8, 1);
    expect(afterChange!.at.toISOString()).toBe("2026-10-26T07:00:00.000Z");
    expect(afterChange!.previousAt.toISOString()).toBe("2026-10-25T07:00:00.000Z");
    const weekly = digestPeriod(new Date("2026-10-07T10:00:00Z"), "Europe/Stockholm", "WEEKLY", 16, 5);
    expect(weekly!.previousAt.toISOString()).toBe("2026-10-02T14:00:00.000Z");
  });

  it("weekly: last week's time stays a week back at the ISO week's edge in a clock-change week", () => {
    // Sunday 25 Oct 2026, 23:00 CET (the fall-back day) = 22:00 UTC; a week
    // earlier is Sunday 18 Oct, 23:00 CEST = 21:00 UTC — not this week's own time.
    const fallBack = digestPeriod(new Date("2026-10-25T22:30:00Z"), "Europe/Stockholm", "WEEKLY", 23, 7);
    expect(fallBack!.at.toISOString()).toBe("2026-10-25T22:00:00.000Z");
    expect(fallBack!.previousAt.toISOString()).toBe("2026-10-18T21:00:00.000Z");
    // Monday 30 Mar 2026, 00:00 CEST (the week after spring forward) = 29 Mar 22:00 UTC;
    // a week earlier is Monday 23 Mar, 00:00 CET = 22 Mar 23:00 UTC — one week, not two.
    const spring = digestPeriod(new Date("2026-03-29T22:30:00Z"), "Europe/Stockholm", "WEEKLY", 0, 1);
    expect(spring!.at.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(spring!.previousAt.toISOString()).toBe("2026-03-22T23:00:00.000Z");
  });

  it("the outbox key is the member and the period", () => {
    expect(memberDigestKey("m-1", "2026-10-07")).toBe("digest:member:m-1:2026-10-07");
  });
});

describe("periodDueNow", () => {
  it("finds a late summary's period after local midnight (a 23:00 one is due until 02:00)", () => {
    // 00:30 in Stockholm on 8 Oct is 22:30 UTC on 7 Oct; the 23:00 summary was 21:00 UTC.
    const p = periodDueNow(new Date("2026-10-07T22:30:00Z"), "Europe/Stockholm", "DAILY", 23, 1);
    expect(p?.periodKey).toBe("2026-10-07");
    expect(p?.at.toISOString()).toBe("2026-10-07T21:00:00.000Z");
  });

  it("finds a Sunday-evening weekly summary's week after the ISO week has turned", () => {
    // Monday 12 Oct 00:30 Stockholm; the Sunday 23:00 summary belongs to W41.
    const p = periodDueNow(new Date("2026-10-11T22:30:00Z"), "Europe/Stockholm", "WEEKLY", 23, 7);
    expect(p?.periodKey).toBe("2026-W41");
  });

  it("is null outside every period's hours, and picks today's inside them", () => {
    expect(periodDueNow(new Date("2026-10-07T12:00:00Z"), "Europe/Stockholm", "DAILY", 8, 1)).toBeNull();
    expect(periodDueNow(new Date("2026-10-07T07:00:00Z"), "Europe/Stockholm", "DAILY", 8, 1)?.periodKey).toBe(
      "2026-10-07",
    );
    expect(periodDueNow(new Date("2026-10-07T07:00:00Z"), "Europe/Stockholm", "NONE", 8, 1)).toBeNull();
  });
});

describe("when a summary may go, and where it counts from", () => {
  const at = new Date("2026-10-07T06:00:00.000Z");

  it("goes only in the hours just after its time — a missed morning never becomes an afternoon mail", () => {
    expect(insideCatchUp(new Date(at.getTime() - 1), at)).toBe(false);
    expect(insideCatchUp(at, at)).toBe(true);
    expect(insideCatchUp(new Date(at.getTime() + 2 * 3_600_000), at)).toBe(true);
    expect(insideCatchUp(new Date(at.getTime() + DIGEST_CATCH_UP_HOURS * 3_600_000), at)).toBe(false);
    expect(insideCatchUp(new Date("2026-10-07T13:00:00Z"), at)).toBe(false);
  });

  it("counts from the last summary, or — for a first one, or after a long gap — from a minute before the previous period's time", () => {
    const previousAt = new Date("2026-10-06T06:00:00.000Z");
    const minuteBefore = new Date("2026-10-06T05:59:00.000Z");
    const yesterdays = new Date("2026-10-06T06:00:01.000Z");
    expect(digestSince(yesterdays, previousAt, "DAILY")).toEqual(yesterdays);
    // Yesterday's made 10 s after its hour is stamped 50 s before it — still the chain.
    const madeJustAfter = new Date("2026-10-06T05:59:10.000Z");
    expect(digestSince(madeJustAfter, previousAt, "DAILY")).toEqual(madeJustAfter);
    // A missed morning, or an hour moved later: the day-before's still chains.
    const dayBefore = new Date("2026-10-05T05:59:10.000Z");
    expect(digestSince(dayBefore, previousAt, "DAILY")).toEqual(dayBefore);
    // A first one starts a settling minute before the previous period's time.
    expect(digestSince(null, previousAt, "DAILY")).toEqual(minuteBefore);
    // A summary from a month ago (summaries off since) counts one period, not a month.
    expect(digestSince(new Date("2026-09-06T06:00:00Z"), previousAt, "DAILY")).toEqual(minuteBefore);
    // Weekly reaches a week further.
    const lastWeekButOne = new Date("2026-09-29T05:59:10.000Z");
    expect(digestSince(lastWeekButOne, previousAt, "WEEKLY")).toEqual(lastWeekButOne);
    expect(digestSince(lastWeekButOne, previousAt, "DAILY")).toEqual(minuteBefore);
  });
});

describe("what a summary counts", () => {
  it("has a decision for EVERY kind — a line or an explicit null", () => {
    for (const kind of Object.keys(NOTIFICATION_KINDS) as NotificationKind[]) {
      expect(Object.hasOwn(SUMMARY_LINES, kind)).toBe(true);
    }
    expect(Object.keys(SUMMARY_LINES).sort()).toEqual(Object.keys(NOTIFICATION_KINDS).sort());
  });

  it("counts EVERY kind — what was already mailed at once included (C68 (h): an overview)", () => {
    expect(summarisedKinds()).toEqual(Object.keys(NOTIFICATION_KINDS));
    // The instantly-mailed kinds are in it, not left out.
    expect(summarisedKinds()).toContain("work_item.assigned");
    expect(summarisedKinds()).toContain("work_item.request_received");
    expect(summarisedKinds()).toContain("contact.logins_alarm");
  });
});

describe("renderMemberDigest", () => {
  it("says how many, per kind, in catalog order, and links to the inbox and the settings", () => {
    const mail = renderMemberDigest(
      "en",
      { "budget.threshold_reached": 1, "work_item.commented": 3 },
      LINKS,
    );
    expect(mail).not.toBeNull();
    expect(mail!.subject).toBe("Fortleva: 4 new updates in your inbox");
    const lines = mail!.text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toEqual(["- 3 tasks you follow have new comments", "- 1 project budget reached a threshold"]);
    expect(mail!.text).toContain(LINKS.inbox);
    expect(mail!.text).toContain(LINKS.settings);
  });

  it("speaks Swedish, with Swedish plurals", () => {
    const mail = renderMemberDigest("sv", { "work_item.commented": 1, "expiration.asset_due": 2 }, LINKS);
    expect(mail!.subject).toBe("Fortleva: 3 nya uppdateringar i din inkorg");
    expect(mail!.text).toContain("- 1 uppgift du följer har nya kommentarer");
    expect(mail!.text).toContain("- 2 förnyelser närmar sig");
    const one = renderMemberDigest("sv", { "work_item.commented": 1 }, LINKS);
    expect(one!.subject).toBe("Fortleva: 1 ny uppdatering i din inkorg");
  });

  it("folds a kind it does not know (or does not count) into 'other', and ignores anything that is not a positive whole number", () => {
    const mail = renderMemberDigest(
      "en",
      {
        "work_item.commented": 2,
        "some.future_kind": 4,
        "another.unknown_kind": 1,
        constructor: 9.5,
        "budget.threshold_reached": -1,
        "expiration.asset_due": "3",
      },
      LINKS,
    );
    expect(mail!.text).toContain("- 2 tasks you follow have new comments");
    expect(mail!.text).toContain("- 5 other updates");
    expect(mail!.text).not.toContain("budget");
    expect(mail!.text).not.toContain("renewal");
    expect(mail!.subject).toBe("Fortleva: 7 new updates in your inbox");
  });

  it("is null when nothing is left to count — the outbox skips it", () => {
    expect(renderMemberDigest("en", {}, LINKS)).toBeNull();
    expect(renderMemberDigest("en", null, LINKS)).toBeNull();
    expect(renderMemberDigest("en", [3], LINKS)).toBeNull();
    expect(renderMemberDigest("en", { "work_item.commented": 0 }, LINKS)).toBeNull();
  });

  it("names nothing: every line is fixed copy around a number", () => {
    for (const lang of ["en", "sv"] as const) {
      for (const [kind, line] of Object.entries(SUMMARY_LINES)) {
        if (!line) continue;
        for (const n of [1, 7]) {
          const text = line[lang](n);
          expect(text, `${kind} ${lang} ${n}`).toMatch(/\S/);
          expect(text.replace(String(n), "#")).not.toMatch(/\d/);
        }
      }
    }
  });
});

describe("the summary's template", () => {
  it("is a known template, rendered from counts with the inbox link", () => {
    expect(isEmailTemplate(MEMBER_DIGEST_MAIL)).toBe(true);
    const mail = renderEmail(MEMBER_DIGEST_MAIL, "en", { counts: { "work_item.commented": 2 } });
    expect(mail.subject).toBe("Fortleva: 2 new updates in your inbox");
    expect(mail.text).toMatch(/\/inbox/);
    expect(mail.text).toMatch(/\/settings\/notifications/);
  });

  it("falls back to its plain copy when the counts are empty", () => {
    const mail = renderEmail(MEMBER_DIGEST_MAIL, "sv", null);
    expect(mail.subject).toBe("Fortleva: nya uppdateringar i din inkorg");
    expect(new URL(mail.text.trim().split("\n").at(-1)!).pathname).toBe("/inbox");
  });
});
