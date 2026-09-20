import { describe, expect, it } from "vitest";

import { isDeadlock, isLockTimeout, isUniqueViolation } from "./domain-error";

/**
 * The two Prisma duck tests. Both exist because of the one-seam rule —
 * nothing outside `src/db` and `src/auth` may import the generated
 * client — so neither can use `instanceof`, and what they match is a
 * SHAPE that a Prisma upgrade can change underneath them without a
 * single type error.
 *
 * `isDeadlock`'s three codes are the reason this file exists. They were
 * read off the installed runtime, not inferred, and its first draft
 * accepted only P2010 — the raw-query shape — which would have missed
 * every model call, and a model call is precisely what is left once a
 * queue lock has removed the cycle two rank writers made between
 * themselves (review, CI run 35440299558). The fixtures below are the
 * real messages `@prisma/client/runtime` builds.
 */
const p2010 = {
  code: "P2010",
  message: "Raw query failed. Code: `40P01`. Message: `deadlock detected`",
};
const p2039 = {
  code: "P2039",
  message: "Database error. Code: `40P01`. Message: `deadlock detected`",
};

describe("isUniqueViolation", () => {
  it("matches P2002 and nothing else", () => {
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isUniqueViolation({ code: "P2003" })).toBe(false);
    expect(isUniqueViolation(p2010)).toBe(false);
  });

  it("survives anything that is not an error object", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("P2002")).toBe(false);
    expect(isUniqueViolation(new Error("P2002"))).toBe(false);
  });
});

describe("isDeadlock", () => {
  it("matches a deadlock in a RAW query (P2010)", () => {
    expect(isDeadlock(p2010)).toBe(true);
  });

  it("matches a deadlock in a MODEL call (P2039) — the case the retry is for", () => {
    // An `update`, or the audit write every mutation makes. Once the
    // advisory queue lock has removed the cycle between two rank
    // writers, a cycle through ANOTHER table is what remains, and that
    // is a model call by definition.
    expect(isDeadlock(p2039)).toBe(true);
  });

  it("matches Prisma's own write-conflict code (P2034) without reading the message", () => {
    // P2034 IS the deadlock; the other two are generic wrappers.
    expect(isDeadlock({ code: "P2034" })).toBe(true);
    expect(isDeadlock({ code: "P2034", message: "" })).toBe(true);
  });

  it("refuses a generic wrapper that is NOT a deadlock", () => {
    // The whole risk of matching on a wrapper code: P2010 and P2039 are
    // "something went wrong in the database", not "40P01".
    expect(isDeadlock({ code: "P2010", message: "Raw query failed. Code: `23505`." })).toBe(false);
    expect(
      isDeadlock({ code: "P2039", message: "Database error. Code: `40001`. Message: `serialize`" }),
    ).toBe(false);
  });

  it("refuses the codes that are somebody else's problem", () => {
    expect(isDeadlock({ code: "P2002" })).toBe(false);
    expect(isDeadlock({ code: "P2025", message: "deadlock detected" })).toBe(false);
  });

  it("survives anything that is not an error object", () => {
    expect(isDeadlock(null)).toBe(false);
    expect(isDeadlock(undefined)).toBe(false);
    expect(isDeadlock("deadlock detected")).toBe(false);
    expect(isDeadlock({ code: 2010 })).toBe(false);
    expect(isDeadlock({})).toBe(false);
  });

  it("reads the words as well as the code, since the driver gives both", () => {
    expect(isDeadlock({ code: "P2039", message: "Database error: deadlock detected" })).toBe(true);
    expect(isDeadlock({ code: "P2010", message: "Code: `40P01`" })).toBe(true);
  });
});

/**
 * `isLockTimeout` — the sibling, pinned for the same reason and against
 * the same risk. The P2039 fixture is the REAL error the installed
 * runtime produced: `portal-contention.dbtest.ts` provoked a genuine
 * blocked fan-out and a mutation check with the code set emptied
 * printed it verbatim. P2010 is carried over from `isDeadlock` by
 * symmetry and is marked unproven in the source.
 *
 * The dangerous failure here is a FALSE POSITIVE: a wrapper code that
 * is not 55P03 being read as contention would be retried three times
 * and then reported to the member as "try again" — hiding a real
 * error behind a reassuring message on a safety-critical control.
 * Hence the refusals below, one per way in.
 */
const lock2039 = {
  code: "P2039",
  message: "Database error. Code: `55P03`. Message: `canceling statement due to lock timeout`",
};

describe("isLockTimeout", () => {
  it("matches a lock timeout in a MODEL call (P2039) — the measured shape", () => {
    expect(isLockTimeout(lock2039)).toBe(true);
  });

  it("matches the raw-query wrapper too, and reads words or code", () => {
    expect(isLockTimeout({ code: "P2010", message: "Raw query failed. Code: `55P03`." })).toBe(true);
    expect(isLockTimeout({ code: "P2039", message: "canceling statement due to lock timeout" })).toBe(true);
  });

  it("refuses a DEADLOCK — the two shapes must not be confused", () => {
    // They share both wrapper codes, so only the SQLSTATE separates
    // them. A deadlock read as a lock timeout would be translated to
    // PORTAL_SWITCH_BUSY by the wrong branch, and vice versa.
    expect(isLockTimeout({ code: "P2039", message: "Code: `40P01`. Message: `deadlock detected`" })).toBe(false);
    expect(isDeadlock(lock2039)).toBe(false);
  });

  it("refuses a generic wrapper that is NOT a lock timeout", () => {
    expect(isLockTimeout({ code: "P2010", message: "Raw query failed. Code: `23505`." })).toBe(false);
  });

  it("refuses P2034 and P2028, which are neither", () => {
    // P2034 is Prisma's own deadlock/write-conflict code, so it belongs
    // to the sibling. P2028 is the transaction timeout — the shape this
    // slice exists to STOP being the answer, and carrying a 55P03 in
    // its message must not make it one.
    expect(isLockTimeout({ code: "P2034" })).toBe(false);
    expect(isLockTimeout({ code: "P2028", message: "Code: `55P03`" })).toBe(false);
  });

  it("survives anything that is not an error object", () => {
    expect(isLockTimeout(null)).toBe(false);
    expect(isLockTimeout(undefined)).toBe(false);
    expect(isLockTimeout("lock timeout")).toBe(false);
    expect(isLockTimeout({ code: 2039 })).toBe(false);
    expect(isLockTimeout({})).toBe(false);
  });
});
