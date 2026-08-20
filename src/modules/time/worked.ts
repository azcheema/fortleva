import { secondsBetween } from "@/lib/duration";

/** Pure shift arithmetic shared by shifts.ts and the lazy settle (no cycle). */

/** Σ break seconds; an open break counts up to `at`. */
export const breakSecondsOf = (
  breaks: readonly { startedAt: Date; stoppedAt: Date | null }[],
  at: Date,
): number => breaks.reduce((sum, b) => sum + secondsBetween(b.startedAt, b.stoppedAt ?? at), 0);

/** workedSeconds = span − Σ breaks, never negative (the CHECK bounds it by the span). */
export const workedSecondsOf = (
  shift: { startedAt: Date; stoppedAt: Date },
  breaks: readonly { startedAt: Date; stoppedAt: Date | null }[],
): number =>
  Math.max(0, secondsBetween(shift.startedAt, shift.stoppedAt) - breakSecondsOf(breaks, shift.stoppedAt));
