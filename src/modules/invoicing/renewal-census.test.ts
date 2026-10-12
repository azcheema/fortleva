import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE RENEWAL JOB'S RIGHT RESTS ON A CENSUS (Phase 4 slice 113b; the design
 * review's M1). The database lets the SYSTEM principal make an invoice draft,
 * add a line to one and widen its period ONLY while `app.renewal_drafting` is
 * on (`invoice_guard`, `invoice_line_guard`, migration 20261018090000) —
 * because ~55 files run as SYSTEM, the portal's brokers among them, and the
 * right must be the renewal job's alone. That holds only while ONE file sets
 * the GUC: `src/modules/invoicing/renewals.ts`. This test reads every source
 * file and says so; a second setter must come with a reason, and a reviewer
 * asked what it could now write onto an invoice.
 */

const SRC = join(process.cwd(), "src");
const GUC = "app.renewal_drafting";

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated" || entry.name === "node_modules") continue;
      out.push(...files(path));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

describe("who opens the renewal job's right", () => {
  it("only src/modules/invoicing/renewals.ts sets app.renewal_drafting (tests aside)", () => {
    const setters = files(SRC)
      .filter((f) => !/\.(test|dbtest)\.tsx?$/.test(f))
      .filter((f) => readFileSync(f, "utf8").includes(GUC))
      .map((f) => relative(SRC, f).split(sep).join("/"))
      .sort();
    expect(setters).toEqual(["modules/invoicing/renewals.ts"]);
  });

  it("and it sets it for its own transaction only (set_config's third argument, true)", () => {
    const source = readFileSync(join(SRC, "modules", "invoicing", "renewals.ts"), "utf8");
    const sets = [...source.matchAll(/set_config\('app\.renewal_drafting',\s*'on',\s*(true|false)\)/g)].map((m) => m[1]);
    expect(sets).toEqual(["true"]);
  });
});
