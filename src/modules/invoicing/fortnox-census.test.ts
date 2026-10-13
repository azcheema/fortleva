import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE NIGHTLY SEND'S RIGHT RESTS ON A CENSUS (Phase 4 slice 114; the design
 * review's §10.6, the code review's 3). The database lets the SYSTEM principal
 * write a Fortnox connection's upkeep columns — and, from slice 114b, make a
 * bookkeeping file and record what Fortnox booked — ONLY while
 * `app.fortnox_sending` is on (`integration_connection_guard`, migration
 * 20261019090000). About fifty-five files run as SYSTEM, the portal's brokers
 * among them, so the right must be the sender's alone. Slice 114 has NO
 * sender: nothing outside the tests sets it. Slice 114b adds its one file here
 * on purpose, and a reviewer asks what it can now write.
 */

const SRC = join(process.cwd(), "src");
const GUC = "app.fortnox_sending";

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

describe("who opens the nightly send's right", () => {
  it("nothing outside the tests sets app.fortnox_sending yet (slice 114b names its sender here)", () => {
    const setters = files(SRC)
      .filter((f) => !/\.(test|dbtest)\.tsx?$/.test(f))
      .filter((f) => readFileSync(f, "utf8").includes(GUC))
      .map((f) => relative(SRC, f).split(sep).join("/"))
      .sort();
    expect(setters).toEqual([]);
  });
});
