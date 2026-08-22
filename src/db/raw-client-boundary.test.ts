import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Belt two of the OTHER half of the one-seam rule (TENANCY.md §3): the
 * base Prisma client and the generated client are module-private to
 * `src/db`. Belt one is the ESLint `no-restricted-imports` rule — but a
 * file-level disable comment switches that off, and fourteen files in
 * `src` currently carry one. Nothing audited WHICH files, so the rule the
 * whole product rests on could be opted out of with one comment and no
 * alarm. Its `withPlatform` sibling (`import-boundary.test.ts`) has had
 * two belts since day one, deliberately, "so neither can drift alone";
 * this is the missing second belt for the raw client. It reads the files
 * itself, so a disable comment hides nothing from it, and it sees what a
 * lint rule cannot: dynamic import and re-export.
 *
 * The allowlist is the STATUS QUO, pinned — not a new permission. `auth/`
 * is in it because the auth layer is a sanctioned consumer of the raw
 * client (AGENTS.md says so, and the disable comment in `src/auth/index.ts`
 * cites TENANCY.md §6.3: AUTH-class tables are touched only by the auth
 * service path). Note that TENANCY.md §3 states the rule with NO auth
 * carve-out — that drift is the founder's to resolve; this test pins what
 * the code does today rather than deciding the policy.
 */

const SRC = join(process.cwd(), "src");

/** Path prefixes (posix, relative to src/) that MAY import the client directly. */
export const RAW_CLIENT_ALLOWED_PREFIXES = ["db/", "auth/"] as const;

/** Individual non-test files grandfathered (a fixture, cross-tenant by construction). */
export const RAW_CLIENT_ALLOWED_FILES = ["members/dbtest-fixture.ts"] as const;

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
  RAW_CLIENT_ALLOWED_PREFIXES.some((p) => rel.startsWith(p)) ||
  (RAW_CLIENT_ALLOWED_FILES as readonly string[]).includes(rel);

/** Block and line comments out, so prose naming the client does not count. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** `@/db/client`, `../db/client`, … */
const RAW_CLIENT = /^(?:@\/|.*\/)db\/client$/;

/** `@/generated/prisma/client`, … — a TYPE-only import of this one is fine (ESLint allows it). */
const GENERATED_CLIENT = /^(?:@\/|.*\/)generated\/prisma\/client$/;

/** Every `import … from "x"` and `export … from "x"`; group 1 is the clause, group 2 the source. */
const FROM_RE =
  /(?:^|\n)\s*(?:import|export)\s([\s\S]*?)\sfrom\s+["']([^"']+)["']/g;

const DYNAMIC_CLIENT_RE =
  /import\(\s*["'](?:@\/|[^"']*\/)(?:db\/client|generated\/prisma\/client)["']\s*\)/;

/**
 * Does the clause bind anything at RUNTIME? `import type { X }` and
 * `import { type A, type B }` do not — they vanish at compile time and
 * reach no database, which is why ESLint's `allowTypeImports` permits them.
 */
export const bindsValue = (clause: string): boolean => {
  const c = clause.trim();
  if (/^type\b/.test(c)) return false;
  const braces = /\{([\s\S]*)\}/.exec(c);
  const outside = c.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim();
  if (outside.length > 0) return true; // a default or `* as ns` binding
  if (!braces) return false;
  return (braces[1] ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .some((x) => !/^type\b/.test(x));
};

/** The client-reaching imports in one file's source. */
export const clientImportsIn = (source: string): string[] => {
  const code = stripComments(source);
  const hits: string[] = [];
  if (DYNAMIC_CLIENT_RE.test(code)) hits.push("dynamic import()");
  for (const m of code.matchAll(FROM_RE)) {
    // noUncheckedIndexedAccess: a matched group is `string | undefined`.
    const [, clause = "", from = ""] = m;
    if (RAW_CLIENT.test(from)) hits.push(from);
    else if (GENERATED_CLIENT.test(from) && bindsValue(clause)) hits.push(from);
  }
  return hits;
};

describe("one-seam rule: the base Prisma client is module-private to src/db", () => {
  const files = walk(SRC).map((f) => relative(SRC, f).split(sep).join("/"));

  it("the allowlist is pinned (review it with every phase)", () => {
    expect([...RAW_CLIENT_ALLOWED_PREFIXES]).toEqual(["db/", "auth/"]);
    expect([...RAW_CLIENT_ALLOWED_FILES]).toEqual(["members/dbtest-fixture.ts"]);
  });

  it("no file outside the allowlist reaches the client, disable comment or not", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      if (isAllowed(rel)) continue;
      const hits = clientImportsIn(readFileSync(join(SRC, rel), "utf8"));
      if (hits.length > 0) offenders.push(`${rel} → ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the grandfathered file still exists (remove the entry when it moves)", () => {
    for (const rel of RAW_CLIENT_ALLOWED_FILES) {
      expect(() => statSync(join(SRC, rel)), rel).not.toThrow();
    }
  });

  // The negative controls. A guard that has never been shown to fail is not
  // a guard — the board's 50-mover test tolerated 49 failures for exactly
  // this reason (PLAN §0, fourth review pass).
  it("catches what a disable comment hides from ESLint", () => {
    const disabled = `/* eslint-disable no-restricted-imports */
import { runtimeClient } from "@/db/client";`;
    expect(clientImportsIn(disabled)).toEqual(["@/db/client"]);
  });

  it("catches a relative path, a re-export and a dynamic import", () => {
    expect(clientImportsIn(`import { runtimeClient } from "../../db/client";`)).toHaveLength(1);
    expect(clientImportsIn(`export { runtimeClient } from "@/db/client";`)).toHaveLength(1);
    expect(clientImportsIn(`const c = await import("@/db/client");`)).toEqual(["dynamic import()"]);
  });

  it("catches a VALUE import of the generated client but allows a type-only one", () => {
    expect(clientImportsIn(`import { PrismaClient } from "@/generated/prisma/client";`)).toHaveLength(1);
    expect(clientImportsIn(`import type { Prisma } from "@/generated/prisma/client";`)).toEqual([]);
    expect(clientImportsIn(`import { type Prisma } from "@/generated/prisma/client";`)).toEqual([]);
  });

  it("does not fire on prose, or on a path that merely ends in client", () => {
    expect(clientImportsIn(`// import { runtimeClient } from "@/db/client";`)).toEqual([]);
    expect(clientImportsIn(`import { thing } from "@/modules/portal/client";`)).toEqual([]);
  });
});
