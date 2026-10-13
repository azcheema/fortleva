import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE NIGHTLY SEND'S RIGHT RESTS ON A CENSUS (Phase 4 slices 114, 114b; the
 * design review's §10.6, the code review's 3). The database lets the SYSTEM
 * principal take the bookkeeping file's lock, make a Fortnox file, write a
 * connection's upkeep columns and move a delivery ONLY while
 * `app.fortnox_sending` is on — and a delivery only under the run named by
 * `app.fortnox_run` (`integration_connection_guard`, migration 20261019090000;
 * `invoice_export_lock`, the export guards and `invoice_export_delivery_guard`,
 * migration 20261020090000). About fifty-five files run as SYSTEM, the
 * portal's brokers among them, so the right must be the sender's alone: ONE
 * file sets both, `src/modules/invoicing/fortnox-send.ts`. A second setter
 * must come with a reason, and a reviewer asks what it can now write.
 */

const ROOT = process.cwd();
/** Every tree that can open a transaction — the fixtures, scripts and the seed too (the security review's nit 7). */
const TREES = ["src", "e2e", "scripts", "prisma"].map((d) => join(ROOT, d));
const SENDER = "src/modules/invoicing/fortnox-send.ts";

function files(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
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

const settersOf = (guc: string): string[] =>
  TREES.flatMap(files)
    .filter((f) => !/\.(test|dbtest|spec)\.tsx?$/.test(f))
    .filter((f) => readFileSync(f, "utf8").includes(guc))
    .map((f) => relative(ROOT, f).split(sep).join("/"))
    .sort();

describe("who opens the nightly send's right", () => {
  it("only fortnox-send.ts sets app.fortnox_sending (tests aside)", () => {
    expect(settersOf("app.fortnox_sending")).toEqual([SENDER]);
  });

  it("only fortnox-send.ts names app.fortnox_run (tests aside)", () => {
    expect(settersOf("app.fortnox_run")).toEqual([SENDER]);
  });

  it("and it sets both for its own transaction only (set_config's third argument, true), in one place", () => {
    const source = readFileSync(join(ROOT, ...SENDER.split("/")), "utf8");
    const sending = [...source.matchAll(/set_config\('app\.fortnox_sending',\s*'on',\s*(true|false)\)/g)].map((m) => m[1]);
    const run = [...source.matchAll(/set_config\('app\.fortnox_run',\s*\$\{run\},\s*(true|false)\)/g)].map((m) => m[1]);
    expect(sending).toEqual(["true"]);
    expect(run).toEqual(["true"]);
  });
});
