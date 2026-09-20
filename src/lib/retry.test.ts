import { describe, expect, it } from "vitest";

import { retryOnContention, retryOnDeadlock } from "./retry";

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

/**
 * The contention retry. It exists because a lock timeout is not a
 * deadlock, and the pins below are the two halves of that: it must take
 * the shape `retryOnDeadlock` cannot, and it must still refuse
 * everything neither of them should ever re-run.
 */
const lockTimeout = {
  code: "P2039",
  message: "Database error. Code: `55P03`. Message: `canceling statement due to lock timeout`",
};

describe("retryOnContention", () => {
  it("retries a LOCK TIMEOUT, which retryOnDeadlock does not", async () => {
    let calls = 0;
    await expect(
      retryOnContention(async () => {
        calls += 1;
        throw lockTimeout;
      }),
    ).rejects.toBe(lockTimeout);
    expect(calls).toBe(3);

    // The separation is the point: the same error through the sibling
    // is a single attempt, because a caller that never asked for a
    // bound can never see this shape.
    let deadlockCalls = 0;
    await expect(
      retryOnDeadlock(async () => {
        deadlockCalls += 1;
        throw lockTimeout;
      }),
    ).rejects.toBe(lockTimeout);
    expect(deadlockCalls).toBe(1);
  });

  it("retries a DEADLOCK too — it is a superset, not a replacement", async () => {
    let calls = 0;
    await expect(
      retryOnContention(async () => {
        calls += 1;
        throw deadlock;
      }),
    ).rejects.toBe(deadlock);
    expect(calls).toBe(3);
  });

  it("gives the work back as soon as it succeeds, and does not keep trying", async () => {
    let calls = 0;
    const value = await retryOnContention(async () => {
      calls += 1;
      if (calls < 2) throw lockTimeout;
      return "through";
    });
    expect(value).toBe("through");
    expect(calls).toBe(2);
  });

  it("refuses everything a re-run cannot fix", async () => {
    for (const error of [
      { code: "P2002" },
      { code: "P2025" },
      new Error("FORBIDDEN"),
      // The transaction timeout: a re-run of a unit of work that was
      // simply too slow is three times the wait and the same ending.
      { code: "P2028", message: "expired transaction" },
    ]) {
      let calls = 0;
      await expect(
        retryOnContention(async () => {
          calls += 1;
          throw error;
        }),
      ).rejects.toBe(error);
      expect(calls, `${JSON.stringify(error)} was retried`).toBe(1);
    }
  });
});
