import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE ALLOCATION'S PROOF RESTS ON A CENSUS (Phase 4 slice 108; the design
 * review's answer to "is `pg_trigger_depth() > 1` forgeable?"). The series
 * guard accepts a one-step increment of `next_number` from INSIDE another
 * trigger as "the issue guard allocating a number" — true only while
 * `invoice_guard` is the one trigger function anywhere that updates
 * `invoice_series`. This test reads every migration and holds that: a second
 * writer (a trigger, a function) must come with a reason to widen it, and a
 * reviewer asked whether it can now take a number without an invoice.
 */

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");

/** Every `UPDATE invoice_series` in the migrations, by file, with the function it sits in. */
function census(): { file: string; fn: string | null }[] {
  const out: { file: string; fn: string | null }[] = [];
  for (const dir of readdirSync(MIGRATIONS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const sql = readFileSync(join(MIGRATIONS, dir.name, "migration.sql"), "utf8");
    for (const m of sql.matchAll(/UPDATE\s+"?invoice_series"?\b/gi)) {
      const before = sql.slice(0, m.index);
      const fn = [...before.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-z_]+)/gi)].at(-1)?.[1] ?? null;
      out.push({ file: dir.name, fn });
    }
  }
  return out;
}

describe("who updates invoice_series", () => {
  it("only invoice_guard — in the issuing migration, and its replacement for credit notes (108b), the allocation unchanged", () => {
    expect(census()).toEqual([
      { file: "20261009200000_invoice_issuing", fn: "invoice_guard" },
      { file: "20261010090000_credit_notes", fn: "invoice_guard" },
    ]);
  });
});
