import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Belt two of the ARC-16 import boundary (TENANCY.md §12): the
 * cross-tenant seam (withPlatform / getPlatformClient) is reachable only
 * from the platform plane, jobs, src/db itself, tests and the seed.
 * Belt one is the ESLint override in eslint.config.mjs; this test pins
 * the SAME allowlist so neither can drift alone, and catches usages the
 * lint rule cannot see (dynamic import, re-export, string access).
 */

const SRC = join(process.cwd(), "src");

/** Path prefixes (posix, relative to src/) that MAY touch the seam. */
export const PLATFORM_SEAM_ALLOWED_PREFIXES = [
  "db/",
  "jobs/",
  "app/(platform)/",
] as const;

/** Individual files grandfathered (cross-tenant by construction). */
export const PLATFORM_SEAM_ALLOWED_FILES = [
  "members/invites.ts",
  "members/provisioning.ts",
  "members/dbtest-fixture.ts",
  // audit/record.ts only MENTIONS withPlatform in error messages — no import.
] as const;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "generated" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
};

const isTest = (rel: string): boolean => /\.(test|dbtest)\.ts$/.test(rel);
const isAllowed = (rel: string): boolean =>
  isTest(rel) ||
  PLATFORM_SEAM_ALLOWED_PREFIXES.some((p) => rel.startsWith(p)) ||
  (PLATFORM_SEAM_ALLOWED_FILES as readonly string[]).includes(rel);

/** An import/re-export line that names the seam. */
const IMPORT_RE =
  /^\s*(import|export)\b[^;]*\b(withPlatform|getPlatformClient)\b[^;]*\bfrom\s+["'][^"']+["']/m;
const DYNAMIC_RE = /import\(\s*["']@\/db(\/client|\/with-tenant)?["']\s*\)/;

describe("ARC-16 import boundary: withPlatform / getPlatformClient", () => {
  const files = walk(SRC).map((f) => relative(SRC, f).split(sep).join("/"));

  it("the allowlist is pinned (review with every phase)", () => {
    expect([...PLATFORM_SEAM_ALLOWED_PREFIXES]).toEqual(["db/", "jobs/", "app/(platform)/"]);
    expect([...PLATFORM_SEAM_ALLOWED_FILES]).toEqual([
      "members/invites.ts",
      "members/provisioning.ts",
      "members/dbtest-fixture.ts",
    ]);
  });

  it("no tenant-plane file imports the seam", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      if (isAllowed(rel)) continue;
      const src = readFileSync(join(SRC, rel), "utf8");
      // Strip block/line comments so prose mentioning the seam does not count.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (IMPORT_RE.test(code) || DYNAMIC_RE.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("the grandfathered files still exist (remove the entry when they move)", () => {
    for (const rel of PLATFORM_SEAM_ALLOWED_FILES) {
      expect(() => statSync(join(SRC, rel)), rel).not.toThrow();
    }
  });
});
