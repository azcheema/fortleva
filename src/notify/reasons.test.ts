import { describe, expect, it } from "vitest";

import { staysInBucket } from "./inbox-buckets";
import { inboxGroupOf } from "./inbox-groups";
import { isNotificationReason, NOTIFICATION_REASONS, pickReason, reasonsFor } from "./reasons";

/**
 * The inbox's reason tags and day groups (Phase 5 slice 104, founder decision
 * C72 (c), (d)) — the pure halves.
 */

describe("why a notification reached someone", () => {
  it("is a closed set, in precedence order", () => {
    expect([...NOTIFICATION_REASONS]).toEqual([
      "ASSIGNEE",
      "REQUESTER",
      "PROJECT_LEAD",
      "PROJECT_MEMBER",
      "CLIENT_MEMBER",
      "BUDGET_WATCHER",
      "VAULT_ACCESS",
      "OWNER",
    ]);
    expect(isNotificationReason("OWNER")).toBe(true);
    for (const bad of ["owner", "MENTIONED", "", null, 3]) expect(isNotificationReason(bad), String(bad)).toBe(false);
  });

  it("the more specific reason wins, either way round", () => {
    expect(pickReason("OWNER", "CLIENT_MEMBER")).toBe("CLIENT_MEMBER");
    expect(pickReason("CLIENT_MEMBER", "OWNER")).toBe("CLIENT_MEMBER");
    expect(pickReason("PROJECT_MEMBER", "PROJECT_LEAD")).toBe("PROJECT_LEAD");
    expect(pickReason("ASSIGNEE", "ASSIGNEE")).toBe("ASSIGNEE");
  });

  it("tags each member once, with the most specific reason across groups", () => {
    const map = reasonsFor([
      ["OWNER", ["owner-1", "both"]],
      ["CLIENT_MEMBER", ["both", "client-only"]],
    ]);
    expect(Object.fromEntries(map)).toEqual({ "owner-1": "OWNER", both: "CLIENT_MEMBER", "client-only": "CLIENT_MEMBER" });
  });
});

describe("the inbox's day groups", () => {
  const STOCKHOLM = "Europe/Stockholm";
  // Wednesday 14 October 2026, 10:00 in Stockholm (CEST, UTC+2).
  const NOW = new Date("2026-10-14T08:00:00.000Z");
  const at = (iso: string) => new Date(iso);

  it("today, yesterday, this week, older — by the member's calendar day", () => {
    expect(inboxGroupOf(at("2026-10-14T06:00:00.000Z"), NOW, STOCKHOLM, "MONDAY")).toBe("today");
    // 23:30 UTC on the 13th is 01:30 on the 14th in Stockholm: today, not yesterday.
    expect(inboxGroupOf(at("2026-10-13T23:30:00.000Z"), NOW, STOCKHOLM, "MONDAY")).toBe("today");
    expect(inboxGroupOf(at("2026-10-13T10:00:00.000Z"), NOW, STOCKHOLM, "MONDAY")).toBe("yesterday");
    // Monday the 12th: earlier this week.
    expect(inboxGroupOf(at("2026-10-12T10:00:00.000Z"), NOW, STOCKHOLM, "MONDAY")).toBe("week");
    // Sunday the 11th: last week — older.
    expect(inboxGroupOf(at("2026-10-11T10:00:00.000Z"), NOW, STOCKHOLM, "MONDAY")).toBe("older");
  });

  it("follows the workspace's week start", () => {
    // With weeks starting on Sunday, Sunday the 11th is this week.
    expect(inboxGroupOf(at("2026-10-11T10:00:00.000Z"), NOW, STOCKHOLM, "SUNDAY")).toBe("week");
    // With Saturday starts, Saturday the 10th is too.
    expect(inboxGroupOf(at("2026-10-10T10:00:00.000Z"), NOW, STOCKHOLM, "SATURDAY")).toBe("week");
  });

  it("on the first day of the week, yesterday is still yesterday and nothing else is this week", () => {
    const monday = new Date("2026-10-12T08:00:00.000Z");
    expect(inboxGroupOf(at("2026-10-11T10:00:00.000Z"), monday, STOCKHOLM, "MONDAY")).toBe("yesterday");
    expect(inboxGroupOf(at("2026-10-10T10:00:00.000Z"), monday, STOCKHOLM, "MONDAY")).toBe("older");
  });

  it("holds across the autumn clock change (25 October 2026 in Stockholm)", () => {
    const monday = new Date("2026-10-26T08:00:00.000Z"); // 09:00 CET
    // 22:30 UTC on Saturday the 24th is 00:30 on Sunday the 25th, CEST.
    expect(inboxGroupOf(at("2026-10-24T22:30:00.000Z"), monday, STOCKHOLM, "MONDAY")).toBe("yesterday");
    // 23:30 UTC on Sunday the 25th is 00:30 on Monday the 26th, CET.
    expect(inboxGroupOf(at("2026-10-25T23:30:00.000Z"), monday, STOCKHOLM, "MONDAY")).toBe("today");
  });

  it("a stamp a moment ahead of the clock is today, never a future group", () => {
    expect(inboxGroupOf(at("2026-10-14T08:00:05.000Z"), NOW, STOCKHOLM, "MONDAY")).toBe("today");
  });
});

describe("which tab a row still belongs in — the server's filters, mirrored", () => {
  const NOW = Date.parse("2026-10-14T08:00:00.000Z");
  const later = "2026-10-15T07:00:00.000Z";
  const earlier = "2026-10-13T07:00:00.000Z";
  const row = (over: Partial<{ read: boolean; archived: boolean; snoozedTill: string | null }> = {}) => ({
    read: false,
    archived: false,
    snoozedTill: null,
    ...over,
  });

  it("unread: not read, not archived, not snoozed ahead (an expired snooze is back)", () => {
    expect(staysInBucket("unread", row(), NOW)).toBe(true);
    expect(staysInBucket("unread", row({ read: true }), NOW)).toBe(false);
    expect(staysInBucket("unread", row({ archived: true }), NOW)).toBe(false);
    expect(staysInBucket("unread", row({ snoozedTill: later }), NOW)).toBe(false);
    expect(staysInBucket("unread", row({ snoozedTill: earlier }), NOW)).toBe(true);
  });

  it("all: everything not archived — a snoozed row STAYS", () => {
    expect(staysInBucket("all", row({ read: true, snoozedTill: later }), NOW)).toBe(true);
    expect(staysInBucket("all", row({ archived: true }), NOW)).toBe(false);
  });

  it("snoozed: only a snooze still ahead — waking it takes it out", () => {
    expect(staysInBucket("snoozed", row({ snoozedTill: later }), NOW)).toBe(true);
    expect(staysInBucket("snoozed", row({ snoozedTill: null }), NOW)).toBe(false);
    expect(staysInBucket("snoozed", row({ snoozedTill: earlier }), NOW)).toBe(false);
    expect(staysInBucket("snoozed", row({ snoozedTill: later, archived: true }), NOW)).toBe(false);
  });

  it("archived: only archived — restoring takes it out", () => {
    expect(staysInBucket("archived", row({ archived: true }), NOW)).toBe(true);
    expect(staysInBucket("archived", row(), NOW)).toBe(false);
  });
});
