import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FILL_IN_KEYS } from "./fill-ins";

/**
 * THE DATABASE'S FILL-IN LIST IS THE APP'S (slice 112b; the design's §10 item
 * 14). The send's guard refuses a body still holding a `{{key}}` of the list,
 * by a regex written into the migration — a copy of `FILL_IN_KEYS` the
 * database cannot import. This reads the NEWEST migration that defines
 * `contract_guard` and fails when its key list and `FILL_IN_KEYS` differ, so a
 * key added to the app without a migration that teaches the guard cannot ship.
 */

const MIGRATIONS = join(__dirname, "..", "..", "..", "prisma", "migrations");

function guardKeys(): string[] {
  const dirs = readdirSync(MIGRATIONS)
    .filter((d) => /^\d{14}_/.test(d))
    .sort();
  for (const dir of dirs.reverse()) {
    const sql = readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8");
    if (!sql.includes("CREATE OR REPLACE FUNCTION contract_guard()")) continue;
    const m = /\[\{\]\[\{\]\(([a-z_|]+)\)\[\}\]\[\}\]/.exec(sql);
    // Only slice 112's guard (before the send existed) may lack the check; a
    // newer guard without it is a guard that stopped refusing fill-ins.
    if (!m && dir < "20261012090000") continue;
    if (!m) throw new Error(`${dir}: contract_guard has no fill-in check`);
    return m[1]!.split("|").sort();
  }
  return [];
}

describe("the send guard's fill-in keys", () => {
  it("are exactly FILL_IN_KEYS", () => {
    expect(guardKeys()).toEqual([...FILL_IN_KEYS].sort());
  });
});
