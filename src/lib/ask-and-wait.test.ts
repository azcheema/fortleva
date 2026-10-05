import { describe, expect, it } from "vitest";

import {
  askWaitState,
  DAY_MS,
  HOUR_MS,
  isAnswerable,
  isLive,
  reminderOffsetDays,
  remindersDue,
  scheduledByApproval,
  scheduledByConfirmation,
  type AskWaitRules,
  type AskWaitStamps,
} from "./ask-and-wait";

const RULES: AskWaitRules = { noticeHours: 48, openDays: 7, confirmDays: 30, cooldownDays: 30 };
const T0 = new Date("2026-10-05T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const asked = (over: Partial<AskWaitStamps> = {}): AskWaitStamps => ({
  askedAt: T0,
  waitDays: 7,
  confirmedAt: null,
  approvedAt: null,
  deniedAt: null,
  withdrawnAt: null,
  opensAt: null,
  openUntil: null,
  ...over,
});

describe("askWaitState", () => {
  it("waits for the whole wait, then may be confirmed, then lapses", () => {
    expect(askWaitState(asked(), RULES, T0).kind).toBe("waiting");
    expect(askWaitState(asked(), RULES, at(7 * DAY_MS - 1)).kind).toBe("waiting");
    const ready = askWaitState(asked(), RULES, at(7 * DAY_MS));
    expect(ready).toEqual({ kind: "confirmable", confirmableAt: at(7 * DAY_MS), lapsesAt: at(37 * DAY_MS) });
    expect(askWaitState(asked(), RULES, at(37 * DAY_MS - 1)).kind).toBe("confirmable");
    expect(askWaitState(asked(), RULES, at(37 * DAY_MS))).toEqual({ kind: "lapsed", lapsedAt: at(37 * DAY_MS) });
  });

  it("measures the wait from the frozen days on the ask, not the rules", () => {
    const long = asked({ waitDays: 21 });
    expect(askWaitState(long, RULES, at(20 * DAY_MS)).kind).toBe("waiting");
    expect(askWaitState(long, RULES, at(21 * DAY_MS)).kind).toBe("confirmable");
    expect(askWaitState(long, RULES, at(51 * DAY_MS)).kind).toBe("lapsed");
  });

  it("a confirmation opens after the notice, for the open days, then closes", () => {
    const confirmedAt = at(8 * DAY_MS);
    const { opensAt, openUntil } = scheduledByConfirmation(confirmedAt, RULES);
    expect(opensAt).toEqual(at(8 * DAY_MS + 48 * HOUR_MS));
    expect(openUntil).toEqual(at(8 * DAY_MS + 48 * HOUR_MS + 7 * DAY_MS));
    const row = asked({ confirmedAt, opensAt, openUntil });
    expect(askWaitState(row, RULES, at(9 * DAY_MS))).toEqual({ kind: "opening", opensAt });
    expect(askWaitState(row, RULES, opensAt)).toEqual({ kind: "open", openedAt: opensAt, openUntil });
    expect(askWaitState(row, RULES, openUntil)).toEqual({ kind: "closed", openedAt: opensAt, closedAt: openUntil });
  });

  it("an approval opens at once — and a confirmed ask may still be approved", () => {
    const approvedAt = at(2 * DAY_MS);
    const s = scheduledByApproval(approvedAt, RULES);
    expect(s).toEqual({ opensAt: approvedAt, openUntil: at(9 * DAY_MS) });
    const row = asked({ approvedAt, ...s });
    expect(askWaitState(row, RULES, approvedAt).kind).toBe("open");
    expect(askWaitState(row, RULES, at(9 * DAY_MS)).kind).toBe("closed");
  });

  it("a denial or a withdrawal ends it, whatever else the row says", () => {
    const deniedAt = at(DAY_MS);
    expect(askWaitState(asked({ deniedAt }), RULES, at(50 * DAY_MS))).toEqual({
      kind: "denied",
      deniedAt,
      askAgainAt: at(31 * DAY_MS),
    });
    const withdrawnAt = at(3 * DAY_MS);
    expect(askWaitState(asked({ withdrawnAt }), RULES, at(4 * DAY_MS))).toEqual({ kind: "withdrawn", withdrawnAt });
  });

  it("live and answerable are the states the database treats so", () => {
    expect(["waiting", "confirmable", "opening", "open"].every((k) => isLive(k as never))).toBe(true);
    expect(["closed", "denied", "withdrawn", "lapsed"].some((k) => isLive(k as never))).toBe(false);
    expect(["waiting", "confirmable", "opening"].every((k) => isAnswerable(k as never))).toBe(true);
    // C61 (c): until the moment it opens, and not after.
    expect(["open", "closed", "denied", "withdrawn", "lapsed"].some((k) => isAnswerable(k as never))).toBe(false);
  });
});

describe("the reminder cadence (C52 (f): day 0, 3, 6, then daily)", () => {
  it("names the day of each mail", () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(reminderOffsetDays)).toEqual([0, 3, 6, 7, 8, 9, 14]);
    expect(() => reminderOffsetDays(-1)).toThrow(RangeError);
    expect(() => reminderOffsetDays(1.5)).toThrow(RangeError);
  });

  it("counts the mails due by now, and agrees with the offsets at every day", () => {
    for (let day = 0; day <= 40; day++) {
      for (const within of [0, DAY_MS - 1]) {
        const now = at(day * DAY_MS + within);
        let expected = 0;
        while (reminderOffsetDays(expected) <= day) expected++;
        expect(remindersDue(T0, now), `day ${day}`).toBe(expected);
      }
    }
    expect(remindersDue(T0, at(-1))).toBe(0);
  });
});
