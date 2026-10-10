import { addDays } from "@/lib/week";

import { financialYearEndOf, type BookkeepingMethod } from "./bookkeeping-accounts";

/**
 * THE CASH METHOD'S YEAR END (Phase 4 slice 111b; founder decision C83, on
 * C82 (e); the design: docs/research/2026-10-10-slice-111b-year-end-design.md,
 * §13 overriding its body) — the pure rules, so a unit test can pin every
 * case.
 *
 * Every invoice unpaid on the financial year's last day E is booked as a
 * receivable on E (`YEAR_END`) and reversed on E + 1 (`YEAR_END_REVERSED`),
 * after which its payment books as every cash-method payment does. A payment
 * that came in by E but is marked after the year end was booked WITHDRAWS
 * the invoice from it (C83 (b)): the year end on E (`YEAR_END_UNDONE`, filed
 * with the payment) and, if it was already filed, the reversal
 * (`YEAR_END_REVERSAL_UNDONE`, on a day of E + 1's year) — both years then
 * exactly as if it had never been in the year end.
 */

/**
 * The last day of the BOOKKEEPING YEAR a day falls in (the design review's
 * re-check R6). On or before the newest booked year end, the booked year ends
 * themselves mark the years — so a financial year changed after one never
 * cuts through a year already closed; before the first, the years that end
 * where it ends; after the newest, the financial year the setting names (a
 * changed start yields a shortened transition year). `bookedYearEnds` oldest
 * first.
 */
export function periodEndOf(day: string, yearStart: number, bookedYearEnds: readonly string[]): string {
  const i = bookedYearEnds.findIndex((e) => e >= day);
  if (i < 0) return financialYearEndOf(day, yearStart);
  if (i > 0) return bookedYearEnds[i]!;
  // In or before the first booked year: years starting the month after it ends.
  const firstStart = (Number(bookedYearEnds[0]!.slice(5, 7)) % 12) + 1;
  return financialYearEndOf(day, firstStart);
}

/** The last day of a day's month. */
export function monthEndOf(day: string): string {
  const [y, m] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

/**
 * The year end that is due, or null: the end of the financial year that
 * follows the last one booked — or, before the first, the one holding the
 * workspace's earliest invoice (nothing before it can be unpaid) — from the
 * SECOND day after it (an invoice issued on the year's last evening is never
 * still in flight; the re-check's NIT). Only the CASH method has one. Year
 * ends go in order, one at a time; a changed financial year yields a
 * shortened transition year.
 */
export function dueYearEnd(input: {
  readonly method: BookkeepingMethod | null;
  readonly yearStart: number;
  /** The workspace's day, `YYYY-MM-DD`. */
  readonly today: string;
  /** The newest year end booked, `YYYY-MM-DD`. */
  readonly lastYearEnd: string | null;
  /** The earliest issued invoice's date, `YYYY-MM-DD`. */
  readonly firstIssue: string | null;
}): string | null {
  if (input.method !== "CASH") return null;
  const from = input.lastYearEnd !== null ? addDays(input.lastYearEnd, 1) : input.firstIssue;
  if (from === null) return null;
  const end = financialYearEndOf(from, input.yearStart);
  return addDays(end, 1) < input.today ? end : null;
}

/**
 * The day a booked payment's reversal is dated (`PAYMENT_UNDONE`; the design
 * review's M3 and its re-check's R4, R5). The file's day — except inside an
 * ENDED bookkeeping year:
 *
 *  - re-marked on another day of the same ended year as the booked one: the
 *    last day of the LATER day's month — the year's total exact (filed on the
 *    file's day it would book the sale twice in that year and −1 in the
 *    next), and each VAT period's as near as one voucher can make it;
 *  - unmarked — or moved to ANOTHER year (its code review's 1) — its year
 *    ended and its year end not yet booked: the last day of the booked day's
 *    month — the booked year is then as if it had never held the payment
 *    (its year end sees it unpaid, or paid on the new day), and the new day's
 *    year books it once.
 *
 * Once the booked year's year end is booked an unmark or a move to another
 * year stays on the file's day (the sale stays in that year; the next year
 * end accrues it again) — the database admits exactly these days
 * (migration 20261011090200).
 */
export function paymentUndoDay(input: {
  readonly bookedOn: string;
  readonly paidOn: string | null;
  readonly today: string;
  readonly yearStart: number;
  readonly bookedYearEnds: readonly string[];
}): string {
  const period = periodEndOf(input.bookedOn, input.yearStart, input.bookedYearEnds);
  if (period >= input.today) return input.today;
  const closed = input.bookedYearEnds.some((e) => e >= input.bookedOn);
  if (input.paidOn === null || periodEndOf(input.paidOn, input.yearStart, input.bookedYearEnds) !== period) {
    return closed ? input.today : monthEndOf(input.bookedOn);
  }
  return monthEndOf(input.paidOn > input.bookedOn ? input.paidOn : input.bookedOn);
}

/**
 * The day a year end's reversal is withdrawn (`YEAR_END_REVERSAL_UNDONE`;
 * the design review's L1, its re-check's R7): the file's day — kept inside
 * E + 1's bookkeeping year once that has ended (or is closed by a booked year
 * end), so the year's total is exact — never E + 1 itself, which would reopen
 * January's VAT period (usually filed, and locked in Fortnox, by the time a
 * late payment turns up).
 */
export function reversalUndoDay(yearEnd: string, today: string, yearStart: number, bookedYearEnds: readonly string[]): string {
  const end = periodEndOf(addDays(yearEnd, 1), yearStart, bookedYearEnds);
  return end < today ? end : today;
}

/** One invoice's booked year end E, as the files record it, and its mark now. */
export type YearEndState = {
  /** E, `YYYY-MM-DD`. */
  readonly yearEnd: string;
  /** Its `YEAR_END_UNDONE` is filed. */
  readonly withdrawn: boolean;
  /** Its `YEAR_END_REVERSED` is filed. */
  readonly reversed: boolean;
  /** Its `YEAR_END_REVERSAL_UNDONE` is filed. */
  readonly reversalWithdrawn: boolean;
  /** The invoice's `paid_on` now. */
  readonly paidOn: string | null;
  /** A payment stands in the BOOKS at E (filed by E, not reversed by E) — a later year end's, once its payment is filed. */
  readonly paidInBooks: boolean;
};

export type YearEndCorrection = "YEAR_END_REVERSED" | "YEAR_END_UNDONE" | "YEAR_END_REVERSAL_UNDONE";

/**
 * What a booked year end still needs, in the order it is filed: reversed on
 * E + 1 while it stands and its invoice was not paid by E; withdrawn on E
 * once it was — a payment on or before E marked, or one standing in the
 * books at E (a LATER year end's, once the payment that withdrew the first
 * is filed; its design review's M1); and its reversal, if filed, withdrawn
 * with it — also when the payment was unmarked again after the withdrawal
 * was filed (M2: a year end is never re-instated, one year-end file per
 * year).
 */
export function yearEndCorrections(s: YearEndState): YearEndCorrection[] {
  const paidByYearEnd = (s.paidOn !== null && s.paidOn <= s.yearEnd) || s.paidInBooks;
  const out: YearEndCorrection[] = [];
  if (!s.withdrawn) {
    if (paidByYearEnd) out.push("YEAR_END_UNDONE");
    else if (!s.reversed) out.push("YEAR_END_REVERSED");
  }
  if ((s.withdrawn || paidByYearEnd) && s.reversed && !s.reversalWithdrawn) out.push("YEAR_END_REVERSAL_UNDONE");
  return out;
}
