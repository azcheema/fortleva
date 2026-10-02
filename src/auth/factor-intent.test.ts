import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * WHO MAY OPEN THE FACTOR MARKERS (slice 83's fix-pass review; the third
 * marker, slice 84).
 *
 * `./factor-guard` lets a code check against a live session, a backup-code
 * reissue and a factor replacement through only inside a process-local
 * marker — which a request cannot set, so the whole control rests on WHO
 * calls the openers. Each opener's caller does the work that makes the
 * marker safe: `verifyStepUpWithHeaders` spends the member's step-up
 * budget first, the reissue action verifies a live code first, and the
 * replacement action checks the password and then proves the current
 * factor through that same step-up. Another caller would
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

  // Slice 84 (C50): the third door — `enable` over an enrolled factor, for
  // the member who lost their phone. Its action checks the password, then
  // proves the current factor through the step-up, then opens this.
  it("only the replacement door opens the replacement marker", () => {
    expect(naming("runWithReplaceIntent")).toEqual(["auth/factor-replace.ts", "auth/replace-intent.ts"]);
  });

  it("only the guard reads them — and the limiter the replacement's, to spare its enable a second charge", () => {
    expect(calling("hasStepUpIntent")).toEqual(["auth/factor-guard.ts", "auth/step-up-intent.ts"]);
    expect(calling("hasReissueIntent")).toEqual(["auth/factor-guard.ts", "auth/reissue-intent.ts"]);
    expect(calling("hasReplaceIntent")).toEqual([
      "auth/factor-guard.ts",
      "auth/rate-limit-hook.ts",
      "auth/replace-intent.ts",
    ]);
    // …and the limiter's read exempts exactly the one path.
    const limiter = readFileSync(join(SRC, "auth", "rate-limit-hook.ts"), "utf8");
    expect(limiter.match(/hasReplaceIntent\(\)/g)).toHaveLength(1);
    expect(limiter).toMatch(/ctx\.path === "\/two-factor\/enable" && hasReplaceIntent\(\)/);
  });

  it("the replacement door checks the password, then proves the factor, and only then opens its marker — once", () => {
    // The order IS the control's cost to a member: the step-up CONSUMES a
    // backup code, so a password checked after it would burn one on every
    // typo (backup-codes-actions.ts has the trap). And the marker opened
    // before the proof would let the guard's stamp test do all the work.
    const source = readFileSync(join(SRC, "auth", "factor-replace.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const password = code.indexOf("auth.api.verifyPassword(");
    const proof = code.indexOf("verifyStepUpWithHeaders(");
    const opens = [...code.matchAll(/\brunWithReplaceIntent\(/g)];
    expect(password).toBeGreaterThan(-1);
    expect(proof).toBeGreaterThan(password);
    expect(opens).toHaveLength(1);
    expect(opens[0]!.index!).toBeGreaterThan(proof);
  });

  // The file-level pins above cannot see a SECOND opener inside an allowed
  // file (the narrow review's low): an exported store, an `enterWith`, an
  // alias re-exported from step-up.ts, or a second unbudgeted call there.
  it.each(["step-up-intent.ts", "reissue-intent.ts", "replace-intent.ts"])("%s exports its opener and its reader, and opens the store once", (file) => {
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
    const spend = source.indexOf('allowStrict("auth.step_up"');
    expect(spend).toBeGreaterThan(-1);
    expect(spend).toBeLessThan(opens[0]!.index!);
    // Imported and called, never handed on.
    expect(source.match(/\brunWithStepUpIntent\b/g)).toHaveLength(2);
  });
});
