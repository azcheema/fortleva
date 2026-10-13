import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THREE GUARDS RE-CREATED WORD FOR WORD (Phase 4 slice 114b; the design
 * review's Q8). Migration 20261020090000 replaces `invoice_export_lock`,
 * `invoice_export_guard` and `invoice_export_entry_guard` — two big plpgsql
 * bodies every bookkeeping file runs through — to let the nightly send in.
 * A re-creation that quietly dropped or changed one of the old rules would
 * pass every test that does not happen to drive that rule. So this reads
 * each function's body in the new migration and in the migration it was
 * copied from, diffs them line by line (whitespace inside a line
 * normalised, so a re-indented rule is still the same rule), and fails on
 * any HUNK — a run of added or removed lines — without a line saying "114b".
 * A reviewer then reads only the marked hunks.
 *
 * Slice 114c (migration 20261021090000) re-creates `integration_connection_guard`
 * the same way, its hunks marked "114c" — the second block below.
 */

const MIGRATIONS = join(__dirname, "..", "..", "..", "prisma", "migrations");

type Replaced = { readonly fn: string; readonly from: string; readonly removed: readonly string[] };

/**
 * Each function, the migration it was copied from, and EVERY line of the old
 * body the new one no longer has (whitespace normalised) — so a marked hunk
 * cannot hide a removal (the pre-apply review's nit). Each is replaced by a
 * widened twin in a marked hunk; a reviewer reads them here.
 */
const REPLACED_114B: readonly Replaced[] = [
  {
    fn: "invoice_export_lock",
    from: "20261010230000_invoice_bookkeeping_export",
    removed: [
      "OR current_setting('app.principal', true) IS DISTINCT FROM 'member' THEN",
      "RAISE EXCEPTION 'INVOICE_EXPORT_LOCK: only a member, for the workspace in hand';",
    ],
  },
  { fn: "invoice_export_guard", from: "20261011090100_invoice_year_end", removed: [] },
  {
    fn: "invoice_export_entry_guard",
    from: "20261011090200_invoice_year_end_exact_dates",
    removed: [
      "IF who IS DISTINCT FROM 'member' THEN",
      "SELECT f.method, f.made_on, f.year_end, f.created_by_member_id, (f.xmin = pg_current_xact_id()::xid) AS fresh",
      "IF NOT FOUND OR NOT file_row.fresh OR file_row.created_by_member_id IS DISTINCT FROM who_id THEN",
      "SELECT i.kind, i.status, i.issue_date, i.paid_on",
    ],
  },
];

/** Slice 114c: the connection's guard — `stop_told_at` among the sender's columns. */
const REPLACED_114C: readonly Replaced[] = [
  {
    fn: "integration_connection_guard",
    from: "20261019090000_fortnox_connection",
    removed: [
      "upkeep constant text[] := ARRAY['status', 'broken_since', 'broken_reason', 'last_ok_at', 'last_night', 'send_lease_until', 'send_run_id'];",
      "OR NEW.send_lease_until IS NOT NULL THEN",
    ],
  },
];

const MIGRATIONS_UNDER_TEST: readonly { readonly migration: string; readonly marker: string; readonly replaced: readonly Replaced[] }[] = [
  { migration: "20261020090000_fortnox_send", marker: "114b", replaced: REPLACED_114B },
  { migration: "20261021090000_fortnox_people", marker: "114c", replaced: REPLACED_114C },
];

/** A function's lines, from its CREATE to its closing `$fn$;`, whitespace normalised, blank lines dropped. */
function bodyOf(migration: string, fn: string): string[] {
  const sql = readFileSync(join(MIGRATIONS, migration, "migration.sql"), "utf8").replace(/\r\n/g, "\n");
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${fn}(`);
  if (start < 0) throw new Error(`${migration}: no ${fn}`);
  // Only one definition per migration — a second would make this read the wrong one.
  if (sql.indexOf(`CREATE OR REPLACE FUNCTION ${fn}(`, start + 1) >= 0) throw new Error(`${migration}: ${fn} twice`);
  const end = sql.indexOf("\n$fn$;", start);
  if (end < 0) throw new Error(`${migration}: ${fn} has no end`);
  return sql
    .slice(start, end + "\n$fn$;".length)
    .split("\n")
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter((l) => l !== "");
}

type Hunk = { readonly removed: string[]; readonly added: string[] };

/** The hunks of a line diff (longest common subsequence). */
function hunks(a: readonly string[], b: readonly string[]): Hunk[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: Hunk[] = [];
  let cur: { removed: string[]; added: string[] } | null = null;
  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      (cur ??= { removed: [], added: [] }).added.push(b[j]!);
      j++;
    } else {
      (cur ??= { removed: [], added: [] }).removed.push(a[i]!);
      i++;
    }
  }
  flush();
  return out;
}

describe("the guards slices 114b and 114c re-create", () => {
  for (const { migration, marker, replaced } of MIGRATIONS_UNDER_TEST) {
    for (const { fn, from, removed } of replaced) {
      it(`${migration} — ${fn}: every change from ${from} is in a hunk marked ${marker}, and only the listed old lines are gone`, () => {
        const was = bodyOf(from, fn);
        const now = bodyOf(migration, fn);
        const changes = hunks(was, now);
        // It changed at all (the slice's point) …
        expect(changes.length, `${fn} was re-created unchanged`).toBeGreaterThan(0);
        // … only where it says so …
        const unmarked = changes.filter((h) => !h.added.some((l) => l.includes(marker)));
        expect(unmarked, `${fn}: unmarked changes`).toEqual([]);
        // … and of the old rules, only these lines went (each replaced in its hunk).
        expect(changes.flatMap((h) => h.removed), `${fn}: old lines removed`).toEqual(removed);
      });
    }
  }

  it("the diff finds an unmarked change (the test tests something)", () => {
    const a = ["IF x THEN", "RAISE EXCEPTION 'a';", "END IF;"];
    expect(hunks(a, ["IF x THEN", "RAISE EXCEPTION 'b';", "END IF;"])).toEqual([{ removed: ["RAISE EXCEPTION 'a';"], added: ["RAISE EXCEPTION 'b';"] }]);
    expect(hunks(a, ["IF x THEN", "END IF;"])).toEqual([{ removed: ["RAISE EXCEPTION 'a';"], added: [] }]);
    expect(hunks(a, a)).toEqual([]);
  });
});
