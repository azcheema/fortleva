import { describe, expect, it } from "vitest";

import { dueYearEnd, monthEndOf, paymentUndoDay, periodEndOf, reversalUndoDay, yearEndCorrections, type YearEndState } from "./bookkeeping-year-end";

describe("periodEndOf (the re-check's R6)", () => {
  it("is the financial year's end while no year end is booked", () => {
    expect(periodEndOf("2026-05-10", 1, [])).toBe("2026-12-31");
    expect(periodEndOf("2026-05-10", 7, [])).toBe("2026-06-30");
  });

  it("follows the booked year ends on or before the newest — a changed financial year never cuts a closed one", () => {
    const booked = ["2026-12-31"];
    // Changed to July after 2026 was closed: 2026 is still one year…
    expect(periodEndOf("2026-05-10", 7, booked)).toBe("2026-12-31");
    expect(periodEndOf("2026-12-31", 7, booked)).toBe("2026-12-31");
    // …the years before it are the ones ending where it ends…
    expect(periodEndOf("2025-03-01", 7, booked)).toBe("2025-12-31");
    // …and after it, the transition year to the new end.
    expect(periodEndOf("2027-01-01", 7, booked)).toBe("2027-06-30");
    expect(periodEndOf("2027-07-01", 7, booked)).toBe("2028-06-30");
    // Between two booked year ends: the later.
    expect(periodEndOf("2027-03-01", 7, ["2026-12-31", "2027-06-30"])).toBe("2027-06-30");
  });

  it("finds a month's last day", () => {
    expect(monthEndOf("2026-12-15")).toBe("2026-12-31");
    expect(monthEndOf("2028-02-03")).toBe("2028-02-29");
  });
});

describe("dueYearEnd", () => {
  const base = { method: "CASH" as const, yearStart: 1, today: "2027-01-05", lastYearEnd: null, firstIssue: "2026-10-12" };

  it("is the year of the earliest invoice, from the second day after it", () => {
    expect(dueYearEnd(base)).toBe("2026-12-31");
    expect(dueYearEnd({ ...base, today: "2026-12-31" })).toBeNull();
    // Not on New Year's Day: an invoice issued on the year's last evening may still be in flight.
    expect(dueYearEnd({ ...base, today: "2027-01-01" })).toBeNull();
    expect(dueYearEnd({ ...base, today: "2027-01-02" })).toBe("2026-12-31");
  });

  it("is the year after the last one booked, in order — the older first", () => {
    expect(dueYearEnd({ ...base, lastYearEnd: "2026-12-31" })).toBeNull();
    expect(dueYearEnd({ ...base, today: "2028-03-01", lastYearEnd: "2026-12-31" })).toBe("2027-12-31");
    // Missed two: the older is due first.
    expect(dueYearEnd({ ...base, today: "2029-03-01", firstIssue: "2026-10-12" })).toBe("2026-12-31");
  });

  it("follows a changed financial year: a shortened transition year", () => {
    expect(dueYearEnd({ ...base, yearStart: 5, today: "2027-05-02", lastYearEnd: "2026-12-31" })).toBe("2027-04-30");
    expect(dueYearEnd({ ...base, yearStart: 5, today: "2027-05-01", lastYearEnd: "2026-12-31" })).toBeNull();
  });

  it("is never due without an invoice, or under the invoice method", () => {
    expect(dueYearEnd({ ...base, firstIssue: null })).toBeNull();
    expect(dueYearEnd({ ...base, method: "INVOICE" })).toBeNull();
    expect(dueYearEnd({ ...base, method: null })).toBeNull();
  });
});

describe("paymentUndoDay (the review's M3, the re-check's R4, R5)", () => {
  const base = { bookedOn: "2026-11-15", paidOn: "2026-12-18", today: "2027-01-20", yearStart: 1, bookedYearEnds: [] as string[] };

  it("dates a correction inside an ended year on the later day's month end", () => {
    expect(paymentUndoDay(base)).toBe("2026-12-31");
    expect(paymentUndoDay({ ...base, bookedOn: "2026-12-15", paidOn: "2026-11-18" })).toBe("2026-12-31");
    expect(paymentUndoDay({ ...base, bookedOn: "2026-10-03", paidOn: "2026-10-09" })).toBe("2026-10-31");
    // The same, once that year's year end is booked: it stays in the year.
    expect(paymentUndoDay({ ...base, bookedYearEnds: ["2026-12-31"] })).toBe("2026-12-31");
  });

  it("dates an unmark in an ended year on the booked day's month end — until its year end is booked", () => {
    expect(paymentUndoDay({ ...base, paidOn: null })).toBe("2026-11-30");
    expect(paymentUndoDay({ ...base, paidOn: null, bookedYearEnds: ["2026-12-31"] })).toBe("2027-01-20");
  });

  it("keeps a payment moved to ANOTHER year out of its ended booked year — while that year is not closed (the code review's 1)", () => {
    // Moved forward into the open year: the booked year's month end.
    expect(paymentUndoDay({ ...base, paidOn: "2027-01-05" })).toBe("2026-11-30");
    // Moved back into an earlier year, made a year on: the booked year's month end too.
    expect(paymentUndoDay({ bookedOn: "2026-01-03", paidOn: "2025-12-30", today: "2027-02-10", yearStart: 1, bookedYearEnds: [] })).toBe("2026-01-31");
    // Its year end already booked: the file's day.
    expect(paymentUndoDay({ ...base, paidOn: "2027-01-05", bookedYearEnds: ["2026-12-31"] })).toBe("2027-01-20");
  });

  it("is the file's day while the booked year has not ended", () => {
    expect(paymentUndoDay({ ...base, today: "2026-12-20" })).toBe("2026-12-20");
    expect(paymentUndoDay({ ...base, today: "2026-12-20", paidOn: null })).toBe("2026-12-20");
    expect(paymentUndoDay({ ...base, bookedOn: "2027-01-03", paidOn: "2027-01-04" })).toBe("2027-01-20");
    expect(paymentUndoDay({ ...base, bookedOn: "2027-01-03", paidOn: "2026-12-04" })).toBe("2027-01-20");
  });

  it("keeps a closed year whole after the financial year changed (R6)", () => {
    // 2026 closed under a January year, then changed to July: a November correction made in March.
    expect(paymentUndoDay({ bookedOn: "2026-11-02", paidOn: "2026-11-05", today: "2027-03-10", yearStart: 7, bookedYearEnds: ["2026-12-31"] })).toBe("2026-11-30");
  });
});

