import { describe, expect, it } from "vitest";

import { NO_QUIET_HOURS } from "@/notify/quiet-hours";

import { PUSH_DROPPED, pushTtlSeconds, pushVerdict, type PushReceiver } from "./verdict";

const NOW = new Date("2026-10-08T10:00:00Z"); // a Thursday, 12:00 in Stockholm
const unseen = {
  kind: "comment.mentioned" as const,
  createdAt: new Date(NOW.getTime() - 30_000),
  readAt: null,
  archivedAt: null,
  snoozedTill: null,
};
const receiver: PushReceiver = {
  memberStatus: "ACTIVE",
  tenantStatus: "ACTIVE",
  pushLevel: "PARTICIPATING",
  quiet: NO_QUIET_HOURS,
  zone: "Europe/Stockholm",
};

describe("pushVerdict", () => {
  it("sends an unseen notification to an active member whose phone level lets it through", () => {
    expect(pushVerdict(unseen, receiver, NOW)).toEqual({ action: "send" });
  });

  it("drops it when the member, their workspace or their PHONE level says no", () => {
    expect(pushVerdict(unseen, undefined, NOW)).toEqual({ action: "drop", why: PUSH_DROPPED.unwanted });
    expect(pushVerdict(unseen, { ...receiver, memberStatus: "SUSPENDED" }, NOW).action).toBe("drop");
    expect(pushVerdict(unseen, { ...receiver, tenantStatus: "SUSPENDED" }, NOW).action).toBe("drop");
    expect(pushVerdict(unseen, { ...receiver, pushLevel: "NONE" }, NOW).action).toBe("drop");
    // The ladder: a mention reaches MENTIONS; an assignment does not.
    expect(pushVerdict(unseen, { ...receiver, pushLevel: "MENTIONS" }, NOW).action).toBe("send");
    expect(pushVerdict({ ...unseen, kind: "work_item.assigned" }, { ...receiver, pushLevel: "MENTIONS" }, NOW).action).toBe("drop");
  });

  it("buzzes owners about the logins alarm at any phone level but Nothing (C74 (i))", () => {
    const alarm = { ...unseen, kind: "contact.logins_alarm" as const };
    for (const pushLevel of ["ALL", "PARTICIPATING", "MENTIONS"] as const) {
      expect(pushVerdict(alarm, { ...receiver, pushLevel }, NOW).action, pushLevel).toBe("send");
    }
    expect(pushVerdict(alarm, { ...receiver, pushLevel: "NONE" }, NOW).action).toBe("drop");
  });

  it("never pushes a kind that pushes nowhere, whatever the level", () => {
    expect(pushVerdict({ ...unseen, kind: "work_item.commented" }, { ...receiver, pushLevel: "ALL" }, NOW).action).toBe("drop");
  });

  it("drops it inside the member's quiet hours, on THEIR clock — never held for later (C74 (c))", () => {
    // 12:00 in Stockholm is inside 11–13 there, and outside it in New York (06:00).
    const quiet = { from: 11, to: 13, weekends: false };
    expect(pushVerdict(unseen, { ...receiver, quiet }, NOW)).toEqual({ action: "drop", why: PUSH_DROPPED.quiet });
    expect(pushVerdict(unseen, { ...receiver, quiet, zone: "America/New_York" }, NOW)).toEqual({ action: "send" });
    // The weekend tick: Saturday noon in Stockholm.
    const saturday = new Date("2026-10-10T10:00:00Z");
    expect(pushVerdict({ ...unseen, createdAt: saturday }, { ...receiver, quiet: { from: null, to: null, weekends: true } }, saturday).action).toBe(
      "drop",
    );
  });

  it("drops what was MADE inside quiet hours even when the drain reaches it after they ended (the design review's M5)", () => {
    // Quiet 11–12 in Stockholm; made at 11:59, reached at 12:00.
    const quiet = { from: 11, to: 12, weekends: false };
    const madeAt = new Date("2026-10-08T09:59:00Z");
    expect(pushVerdict({ ...unseen, createdAt: madeAt }, { ...receiver, quiet }, NOW)).toEqual({ action: "drop", why: PUSH_DROPPED.quiet });
    // Made at 12:00 exactly, out of it: sent.
    expect(pushVerdict({ ...unseen, createdAt: NOW }, { ...receiver, quiet }, NOW).action).toBe("send");
  });

  it("drops what was already read, archived or snoozed in the inbox", () => {
    expect(pushVerdict({ ...unseen, readAt: NOW }, receiver, NOW)).toEqual({ action: "drop", why: PUSH_DROPPED.seen });
    expect(pushVerdict({ ...unseen, archivedAt: NOW }, receiver, NOW).action).toBe("drop");
    expect(pushVerdict({ ...unseen, snoozedTill: new Date(NOW.getTime() + 60_000) }, receiver, NOW).action).toBe("drop");
    // A snooze that already ran out is unseen again.
    expect(pushVerdict({ ...unseen, snoozedTill: new Date(NOW.getTime() - 60_000) }, receiver, NOW).action).toBe("send");
  });
});

describe("pushTtlSeconds — never into quiet time, never past the window, never minute-exact about quiet hours", () => {
  const windowEnds = new Date(NOW.getTime() + 15 * 60_000);
  const quietAtNoon = { ...receiver, quiet: { from: 12, to: 13, weekends: false } };

  it("is the window's remainder when no quiet time comes first", () => {
    expect(pushTtlSeconds(windowEnds, receiver, NOW)).toBe(900);
    expect(pushTtlSeconds(new Date(NOW.getTime() + 61_500), receiver, NOW)).toBe(61);
    expect(pushTtlSeconds(new Date(NOW.getTime() - 1_000), receiver, NOW)).toBe(0);
  });

  it("ends before the member's quiet time begins, rounded DOWN to five minutes", () => {
    // 11:48 in Stockholm, quiet from 12:00: twelve minutes are safe → ten.
    const at = new Date("2026-10-08T09:48:00Z");
    const ttl = pushTtlSeconds(new Date(at.getTime() + 15 * 60_000), quietAtNoon, at);
    expect(ttl).toBe(10 * 60);
    expect(at.getTime() + ttl * 1000).toBeLessThanOrEqual(new Date("2026-10-08T10:00:00Z").getTime());
  });

  it("sees a quiet start inside the window's last partial minute (the code review's nit)", () => {
    // 11:57:40 Stockholm; the window ends at 12:00:10 — quiet from 12:00.
    const at = new Date("2026-10-08T09:57:40Z");
    const ttl = pushTtlSeconds(new Date(at.getTime() + 150_000), quietAtNoon, at);
    expect(at.getTime() + ttl * 1000).toBeLessThanOrEqual(new Date("2026-10-08T10:00:00Z").getTime());
    expect(ttl).toBe(0);
  });

  it("is zero when quiet time starts within five minutes", () => {
    const at = new Date("2026-10-08T09:56:30Z"); // 11:56:30 Stockholm
    expect(pushTtlSeconds(new Date(at.getTime() + 15 * 60_000), quietAtNoon, at)).toBe(0);
  });
});
