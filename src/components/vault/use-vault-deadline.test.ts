import { describe, expect, it } from "vitest";

import { tightestDeadline } from "./use-vault-deadline";

/**
 * How a receipt updates an open vault window's deadline on this page
 * (slice 97). Every candidate — this clock's now plus the server's
 * remaining ms — is at or after the real lock instant, so the earliest
 * seen is the right one.
 */
describe("tightestDeadline", () => {
  it("takes the first receipt as it is", () => {
    expect(tightestDeadline(undefined, 1_000, 600_000)).toBe(601_000);
  });

  it("a fresher receipt tightens it — a late first receipt never governs the window", () => {
    // The first answer landed after a 60 s stall (a laptop waking): its
    // candidate is 60 s late. A page rendered fresh then knows better.
    const late = tightestDeadline(undefined, 61_000, 600_000);
    expect(tightestDeadline(late, 70_000, 531_000)).toBe(601_000);
  });

  it("a replayed payload — a later now, the same frozen msLeft — never extends it", () => {
    const first = tightestDeadline(undefined, 1_000, 600_000);
    expect(tightestDeadline(first, 300_000, 600_000)).toBe(first);
  });

  it("a remainder already spent counts as none", () => {
    expect(tightestDeadline(undefined, 5_000, -2_000)).toBe(5_000);
  });
});
