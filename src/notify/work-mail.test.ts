import { describe, expect, it } from "vitest";

import { NO_QUIET_HOURS, summaryInQuietTime, type QuietHours } from "./quiet-hours";
import { isSeen, isWorkMail, reminderOvertaken, WORK_MAIL_SKIPPED, workMailVerdict, type WorkMailReceiver } from "./work-mail";

/**
 * What the outbox drain decides about a work email at send (slice 105, C73):
 * still wanted, quiet now, seen while held, overtaken. Pure — the drain reads
 * once per claim and asks this per row.
 */

const STHLM = "Europe/Stockholm";
const nights: QuietHours = { from: 19, to: 7, weekends: false };
const receiver = (over: Partial<WorkMailReceiver> = {}): WorkMailReceiver => ({
  memberStatus: "ACTIVE",
  tenantStatus: "ACTIVE",
  emailLevel: "PARTICIPATING",
  quiet: NO_QUIET_HOURS,
  zone: STHLM,
  email: "pat@example.test",
  ...over,
});
const row = (over: Partial<Parameters<typeof workMailVerdict>[0]> = {}): Parameters<typeof workMailVerdict>[0] => ({
  kind: "work_item.assigned",
  toEmail: "pat@example.test",
  quietHeld: false,
  notificationCount: 1,
  unseenCount: 1,
  overtaken: false,
  ...over,
});
// Wednesday 2026-10-07, 12:00 and 21:00 in Stockholm (summer time).
const noon = new Date("2026-10-07T10:00:00Z");
const evening = new Date("2026-10-07T19:00:00Z");

describe("isWorkMail", () => {
  it("is a catalog kind that emails — never a security notice, a summary or a code", () => {
    expect(isWorkMail("work_item.assigned")).toBe(true);
    expect(isWorkMail("project_update.due")).toBe(true);
    expect(isWorkMail("work_item.commented")).toBe(false); // coalesced: no mail of its own
    expect(isWorkMail("contact.logins_alarm")).toBe(false); // the owners' security notice goes under its own key
    expect(isWorkMail("digest.member")).toBe(false);
    expect(isWorkMail("constructor")).toBe(false);
  });
});

describe("workMailVerdict", () => {
  it("sends an ordinary work mail", () => {
    expect(workMailVerdict(row(), receiver(), noon)).toEqual({ action: "send" });
  });

  it("drops one no longer wanted: the member gone, the workspace not sending, the address changed, the level turned down since", () => {
    const unwanted = { action: "skip", why: WORK_MAIL_SKIPPED.unwanted };
    expect(workMailVerdict(row(), undefined, noon)).toEqual(unwanted);
    expect(workMailVerdict(row(), receiver({ memberStatus: "SUSPENDED" }), noon)).toEqual(unwanted);
    expect(workMailVerdict(row(), receiver({ tenantStatus: "SUSPENDED" }), noon)).toEqual(unwanted);
    // Held over a weekend, it goes only to the address it was made for (the security review's nit).
    expect(workMailVerdict(row(), receiver({ email: "pat@new.example.test" }), noon)).toEqual(unwanted);
    expect(workMailVerdict(row(), receiver({ emailLevel: "NONE" }), noon)).toEqual(unwanted);
    // MENTIONS still gets a mention, never an assignment.
    expect(workMailVerdict(row(), receiver({ emailLevel: "MENTIONS" }), noon)).toEqual(unwanted);
    expect(workMailVerdict(row({ kind: "comment.mentioned" }), receiver({ emailLevel: "MENTIONS" }), noon)).toEqual({ action: "send" });
  });

  it("holds one inside quiet hours until they end — before asking whether it was seen", () => {
    expect(workMailVerdict(row({ quietHeld: true, unseenCount: 0 }), receiver({ quiet: nights }), evening)).toEqual({
      action: "hold",
      until: new Date("2026-10-08T05:00:00Z"),
    });
  });

  it("C73 (e), (h): a HELD mail whose notifications were all seen is not sent; an unheld one is", () => {
    expect(workMailVerdict(row({ quietHeld: true, unseenCount: 0 }), receiver({ quiet: nights }), noon)).toEqual({
      action: "skip",
      why: WORK_MAIL_SKIPPED.seen,
    });
    expect(workMailVerdict(row({ quietHeld: true, unseenCount: 1 }), receiver({ quiet: nights }), noon)).toEqual({ action: "send" });
    expect(workMailVerdict(row({ quietHeld: false, unseenCount: 0 }), receiver(), noon)).toEqual({ action: "send" });
  });

  it("a held reminder a newer one or a post overtook is not sent", () => {
    expect(workMailVerdict(row({ kind: "project_update.due", quietHeld: true, overtaken: true }), receiver(), noon)).toEqual({
      action: "skip",
      why: WORK_MAIL_SKIPPED.overtaken,
    });
  });
});

describe("reminderOvertaken", () => {
  const madeAt = new Date("2026-10-07T07:00:00Z"); // Wed 09:00 Stockholm
  it("with no newer reminder and no post since, it still stands — whatever day it is now (the code review's L4)", () => {
    expect(reminderOvertaken(madeAt, null, false)).toBe(false);
    expect(reminderOvertaken(madeAt, new Date("2026-10-06T12:00:00Z"), false)).toBe(false);
  });
  it("a newer reminder, or a post that counts published after it, overtakes it", () => {
    expect(reminderOvertaken(madeAt, null, true)).toBe(true);
    expect(reminderOvertaken(madeAt, new Date("2026-10-07T08:00:00Z"), false)).toBe(true);
  });
});

describe("isSeen", () => {
  const unread = { readAt: null, archivedAt: null, snoozedTill: null };
  it("read, archived or snoozed for later is seen; snoozed into the past is not", () => {
    expect(isSeen(unread, noon)).toBe(false);
    expect(isSeen({ ...unread, readAt: noon }, noon)).toBe(true);
    expect(isSeen({ ...unread, archivedAt: noon }, noon)).toBe(true);
    expect(isSeen({ ...unread, snoozedTill: new Date(noon.getTime() + 60_000) }, noon)).toBe(true);
    expect(isSeen({ ...unread, snoozedTill: new Date(noon.getTime() - 60_000) }, noon)).toBe(false);
  });
});

describe("summaryInQuietTime", () => {
  it("names a summary whose hour is inside the window, or a weekly one on a quiet weekend", () => {
    expect(summaryInQuietTime(nights, "DAILY", 6, 1)).toBe(true);
    expect(summaryInQuietTime(nights, "DAILY", 8, 1)).toBe(false);
    expect(summaryInQuietTime(nights, "NONE", 6, 1)).toBe(false);
    expect(summaryInQuietTime({ ...NO_QUIET_HOURS, weekends: true }, "WEEKLY", 8, 7)).toBe(true);
    expect(summaryInQuietTime({ ...NO_QUIET_HOURS, weekends: true }, "WEEKLY", 8, 5)).toBe(false);
  });
});
