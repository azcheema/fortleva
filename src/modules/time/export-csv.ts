import { toCsv, type CsvCell } from "@/lib/csv";
import { secondsBetween } from "@/lib/duration";
import { dateFormat, machineNumber } from "@/lib/format";

import type { EntriesExport, RollupExport, WorkingTimeStatement } from "./export";

/**
 * The CSV shapes of the time module's exports (PLAN.md 2T "CSV exports"
 * + D1 statement) — pure functions over the export results, kept apart
 * from export.ts so they import no database client and can be proven by
 * a plain unit test. The rules they encode: headers are machine keys,
 * numbers machine-formatted (`machineNumber`, never the display
 * formatter), rate/amount columns only when the export carried rates,
 * cost columns only when the ✦ reveal actually filled them, and the
 * statement's tracked columns only on the member's OWN statement.
 */

const hours2 = (seconds: number): string => machineNumber(Math.round((seconds / 3600) * 100) / 100);

// ── Entries ─────────────────────────────────────────────────────────

const ENTRY_COLUMNS = [
  "id",
  "date",
  "started_at",
  "stopped_at",
  "timezone",
  "seconds",
  "hours",
  "member_id",
  "member",
  "client",
  "project_key",
  "project",
  "task_key",
  "task",
  "agreement",
  "work_type",
  "billable",
  "description",
  "entry_mode",
  "source",
  "needs_review",
  "locked_reason",
] as const;
const RATE_COLUMNS = ["rate", "currency", "amount"] as const;

/** The entries CSV: rate/currency/amount columns exist only when the export carried rates. */
export function entriesCsv(e: EntriesExport): string {
  const header = e.includesRates ? [...ENTRY_COLUMNS, ...RATE_COLUMNS] : [...ENTRY_COLUMNS];
  const rows = e.rows.map((r): CsvCell[] => {
    const base: CsvCell[] = [
      r.id,
      r.date,
      r.startedAt,
      r.stoppedAt,
      r.timezone,
      r.seconds,
      hours2(r.seconds),
      r.memberId,
      r.memberName,
      r.clientName,
      r.projectKey,
      r.projectName,
      r.taskKey,
      r.taskTitle,
      r.agreement,
      r.workType,
      r.billable,
      r.description,
      r.entryMode,
      r.source,
      r.needsReview,
      r.lockedReason,
    ];
    return e.includesRates ? [...base, r.rate, r.currency, r.amount] : base;
  });
  return toCsv(header, rows);
}

// ── Project rollup ──────────────────────────────────────────────────

const ROLLUP_COLUMNS = ["dimension", "key", "label", "seconds", "hours", "billable_seconds", "billable_hours"] as const;
const AMOUNT_COLUMNS = ["amount", "currency"] as const;
const COST_COLUMNS = ["cost", "margin", "margin_percent"] as const;

/** The rollup CSV: amount columns with rate:view_bill, cost columns only when the ✦ reveal happened. */
export function rollupCsv(e: RollupExport): string {
  const header = [
    ...ROLLUP_COLUMNS,
    ...(e.includesAmounts ? AMOUNT_COLUMNS : []),
    ...(e.includesCost ? COST_COLUMNS : []),
  ];
  const rows = e.lines.map((l): CsvCell[] => [
    l.dimension,
    l.key,
    l.label,
    l.seconds,
    hours2(l.seconds),
    l.billableSeconds,
    hours2(l.billableSeconds),
    ...(e.includesAmounts ? [l.amount, e.currency] : []),
    ...(e.includesCost ? [l.cost, l.margin, l.marginPercent] : []),
  ]);
  return toCsv(header, rows);
}

// ── Working-time statement ──────────────────────────────────────────

/** HH:MM in the shift's own zone — the journal reads in local time; the ISO columns carry the instant. Memoised per zone. */
const localClock = (d: Date, timeZone: string): string =>
  dateFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(d);

const STATEMENT_COLUMNS = [
  "date",
  "shift_start",
  "shift_end",
  "shift_start_utc",
  "shift_end_utc",
  "timezone",
  "span_seconds",
  "break_seconds",
  "worked_seconds",
  "worked_hours",
  "provisional",
  "no_break_over_5h",
  "note",
] as const;
const OWN_COLUMNS = ["tracked_seconds", "tracked_hours", "unallocated_seconds"] as const;

/**
 * The statement CSV: one row per shift (a day with two shifts is two
 * rows); an own day with tracked time but no shift is one row with the
 * shift columns empty; days with nothing are omitted; a TOTAL row last.
 */
export function statementCsv(s: WorkingTimeStatement): string {
  const header = s.own ? [...STATEMENT_COLUMNS, ...OWN_COLUMNS] : [...STATEMENT_COLUMNS];
  const rows: CsvCell[][] = [];
  for (const d of s.days) {
    const ownTail = (tracked: number | null, unallocated: number | null): CsvCell[] =>
      s.own ? [tracked, tracked === null ? null : hours2(tracked), unallocated] : [];
    if (d.shifts.length === 0) {
      if (s.own && (d.trackedSeconds ?? 0) > 0) {
        rows.push([d.date, null, null, null, null, null, null, null, null, null, null, null, null, ...ownTail(d.trackedSeconds, d.unallocatedSeconds)]);
      }
      continue;
    }
    d.shifts.forEach((r, i) => {
      rows.push([
        d.date,
        localClock(r.startedAt, r.timezone),
        localClock(r.stoppedAt, r.timezone),
        r.startedAt.toISOString(),
        r.stoppedAt.toISOString(),
        r.timezone,
        secondsBetween(r.startedAt, r.stoppedAt),
        r.breakSeconds,
        r.workedSeconds,
        hours2(r.workedSeconds),
        r.provisional,
        r.noBreak,
        r.note,
        // Tracked time is a DAY figure — on the day's first shift row only, so a two-shift day does not double it.
        ...(i === 0 ? ownTail(d.trackedSeconds, d.unallocatedSeconds) : ownTail(null, null)),
      ]);
    });
  }
  // The TOTAL row keeps the boolean columns empty (a typed consumer must not meet a count there); the counts live on the page.
  rows.push([
    "TOTAL",
    null,
    null,
    null,
    null,
    null,
    s.totals.spanSeconds,
    s.totals.breakSeconds,
    s.totals.workedSeconds,
    hours2(s.totals.workedSeconds),
    null,
    null,
    null,
    ...(s.own ? [s.totals.trackedSeconds, s.totals.trackedSeconds === null ? null : hours2(s.totals.trackedSeconds), s.totals.unallocatedSeconds] : []),
  ]);
  return toCsv(header, rows);
}
