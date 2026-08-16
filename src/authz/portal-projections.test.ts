import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Forbidden-columns grep (plan §3.2, PLAN.md Phase 2 non-negotiable
 * test): no portal projection may select an INTERNAL-only column. A
 * "portal projection" is any `src/**\/portal.ts` module (the allow-listed
 * selects Phase 3 introduces; view-as-Contact reuses the same
 * functions). None exist yet — the scan passes trivially, but the
 * constant is pinned here so the list is reviewed with every phase.
 */

export const PORTAL_FORBIDDEN_COLUMNS = [
  "internalNotes",
  "repoUrl",
  "hostingNotes",
  "leadMemberId",
  "billRate",
  "cost",
  "assigneeMemberId",
] as const;

const SRC = join(__dirname, "..");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "generated" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "portal.ts") out.push(full);
  }
  return out;
};

const identifierRe = (name: string) => new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_$]|$)`);

describe("portal projections never touch INTERNAL-only columns", () => {
  it("the forbidden list is pinned", () => {
    expect([...PORTAL_FORBIDDEN_COLUMNS]).toEqual([
      "internalNotes",
      "repoUrl",
      "hostingNotes",
      "leadMemberId",
      "billRate",
      "cost",
      "assigneeMemberId",
    ]);
  });

  it("no src/**/portal.ts mentions a forbidden column", () => {
    const files = walk(SRC);
    const offences: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const col of PORTAL_FORBIDDEN_COLUMNS) {
        if (identifierRe(col).test(text)) offences.push(`${relative(SRC, file)}: ${col}`);
      }
    }
    expect(offences).toEqual([]);
  });
});
