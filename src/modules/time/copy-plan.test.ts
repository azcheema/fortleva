import { describe, expect, it } from "vitest";

import { copyRowKey, planWeekCopy, type CopySourceRow } from "./copy-plan";

/**
 * The pure half of copy-last-week (D6: rows, never hours): grouping by
 * (weekday, what-it-was-about), the empty-duration default vs the summed
 * secondary, provisional hours never promoted, and idempotence against
 * what the target week already holds.
 */

const row = (over: Partial<CopySourceRow> & { id: string; localDate: string }): CopySourceRow => ({
  projectId: "p1",
  workItemId: null,
  serviceId: null,
  workTypeId: null,
  billable: true,
  description: "Design",
  durationSeconds: 3600,
  needsReview: false,
  ...over,
});

describe("planWeekCopy", () => {
  it("copies rows, not hours: one DURATION row per (weekday, target) with an EMPTY duration, on the same weekday next week", () => {
    const plan = planWeekCopy(
      [
        row({ id: "a", localDate: "2026-08-10", durationSeconds: 1800 }), // Mon, Design ×2 (two timer starts)
        row({ id: "b", localDate: "2026-08-10", durationSeconds: 2700 }),
        row({ id: "c", localDate: "2026-08-10", description: "Review" }), // Mon, another row
        row({ id: "d", localDate: "2026-08-12", workItemId: "t1", description: null }), // Wed, a task
        row({ id: "e", localDate: "2026-08-14", projectId: null, billable: false, description: "Admin" }), // Fri, ad-hoc
      ],
      [],
      { withDurations: false },
    );
    expect(plan.alreadyPresent).toBe(0);
    expect(plan.rows.map((r) => [r.localDate, r.target.description ?? r.target.workItemId, r.seconds, r.sourceIds])).toEqual([
      ["2026-08-17", "Design", 0, ["a", "b"]],
      ["2026-08-17", "Review", 0, ["c"]],
      ["2026-08-19", "t1", 0, ["d"]],
      ["2026-08-21", "Admin", 0, ["e"]],
    ]);
    // The target carries what the row was ABOUT, verbatim (billable too — the service re-resolves rates, not the choice).
    expect(plan.rows[3]!.target).toEqual({ projectId: null, workItemId: null, serviceId: null, workTypeId: null, billable: false, description: "Admin" });
  });

  it("'copy with durations' is the explicit secondary: the group's sum in seconds, capped at 24 h; provisional (needs-review) hours count as 0", () => {
    const plan = planWeekCopy(
      [
        row({ id: "a", localDate: "2026-08-10", durationSeconds: 1800 }),
        row({ id: "b", localDate: "2026-08-10", durationSeconds: 2700 + 40 }), // a timer's 40 s survive
        row({ id: "c", localDate: "2026-08-11", durationSeconds: 20 * 3600 }),
        row({ id: "d", localDate: "2026-08-11", durationSeconds: 10 * 3600 }), // overlapping timers summed past a day
        row({ id: "e", localDate: "2026-08-12", durationSeconds: 12 * 3600, needsReview: true }), // auto-stopped, unconfirmed
        row({ id: "f", localDate: "2026-08-12", durationSeconds: 900 }),
      ],
      [],
      { withDurations: true },
    );
    expect(plan.rows.map((r) => [r.localDate, r.seconds, r.sourceIds])).toEqual([
      ["2026-08-17", 4540, ["a", "b"]],
      ["2026-08-18", 24 * 3600, ["c", "d"]],
      ["2026-08-19", 900, ["e", "f"]], // the row copies; only its confirmed quarter hour does
    ]);
  });

  it("is idempotent: a row already present on that day of the target week is skipped and counted, the rest still copies", () => {
    const source = [row({ id: "a", localDate: "2026-08-10" }), row({ id: "b", localDate: "2026-08-11", description: "Review" })];
    const first = planWeekCopy(source, [], { withDurations: false });
    expect(first.rows).toHaveLength(2);
    // What the first copy wrote is now in the target week (with an empty duration).
    const existing = first.rows.map((r) => ({ ...r.target, localDate: r.localDate }));
    const second = planWeekCopy(source, existing, { withDurations: true });
    expect(second.rows).toHaveLength(0);
    expect(second.alreadyPresent).toBe(2);
    // A new last-week row copies; the old ones stay skipped.
    const third = planWeekCopy([...source, row({ id: "c", localDate: "2026-08-12", description: "New" })], existing, { withDurations: true });
    expect(third.rows.map((r) => [r.localDate, r.target.description, r.seconds])).toEqual([["2026-08-19", "New", 3600]]);
    expect(third.alreadyPresent).toBe(2);
  });

  it("the row key is the target with the note normalised like the stored row — the same row on another DAY is another row", () => {
    expect(copyRowKey(row({ id: "x", localDate: "2026-08-10", description: " Design " }))).toBe(copyRowKey(row({ id: "y", localDate: "2026-08-11" })));
    expect(copyRowKey(row({ id: "x", localDate: "2026-08-10", description: "  " }))).toBe(copyRowKey(row({ id: "y", localDate: "2026-08-11", description: null })));
    const plan = planWeekCopy(
      [row({ id: "a", localDate: "2026-08-10" }), row({ id: "b", localDate: "2026-08-11" })],
      [{ ...row({ id: "z", localDate: "2026-08-17" }), localDate: "2026-08-17" }],
      { withDurations: false },
    );
    expect(plan.rows.map((r) => r.localDate)).toEqual(["2026-08-18"]);
    expect(plan.alreadyPresent).toBe(1);
  });

  it("an empty last week plans nothing", () => {
    expect(planWeekCopy([], [], { withDurations: false })).toEqual({ rows: [], alreadyPresent: 0 });
  });
});
