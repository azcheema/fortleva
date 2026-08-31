import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SCAN_EXTENSIONS,
  isPrunedDir,
  launderedExportsOf,
  moduleRefsOf,
  normalizeSpecifier,
  walkSourceFiles,
} from "./boundary-scan";

/**
 * Belt two of the OTHER half of the one-seam rule (TENANCY.md §3): the
 * base Prisma client and the generated client are module-private to
 * `src/db`, with `src/auth` as the one sanctioned consumer (carve-out
 * ratified 2026-08-31; TENANCY.md §3 and AGENTS.md agree). Belt one is
 * the ESLint `no-restricted-imports` rule — but a file-level disable
 * comment switches that off, and it cannot see dynamic import at all.
 * This test reads the files itself, so a disable comment hides nothing.
 *
 * The scanning core is the TypeScript AST (`boundary-scan.ts`), not
 * regexes: the 2026-08-31 fresh-agent review of the regex version
 * demonstrated nine live evasions (backtick specifiers, `import (`,
 * no-whitespace clauses, mid-line imports, comment markers inside
 * strings, `require()`, deep generated entry points such as
 * `generated/prisma/internal/class` — which exports the raw client
 * constructor — `.mjs` files, and re-export laundering through an
 * exempt test file). Two further review rounds demonstrated more (a
 * dot-segment literal `@/db/client/../client` and its `./` sibling, a
 * literal-only template substitution, escaped specifiers, `import {}`
 * executing the module, `export default` laundering, product code
 * importing the grandfathered fixture, bare `export *`, comment-split
 * `import/* *\/(`) — every one a control below or in the sibling, and
 * the text prefilter those rounds kept defeating is GONE: every file
 * is parsed (see boundary-scan.ts).
 *
 * The allowlist is the STATUS QUO pinned — prefixes `db/` and `auth/`,
 * one grandfathered fixture, tests exempt (the sibling
 * `import-boundary.test.ts` convention). Three companion rules close
 * the exemption seams: ANY value import of ANY `generated/prisma/*`
 * module counts (type-only stays fine), a product file may not import
 * a `*.test`/`*.dbtest` module or the grandfathered fixture (the
 * laundering conduits), and an exempt file may consume the client but
 * not export it onward.
 */

const SRC = join(process.cwd(), "src");

/** Path prefixes (posix, relative to src/) that MAY import the client directly. */
export const RAW_CLIENT_ALLOWED_PREFIXES = ["db/", "auth/"] as const;

/** Individual non-test files grandfathered (a fixture, cross-tenant by construction). */
export const RAW_CLIENT_ALLOWED_FILES = ["members/dbtest-fixture.ts"] as const;

const isTest = (rel: string): boolean => /\.(test|dbtest)\.[cm]?[jt]sx?$/.test(rel);
const isAllowedPrefix = (rel: string): boolean =>
  RAW_CLIENT_ALLOWED_PREFIXES.some((p) => rel.startsWith(p));
const isGrandfathered = (rel: string): boolean =>
  (RAW_CLIENT_ALLOWED_FILES as readonly string[]).includes(rel);

/** `@/db/client`, `../db/client`, `@/db/client/../client`, … — matched on
 * the dot-segment-normalized specifier (the review slid a static
 * `../client` literal past a suffix-anchored regex). */
const RAW_CLIENT = /(^|\/)db\/client$/;

/** ANY entry point of the generated client — `@/generated/prisma/client`,
 * `@/generated/prisma/internal/class` (exports the constructor),
 * `@/generated/prisma/enums`, … A type-only import is fine everywhere
 * (ESLint's allowTypeImports); a VALUE import is the client. */
const GENERATED_PRISMA = /(^|\/)generated\/prisma(\/|$)/;

const isClientSpecifier = (spec: string): boolean => {
  const n = normalizeSpecifier(spec);
  return RAW_CLIENT.test(n) || GENERATED_PRISMA.test(n);
};

/** A product file importing a test module — or the grandfathered test
 * fixture — is the laundering conduit (the exempt file may consume the
 * client; product code may not consume the exempt file). */
