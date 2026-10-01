import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * WHO MAY OPEN THE TWO FACTOR MARKERS (slice 83's fix-pass review).
 *
 * `./factor-guard` lets a code check against a live session, and a
 * backup-code reissue, through only inside a process-local marker — which
 * a request cannot set, so the whole control rests on WHO calls the two
 * openers. Each opener's caller does the work that makes the marker safe:
 * `verifyStepUpWithHeaders` spends the member's step-up budget first, and
 * the reissue action verifies a live code first. A third caller would
 * inherit the guard's trust without doing either, and nothing but this
 * test would notice. Deliberately crude, like the other tripwires: a
 * mention in a comment counts, and a reviewer should be asked why.
 */

const SRC = join(process.cwd(), "src");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name) ? [full] : [];
  });

/** Product source only: a test may open a marker to drive the door it guards. */
const product = walk(SRC).filter((f) => !/\.(test|dbtest)\.tsx?$/.test(f));
const rel = (f: string) => relative(SRC, f).split(sep).join("/");
const matching = (pattern: RegExp) =>
  product
    .filter((f) => pattern.test(readFileSync(f, "utf8")))
    .map(rel)
    .sort();
const naming = (name: string) => matching(new RegExp(`\\b${name}\\b`));
/** By CALL: the readers' names are also field names in ./factor-policy's inputs. */
const calling = (name: string) => matching(new RegExp(`\\b${name}\\(`));

describe("factor markers", () => {
  it("only the step-up helper opens the step-up marker", () => {
    expect(naming("runWithStepUpIntent")).toEqual(["auth/step-up-intent.ts", "auth/step-up.ts"]);
  });

  it("only the reissue action opens the reissue marker", () => {
    expect(naming("runWithReissueIntent")).toEqual([
      "app/(tenant)/(authed)/account/backup-codes-actions.ts",
      "auth/reissue-intent.ts",
    ]);
  });

  it("only the guard reads either", () => {
    expect(calling("hasStepUpIntent")).toEqual(["auth/factor-guard.ts", "auth/step-up-intent.ts"]);
    expect(calling("hasReissueIntent")).toEqual(["auth/factor-guard.ts", "auth/reissue-intent.ts"]);
  });

  // The file-level pins above cannot see a SECOND opener inside an allowed
  // file (the narrow review's low): an exported store, an `enterWith`, an
  // alias re-exported from step-up.ts, or a second unbudgeted call there.
  it.each(["step-up-intent.ts", "reissue-intent.ts"])("%s exports its opener and its reader, and opens the store once", (file) => {
    const source = readFileSync(join(SRC, "auth", file), "utf8");
    expect(source.match(/^export\s+.*$/gm)?.map((line) => line.replace(/[<(].*$/, "").trim())).toEqual([
      expect.stringMatching(/^export function runWith\w+Intent$/),
      expect.stringMatching(/^export function has\w+Intent$/),
    ]);
    expect(source.match(/\.run\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/\benterWith\b/);
  });

  it("the step-up opens its marker once, after spending the budget, and exports no alias of it", () => {
    const source = readFileSync(join(SRC, "auth", "step-up.ts"), "utf8");
    const opens = [...source.matchAll(/\brunWithStepUpIntent\(/g)];
    expect(opens).toHaveLength(1);
    const spend = source.indexOf('allow("auth.step_up"');
    expect(spend).toBeGreaterThan(-1);
    expect(spend).toBeLessThan(opens[0]!.index!);
    // Imported and called, never handed on.
    expect(source.match(/\brunWithStepUpIntent\b/g)).toHaveLength(2);
  });
});