describe("reversalUndoDay (the review's L1, the re-check's R7)", () => {
  it("is the file's day, kept inside E + 1's year once that has ended or is closed", () => {
    expect(reversalUndoDay("2026-12-31", "2027-03-20", 1, ["2026-12-31"])).toBe("2027-03-20");
    expect(reversalUndoDay("2026-12-31", "2028-02-01", 1, ["2026-12-31"])).toBe("2027-12-31");
    expect(reversalUndoDay("2026-04-30", "2027-06-01", 5, ["2026-04-30"])).toBe("2027-04-30");
    // The next year end already booked: never after it.
    expect(reversalUndoDay("2026-12-31", "2028-02-01", 7, ["2026-12-31", "2027-06-30"])).toBe("2027-06-30");
  });
});

describe("yearEndCorrections", () => {
  const E = "2026-12-31";
  const s = (o: Partial<YearEndState>): YearEndState => ({
    yearEnd: E,
    withdrawn: false,
    reversed: false,
    reversalWithdrawn: false,
    paidOn: null,
    paidInBooks: false,
    ...o,
  });

  it("reverses a standing year end on the next day while its invoice was not paid by then", () => {
    expect(yearEndCorrections(s({}))).toEqual(["YEAR_END_REVERSED"]);
    expect(yearEndCorrections(s({ paidOn: "2027-01-20" }))).toEqual(["YEAR_END_REVERSED"]);
    expect(yearEndCorrections(s({ reversed: true }))).toEqual([]);
    expect(yearEndCorrections(s({ reversed: true, paidOn: "2027-01-20" }))).toEqual([]);
  });

  it("withdraws it when a payment on or before the year end is marked late — the reversal with it if filed (C83 (b))", () => {
    expect(yearEndCorrections(s({ paidOn: E }))).toEqual(["YEAR_END_UNDONE"]);
    expect(yearEndCorrections(s({ paidOn: "2026-12-30", reversed: true }))).toEqual(["YEAR_END_UNDONE", "YEAR_END_REVERSAL_UNDONE"]);
    // The withdrawal filed, the reversal not yet withdrawn.
    expect(yearEndCorrections(s({ paidOn: "2026-12-30", withdrawn: true, reversed: true }))).toEqual(["YEAR_END_REVERSAL_UNDONE"]);
    // Both done: nothing.
    expect(yearEndCorrections(s({ paidOn: "2026-12-30", withdrawn: true, reversed: true, reversalWithdrawn: true }))).toEqual([]);
  });

  it("never re-instates a withdrawn year end, even when the payment is unmarked again", () => {
    expect(yearEndCorrections(s({ withdrawn: true }))).toEqual([]);
    expect(yearEndCorrections(s({ withdrawn: true, reversed: true }))).toEqual(["YEAR_END_REVERSAL_UNDONE"]);
  });

  it("treats each year end on its own — an invoice in two, paid before the first", () => {
    const paidOn = "2026-12-20";
    expect(yearEndCorrections(s({ paidOn, reversed: true }))).toEqual(["YEAR_END_UNDONE", "YEAR_END_REVERSAL_UNDONE"]);
    expect(yearEndCorrections(s({ yearEnd: "2027-12-31", paidOn }))).toEqual(["YEAR_END_UNDONE"]);
  });

  it("withdraws a later year end by the BOOKS — the payment filed, then unmarked (the review's M1 (b))", () => {
    expect(yearEndCorrections(s({ yearEnd: "2027-12-31", paidOn: null, paidInBooks: true }))).toEqual(["YEAR_END_UNDONE"]);
    expect(yearEndCorrections(s({ yearEnd: "2027-12-31", paidOn: null, paidInBooks: true, reversed: true }))).toEqual([
      "YEAR_END_UNDONE",
      "YEAR_END_REVERSAL_UNDONE",
    ]);
    // Never reversed while a payment stands at it.
    expect(yearEndCorrections(s({ paidInBooks: true }))).not.toContain("YEAR_END_REVERSED");
  });

  it("withdraws the reversal of a withdrawn year end whatever the mark says now (the review's M2)", () => {
    expect(yearEndCorrections(s({ withdrawn: true, reversed: true, paidOn: null }))).toEqual(["YEAR_END_REVERSAL_UNDONE"]);
    expect(yearEndCorrections(s({ withdrawn: true, reversed: true, paidOn: "2027-02-01" }))).toEqual(["YEAR_END_REVERSAL_UNDONE"]);
  });
});
