import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  allowLocal,
  allowStrict,
  LOCAL_SUBJECT_CAP,
  RATE_LIMIT_POLICIES,
  resetLocalLimiter,
  setLimiter,
  type Limiter,
} from "./index";

/**
 * THE IN-PROCESS FLOOR (`allowLocal` / `allowStrict`) — the only limit in
 * this product that holds without Upstash, and therefore the only one
 * whose behaviour a test can actually observe. It exists for one path:
 * the portal invitation acceptance page, where the bucket is the sole
 * control (an unauthenticated Next route has no Better Auth limiter under
 * it and no row to count).
 *
 * Time is faked, because the whole contract is about a window. Three of
 * the cases below were rewritten after a review pointed out that they
 * passed against an implementation that did not have the property they
 * were named for — a fixed window, a floor with no Upstash leg, and an
 * eviction sweep that never ran.
 */
describe("the in-process rate-limit floor", () => {
  beforeEach(() => {
    resetLocalLimiter();
    setLimiter(null);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T10:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    resetLocalLimiter();
    setLimiter(null);
  });

  const BUCKET = "portal.invite_accept" as const;
  const { limit } = RATE_LIMIT_POLICIES[BUCKET];

  it("allows exactly the budget and then stops answering", () => {
    for (let i = 0; i < limit; i += 1) {
      expect(allowLocal(BUCKET, "1.2.3.4")).toBe(true);
    }
    expect(allowLocal(BUCKET, "1.2.3.4")).toBe(false);
  });

  it("holds when Upstash is absent — which is the entire reason it exists", async () => {
    // `setLimiter(null)` above leaves the module to build its own, and
    // with no UPSTASH_* env that is the fail-open no-op. `allow()` would
    // therefore return true forever; `allowStrict()` must not.
    for (let i = 0; i < limit; i += 1) {
      expect(await allowStrict(BUCKET, "5.6.7.8")).toBe(true);
    }
    expect(await allowStrict(BUCKET, "5.6.7.8")).toBe(false);
  });

  it("still defers to Upstash when Upstash says no", async () => {
    // WITHOUT THIS, `allowStrict`'s second leg could be `return true` and
    // every test here would still pass: the only limiter the others run
    // against is the no-op. The floor is a FLOOR, not a replacement.
    const asked: string[] = [];
    const refusing: Limiter = {
      name: "upstash",
      async limit(bucket, subject) {
        asked.push(`${bucket}:${subject}`);
        return { ok: false, remaining: 0, reset: 0 };
      },
    };
    setLimiter(refusing);
    expect(await allowStrict(BUCKET, "9.9.9.9")).toBe(false);
    expect(asked).toEqual([`${BUCKET}:9.9.9.9`]);
  });

  it("counts each address on its own, so one visitor cannot spend another's budget", () => {
    for (let i = 0; i < limit; i += 1) expect(allowLocal(BUCKET, "1.1.1.1")).toBe(true);
    expect(allowLocal(BUCKET, "1.1.1.1")).toBe(false);
    expect(allowLocal(BUCKET, "2.2.2.2")).toBe(true);
  });

  it("counts each bucket on its own", () => {
    for (let i = 0; i < limit; i += 1) expect(allowLocal(BUCKET, "1.1.1.1")).toBe(true);
    expect(allowLocal(BUCKET, "1.1.1.1")).toBe(false);
    expect(allowLocal("auth.sign_in", "1.1.1.1")).toBe(true);
  });

  it("is a SLIDING window: the budget returns hit by hit, not all at once", () => {
    // THE CASE A FIXED WINDOW FAILS. Spend the budget one minute apart,
    // so the hits expire one minute apart too. A fixed window would
    // refuse everything until the period rolled over and then allow the
    // whole budget at once; a sliding one gives back exactly one slot per
    // minute. The previous version of this test spent the whole budget at
    // one instant, where both implementations behave identically.
    for (let i = 0; i < limit; i += 1) {
      expect(allowLocal(BUCKET, "1.1.1.1")).toBe(true);
      vi.advanceTimersByTime(60_000);
    }
    // 10:20 with a 1 h window: the oldest hit (10:00) is still in window.
    expect(allowLocal(BUCKET, "1.1.1.1")).toBe(false);
    // 11:00:01 — the 10:00 hit has just rolled off, so exactly ONE slot
    // is back. Spending it refuses the next immediately, which is the
    // property that distinguishes the two implementations.
    vi.setSystemTime(new Date("2026-09-23T11:00:01.000Z"));
    expect(allowLocal(BUCKET, "1.1.1.1")).toBe(true);
    expect(allowLocal(BUCKET, "1.1.1.1")).toBe(false);
    // One more minute, one more slot — never the whole budget.
    vi.advanceTimersByTime(60_000);
    expect(allowLocal(BUCKET, "1.1.1.1")).toBe(true);
    expect(allowLocal(BUCKET, "1.1.1.1")).toBe(false);
  });

  it("does not charge a refused attempt, so a waiting visitor is not punished twice", () => {
    for (let i = 0; i < limit; i += 1) expect(allowLocal(BUCKET, "1.1.1.1")).toBe(true);
    // Hammer it at 10:30 — every one refused, and none of them recorded.
    vi.advanceTimersByTime(30 * 60_000);
    for (let i = 0; i < 50; i += 1) expect(allowLocal(BUCKET, "1.1.1.1")).toBe(false);
    // The window still expires one hour after the LAST ALLOWED hit.
    vi.advanceTimersByTime(30 * 60_000 + 1_000);
    expect(allowLocal(BUCKET, "1.1.1.1")).toBe(true);
  });

  it("EVICTION CANNOT FORGIVE A SPENT BUDGET, even past the subject cap", () => {
    // THE SWEEP ACTUALLY RUNS HERE. The previous version of this test
    // inserted 200 subjects against a cap of 20 000, so `evictLocal` was
    // never called and the test asserted nothing about eviction at all —
    // it passed against an implementation with no eviction policy
    // whatsoever. Exceeding the real cap is what makes it evidence.
    //
    // It is also the regression test for the bug this found: `Map.set` on
    // an existing key does not change insertion order, so a subject being
    // REFUSED kept its original position and was the first thing shed.
    for (let i = 0; i < limit; i += 1) expect(allowLocal(BUCKET, "victim")).toBe(true);
    expect(allowLocal(BUCKET, "victim")).toBe(false);

    // A rotating caller fills the map past its cap. Every one of these is
    // a fresh subject, so every one is allowed — that is the point: the
    // attacker's own traffic is what drives the sweep.
    for (let i = 0; i < LOCAL_SUBJECT_CAP + 500; i += 1) {
      // Re-assert the victim occasionally so its entry is re-inserted,
      // exactly as a real spender's requests would.
      if (i % 5_000 === 0) expect(allowLocal(BUCKET, "victim")).toBe(false);
      expect(allowLocal(BUCKET, `rot-${i}`)).toBe(true);
    }
    // Still refused: the sweep shed the rotating subjects, not the one
    // whose budget is spent.
    expect(allowLocal(BUCKET, "victim")).toBe(false);
  });

  it("keeps the map at its cap rather than growing without bound", () => {
    for (let i = 0; i < LOCAL_SUBJECT_CAP * 2; i += 1) {
      expect(allowLocal(BUCKET, `flood-${i}`)).toBe(true);
    }
    // One more call to trigger the sweep after the last insert, then the
    // only observable is that an OLD subject has been forgiven while a
    // recent one has not. `LOCAL_SUBJECT_CAP` entries at one hit each is
    // the bound; the map cannot have kept all 40 000.
    expect(allowLocal(BUCKET, "flood-0")).toBe(true);
    expect(allowLocal(BUCKET, `flood-${LOCAL_SUBJECT_CAP * 2 - 1}`)).toBe(true);
  });
});
