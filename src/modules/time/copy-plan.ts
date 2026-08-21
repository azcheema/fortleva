import { MAX_ENTRY_SECONDS } from "@/lib/duration";
import { addDays } from "@/lib/week";

import { cleanDescription } from "./description";

/**
 * Copy-last-week, the pure half (UI.md rule 9, D6: "copy-last-week copies
 * ROWS, never hours — 'copy with durations' is the explicit secondary").
 *
 * A "row" is what an entry is ABOUT on a given day: project, task,
 * agreement, work type, billable and the note. Last week's entries are
 * grouped by (weekday, row) — three timer starts on the same task on
 * Tuesday are ONE row — and each group becomes one duration-mode entry on
 * the same weekday of the following week: with an EMPTY duration (0 — the
 * member fills the hours in), or, on the explicit secondary, the group's
 * summed duration. A group whose row already exists on that day of the
 * target week is skipped, so the gesture is idempotent: clicking twice
 * adds nothing, and "copy with durations" after "copy rows" adds only
 * what is not there yet — it never turns a filled row into a summed one.
 * Hours that were never confirmed (a provisional auto-stopped row,
 * `needsReview`) are not promoted into a clean row: they count as 0.
 */

export type CopyRowTarget = {
  readonly projectId: string | null;
  readonly workItemId: string | null;
  readonly serviceId: string | null;
  readonly workTypeId: string | null;
  readonly billable: boolean;
  readonly description: string | null;
};

export type CopySourceRow = CopyRowTarget & {
  readonly id: string;
  /** ISO local date of the source row. */
  readonly localDate: string;
  readonly durationSeconds: number;
  /** Provisional (auto-stopped, unconfirmed) — its hours are not copied. */
  readonly needsReview: boolean;
};

export type CopyExistingRow = Omit<CopySourceRow, "id" | "durationSeconds" | "needsReview">;

export type CopyPlanRow = {
  /** ISO local date in the target week. */
  readonly localDate: string;
  readonly target: CopyRowTarget;
  /** The "with durations" amount — Σ of the group's confirmed durations, ≤ 24 h; 0 when copying rows only. */
  readonly seconds: number;
  /** The source entries folded into this row, in start order. */
  readonly sourceIds: readonly string[];
};

export type CopyPlan = {
  readonly rows: readonly CopyPlanRow[];
  /** Groups left out because the same row already exists on that day of the target week. */
  readonly alreadyPresent: number;
};

/**
 * The target identity of a row — the fields the grid shows and
 * `resolveTarget` takes. Ids are UUIDs and billable is one character, so
 * the note (free text) is last and a "|" inside it cannot collide.
 */
export const copyRowKey = (t: CopyRowTarget): string =>
  [t.projectId ?? "", t.workItemId ?? "", t.serviceId ?? "", t.workTypeId ?? "", t.billable ? "1" : "0", cleanDescription(t.description) ?? ""].join("|");

/** The same row on the same day. */
export const copyDayKey = (localDate: string, t: CopyRowTarget): string => `${localDate}|${copyRowKey(t)}`;

/**
 * Fold `source` (last week's rows) into the plan for the FOLLOWING week,
 * leaving out what `existing` (the target week's rows) already has. Pure;
 * dates are ISO strings.
 */
export function planWeekCopy(
  source: readonly CopySourceRow[],
  existing: readonly CopyExistingRow[],
  options: { readonly withDurations: boolean },
): CopyPlan {
  const present = new Set(existing.map((e) => copyDayKey(e.localDate, e)));
  const groups = new Map<string, { localDate: string; target: CopyRowTarget; seconds: number; sourceIds: string[] }>();
  for (const row of source) {
    const localDate = addDays(row.localDate, 7);
    const key = copyDayKey(localDate, row);
    const confirmedSeconds = row.needsReview ? 0 : row.durationSeconds;
    const g = groups.get(key);
    if (g) {
      g.seconds += confirmedSeconds;
      g.sourceIds.push(row.id);
    } else {
      groups.set(key, {
        localDate,
        target: {
          projectId: row.projectId,
          workItemId: row.workItemId,
          serviceId: row.serviceId,
          workTypeId: row.workTypeId,
          billable: row.billable,
          description: cleanDescription(row.description),
        },
        seconds: confirmedSeconds,
        sourceIds: [row.id],
      });
    }
  }
  const rows: CopyPlanRow[] = [];
  let alreadyPresent = 0;
  for (const [key, g] of groups) {
    if (present.has(key)) {
      alreadyPresent += 1;
      continue;
    }
    rows.push({
      localDate: g.localDate,
      target: g.target,
      // Seconds as stored (a timer's 40 s survive); a day cannot hold more than 24 h (the entry CHECK).
      seconds: options.withDurations ? Math.min(g.seconds, MAX_ENTRY_SECONDS) : 0,
      sourceIds: g.sourceIds,
    });
  }
  return { rows, alreadyPresent };
}