const TEST_MODULE = /\.(test|dbtest)$|(^|\/)dbtest-fixture$/;

/**
 * The client-reaching references in one (non-exempt) file. Computed
 * specifiers are squashed (whitespace, quotes, `+`, parens removed) so a
 * simple concatenation reassembles; a specifier built from variables
 * stays out of reach of any static belt — accepted residual.
 */
export const clientImportsIn = (source: string, fileName = "probe.ts"): string[] => {
  const hits: string[] = [];
  for (const ref of moduleRefsOf(source, fileName)) {
    if (ref.computed) {
      // Two nets over a computed specifier: the squash (strips quotes,
      // `+`, `${}` — a concatenation or template reassembles) and every
      // string-literal FRAGMENT of the expression (a ternary branch, a
      // join() element). Each candidate goes through the same
      // normalize-then-match as a literal, including the conduit rule.
      const squashed = ref.specifier.replace(/[\s"'`+(){}$]/g, "");
      const candidates = [squashed, ...(ref.literalParts ?? [])];
      if (candidates.some((c) => isClientSpecifier(c) || TEST_MODULE.test(normalizeSpecifier(c)))) {
        hits.push(`computed ${ref.kind} ${ref.specifier}`);
      }
    } else if (isClientSpecifier(ref.specifier) && ref.bindsValue) {
      hits.push(ref.kind === "import" || ref.kind === "export-from" ? ref.specifier : `${ref.kind} ${ref.specifier}`);
    } else if (TEST_MODULE.test(normalizeSpecifier(ref.specifier)) && ref.bindsValue) {
      hits.push(`test-module import ${ref.specifier}`);
    }
  }
  return hits;
};

describe("one-seam rule: the base Prisma client is module-private to src/db", () => {
  const files = walkSourceFiles(SRC);

  it("the allowlist is pinned (review it with every phase)", () => {
    expect([...RAW_CLIENT_ALLOWED_PREFIXES]).toEqual(["db/", "auth/"]);
    expect([...RAW_CLIENT_ALLOWED_FILES]).toEqual(["members/dbtest-fixture.ts"]);
  });

  it("no file outside the allowlist reaches the client, and no exempt file launders it", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const source = readFileSync(join(SRC, rel), "utf8");
      if (isTest(rel) || isGrandfathered(rel)) {
        // Exempt from USING the client — not from handing it onward.
        for (const laundered of launderedExportsOf(source, rel, isClientSpecifier)) {
          offenders.push(`${rel} → launders the client: ${laundered}`);
        }
        continue;
      }
      if (isAllowedPrefix(rel)) continue;
      for (const hit of clientImportsIn(source, rel)) offenders.push(`${rel} → ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the grandfathered file still exists (remove the entry when it moves)", () => {
    for (const rel of RAW_CLIENT_ALLOWED_FILES) {
      expect(() => statSync(join(SRC, rel)), rel).not.toThrow();
    }
  });

  // ── negative controls ─────────────────────────────────────────────
  // A guard that has never been shown to fail is not a guard. One control
  // per demonstrated evasion of the regex version (2026-08-31 review).

  it("catches what a disable comment hides from ESLint", () => {
    const disabled = `/* eslint-disable no-restricted-imports */
import { runtimeClient } from "@/db/client";`;
    expect(clientImportsIn(disabled)).toEqual(["@/db/client"]);
  });

  it("catches a relative path, a re-export, a dynamic import and a side-effect import", () => {
    expect(clientImportsIn(`import { runtimeClient } from "../../db/client";`)).toHaveLength(1);
    expect(clientImportsIn(`export { runtimeClient } from "@/db/client";`)).toHaveLength(1);
    expect(clientImportsIn(`const c = await import("@/db/client");`)).toEqual(["dynamic @/db/client"]);
    expect(clientImportsIn(`import "@/db/client";`)).toEqual(["@/db/client"]);
  });

  it("catches the backtick specifier, the spaced call and a concatenated specifier", () => {
    expect(clientImportsIn("const c = await import(`@/db/client`);")).toEqual(["dynamic @/db/client"]);
    expect(clientImportsIn(`const c = await import ("@/db/client");`)).toEqual(["dynamic @/db/client"]);
    expect(clientImportsIn(`const c = await import("@/db/" + "client");`)).toHaveLength(1);
    expect(clientImportsIn(`const { runtimeClient } = require("@/db/client");`)).toEqual(["require @/db/client"]);
    expect(clientImportsIn(`import client = require("@/db/client");`)).toEqual(["require @/db/client"]);
  });

  it("catches imports no matter the spacing or position", () => {
    expect(clientImportsIn(`import{runtimeClient}from"@/db/client";`)).toEqual(["@/db/client"]);
    expect(clientImportsIn(`const a = 1; import { runtimeClient } from "@/db/client";`)).toEqual(["@/db/client"]);
  });

  it("catches the later-review evasions: dot segments, template substitution, escapes, empty braces", () => {
    expect(clientImportsIn(`import { runtimeClient } from "@/db/client/../client";`)).toHaveLength(1);
    expect(clientImportsIn(`import { runtimeClient } from "@/db/./client";`)).toHaveLength(1);
    expect(clientImportsIn("const c = await import(`@/db/${\"client\"}`);")).toHaveLength(1);
    expect(clientImportsIn(`const c = await import("@/db/" + "./client");`)).toHaveLength(1);
    // Escape sequences must survive into the probe text — the AST
    // decodes them (every file is parsed; no prefilter to slip).
    expect(clientImportsIn('import { runtimeClient } from "@/db/clien\\u0074";')).toHaveLength(1);
    expect(clientImportsIn('import { runtimeClient } from "@\\/db\\/client";')).toHaveLength(1);
    expect(clientImportsIn(`const c = await import/* split */("@/db/client");`)).toHaveLength(1);
    expect(clientImportsIn(`import {} from "@/db/client";`)).toEqual(["@/db/client"]);
    expect(clientImportsIn(`export {} from "@/db/client";`)).toEqual(["@/db/client"]);
    // A ternary of two plain literals is static truth, not a variable.
    expect(clientImportsIn(`const c = await import(flag ? "@/db/client" : "@/lib/ids");`)).toHaveLength(1);
    expect(clientImportsIn(`const c = await import(["@/db/client"].join(""));`)).toHaveLength(1);
    // PINNED RESIDUAL: a segment-by-segment join never carries the path
    // in any single fragment — same family as variable assembly, and
    // catchable only by evaluating the expression. Accepted; see the
    // residual note in boundary-scan.ts.
    expect(clientImportsIn(`const c = await import(["@", "db", "client"].join("/"));`)).toEqual([]);
  });

  it("flags a product file importing the grandfathered fixture", () => {
    expect(clientImportsIn(`import { fixture } from "@/members/dbtest-fixture";`)).toHaveLength(1);
    expect(clientImportsIn(`import type { Fixture } from "@/members/dbtest-fixture";`)).toEqual([]);
    // The conduit rule applies to computed specifiers too.
    expect(clientImportsIn(`const f = await import("@/members/" + "dbtest-fixture");`)).toHaveLength(1);
  });

  it("scans beyond .ts: the walker's extensions and prune rule are pinned", () => {
    expect(clientImportsIn(`import { runtimeClient } from "@/db/client";`, "x.mjs")).toHaveLength(1);
    expect(clientImportsIn(`const { runtimeClient } = require("@/db/client");`, "x.cjs")).toHaveLength(1);
    for (const f of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs"]) {
      expect(SCAN_EXTENSIONS.test(f), f).toBe(true);
    }
    expect(isPrunedDir("generated", "generated")).toBe(true);
    expect(isPrunedDir("modules/generated", "generated")).toBe(false);
    expect(isPrunedDir("modules/node_modules", "node_modules")).toBe(true);
  });

  it("is not fooled by comment markers inside strings", () => {
    expect(clientImportsIn(`const x = "a//b"; const c = await import("@/db/client");`)).toHaveLength(1);
    expect(clientImportsIn(`const g = "src/*"; import { runtimeClient } from "@/db/client"; /* later */`)).toHaveLength(1);
  });

  it("catches a VALUE import of ANY generated entry point but allows type-only ones", () => {
    expect(clientImportsIn(`import { PrismaClient } from "@/generated/prisma/client";`)).toHaveLength(1);
    expect(clientImportsIn(`import { getPrismaClientClass } from "@/generated/prisma/internal/class";`)).toHaveLength(1);
    expect(clientImportsIn(`import { ClientStatus } from "@/generated/prisma/enums";`)).toHaveLength(1);
    expect(clientImportsIn(`import type { Prisma } from "@/generated/prisma/client";`)).toEqual([]);
    expect(clientImportsIn(`import { type Prisma } from "@/generated/prisma/client";`)).toEqual([]);
    expect(clientImportsIn(`import type { ClientStatus } from "@/generated/prisma/enums";`)).toEqual([]);
    // A mixed clause binds a value.
    expect(clientImportsIn(`import { type Prisma, PrismaClient } from "@/generated/prisma/client";`)).toHaveLength(1);
  });

  it("flags a product file importing a test module (the laundering conduit)", () => {
    expect(clientImportsIn(`import { helper } from "@/members/some-fixture.dbtest";`)).toHaveLength(1);
    expect(clientImportsIn(`import type { T } from "@/members/some-fixture.dbtest";`)).toEqual([]);
  });

  it("flags an exempt file exporting the client onward", () => {
    const guarded = (s: string): boolean => isClientSpecifier(s);
    expect(launderedExportsOf(`export { runtimeClient } from "@/db/client";`, "x.dbtest.ts", guarded)).toHaveLength(1);
    expect(
      launderedExportsOf(
        `import { runtimeClient } from "@/db/client";\nexport { runtimeClient };`,
        "x.dbtest.ts",
        guarded,
      ),
    ).toHaveLength(1);
    expect(
      launderedExportsOf(
        `import { runtimeClient } from "@/db/client";\nexport const db = runtimeClient;`,
        "x.dbtest.ts",
        guarded,
      ),
    ).toHaveLength(1);
    expect(
      launderedExportsOf(
        `import { runtimeClient } from "@/db/client";\nexport default runtimeClient;`,
        "x.dbtest.ts",
        guarded,
      ),
    ).toEqual(["export default"]);
    expect(
      launderedExportsOf(`export const db = await import("@/db/client");`, "x.dbtest.ts", guarded),
    ).toHaveLength(1);
    expect(
      launderedExportsOf(
        `import { runtimeClient } from "@/db/client";\nexport let leak: unknown;\nleak = runtimeClient;`,
        "x.dbtest.ts",
        guarded,
      ),
    ).toHaveLength(1);
    // An alias hop is the same laundering split across two statements.
    expect(
      launderedExportsOf(
        `import { runtimeClient } from "@/db/client";\nconst c = runtimeClient;\nexport { c };`,
        "x.dbtest.ts",
        guarded,
      ),
    ).toHaveLength(1);
    expect(
      launderedExportsOf(`const c = await import("@/db/client");\nexport { c };`, "x.dbtest.ts", guarded),
    ).toHaveLength(1);
    // Consuming without exporting is the sibling convention — allowed.
    expect(
      launderedExportsOf(
        `import { runtimeClient } from "@/db/client";\nconst rows = runtimeClient.$queryRaw;`,
        "x.dbtest.ts",
        guarded,
      ),
    ).toEqual([]);
  });

  it("does not fire on prose, strings, template text or lookalike paths", () => {
    expect(clientImportsIn(`// import { runtimeClient } from "@/db/client";`)).toEqual([]);
    expect(clientImportsIn(`import { thing } from "@/modules/portal/client";`)).toEqual([]);
    // Import-shaped text inside a template literal is data, not an import
    // (the regex version reported this as an offender — false positive).
    expect(clientImportsIn("const t = `\nimport { c } from \"@/db/client\";\n`;")).toEqual([]);
    // A computed dynamic import that names something else entirely —
    // including one whose interpolated VARIABLE is literally named `db`.
    expect(clientImportsIn("const m = await import(`../messages/${locale}.json`);")).toEqual([]);
    expect(clientImportsIn("const m = await import(`./themes/${db}/client-colors`);")).toEqual([]);
  });
});
