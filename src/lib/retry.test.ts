import { describe, expect, it } from "vitest";

import { retryOnDeadlock } from "./retry";

/**
 * The deadlock retry. Small enough to read in one go, and worth pinning
 * anyway: every branch here is one Postgres reaches only under real
 * contention, which no test in this repo can produce on demand.
 */
const deadlock = { code: "P2039", message: "Database error. Code: `40P01`. Message: `deadlock detected`" };

describe("retryOnDeadlock", () => {
  it("returns the first answer when nothing goes wrong", async () => {
    let calls = 0;
    const out = await retryOnDeadlock(async () => {
      calls += 1;
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls, "an uncontended call is not retried").toBe(1);
  });

  it("re-runs the whole unit and returns the retry's answer", async () => {
    let calls = 0;
    const out = await retryOnDeadlock(async () => {
      calls += 1;
      if (calls === 1) throw deadlock;
      return calls;
    });
    expect(out).toBe(2);
  });

  it("gives up after three attempts and rethrows the deadlock itself", async () => {
    // Rethrows the ORIGINAL error, not a wrapper: whatever reads this
    // upstream — a toast, a log — should see what Postgres said.
    let calls = 0;
    await expect(
      retryOnDeadlock(async () => {
        calls += 1;
        throw deadlock;
      }),
    ).rejects.toBe(deadlock);
    expect(calls, "three attempts, not three retries").toBe(3);
  });

  it("never retries anything that is not a deadlock", async () => {
    // The dangerous failure mode: re-running a unit of work that failed
    // for a reason the re-run cannot fix. A denial, a validation error
    // and a unique violation all go straight up.
    for (const error of [
      { code: "P2002" },
      { code: "P2025" },
      new Error("NOT_FOUND"),
      { code: "P2010", message: "Raw query failed. Code: `23505`." },
    ]) {
      let calls = 0;
      await expect(
        retryOnDeadlock(async () => {
          calls += 1;
          throw error;
        }),
      ).rejects.toBe(error);
      expect(calls, `${JSON.stringify(error)} was retried`).toBe(1);
    }
  });
});
