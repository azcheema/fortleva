import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { moduleRefsOf, walkSourceFiles } from "./boundary-scan";

/**
 * NO BROWSER MODULE MAY REACH THE DATABASE CLIENT — through its OWN
 * import graph, not merely through its own import list.
 *
 * **This test exists because the same mistake landed twice in two
 * slices, and only one of the two was loud.** Slice 48's code review
 * found a `"use client"` component importing `@/config`, which shipped
 * the env schema's field names, the portal auth secret's derivation and
 * a full `crypto-browserify` polyfill into a **444 KB** browser chunk
 * evaluated on every page load; the build SUCCEEDED, which is why it
 * survived to a review. Slice 6a's portal request form imported two
 * length constants from `@/modules/work`, the barrel re-exported the
 * brokered writer, the writer imports `withTenant`, and `pnpm build`
 * died on `Module not found: Can't resolve 'util/types'` — `pg`
 * reaching for a Node builtin from a Client Component Browser trace.
 *
 * The second one was caught only because `pg` happens to need a builtin
 * with no browser shim. Nothing about the mistake guarantees that. So
 * the rule is made structural here: **a client module's transitive
 * import graph may not contain the database seam.**
 *
 * WHY A GRAPH AND NOT A GREP. Every version of this bug has been one
 * hop from innocent. `request-form.tsx` imported two numbers from a
 * barrel; `task-list.tsx` imports an array of four strings from the same
 * one. The file's own import list says `@/modules/work` in both cases
 * and tells you nothing — the answer is three or four modules further
 * in, and only a walk can give it.
 *
 * WHAT IT DOES NOT COVER, said plainly. It follows STATIC specifiers
 * that resolve inside `src/`: a computed `import(...)` is reported as
 * unresolvable rather than followed, and `node_modules` is not walked
 * (the seam is ours). `import type` is skipped, because it is erased
 * before any bundler sees it — which is also why a client module may
 * freely take a `type` from a server module, and several do.
 *
 * ITS COUSIN, `import-boundary.test.ts`, asks a different question:
 * *who may name `withPlatform`*. This one asks *what can reach a
 * database connection from a browser*. Neither implies the other: the
 * platform seam is about privilege, this is about what ships.
 */

const SRC = join(process.cwd(), "src");

/**
 * The seam, by FILE rather than by specifier: `@/db`, `@/db/index`,
 * `../../db` and `./client` all resolve to one of these, and resolving
 * first is what makes the alias spelling irrelevant.
 */
const SEAM_FILES = ["db/client.ts", "db/with-tenant.ts", "db/index.ts"] as const;

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

const rel = (abs: string): string => relative(SRC, abs).split(sep).join("/");

/** `@/x` → `src/x`; `./x` / `../x` → relative to the importer. */
const resolveSpecifier = (fromFile: string, specifier: string): string | null => {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = join(dirname(fromFile), specifier);
  else return null; // a package: not ours, not walked
  for (const ext of RESOLVE_EXTENSIONS) {
    if (existsSync(base + ext) && statSync(base + ext).isFile()) return base + ext;
  }
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const ext of RESOLVE_EXTENSIONS) {
      const index = join(base, `index${ext}`);
      if (existsSync(index) && statSync(index).isFile()) return index;
    }
  }
  // An exact path with its extension already written.
  if (existsSync(base) && statSync(base).isFile()) return base;
  return null;
};

const directive = (word: "client" | "server") =>
  new RegExp(`^\\s*(?://[^\\n]*\\n|/\\*[\\s\\S]*?\\*/\\s*)*["\']use ${word}["\']`);

const CLIENT_DIRECTIVE = directive("client");

/**
 * **`"use server"` IS A GRAPH BOUNDARY, NOT AN EDGE** — the correction
 * the first run of this test forced, and the distinction the whole check
 * turns on.
 *
 * A client component importing a server ACTION is the normal Next
 * pattern and ships nothing: the bundler replaces the import with a
 * reference to an endpoint, so `time-week.tsx → time/actions.ts →
 * i18n/resolve.ts → @/db` is a path through the SERVER, not into the
 * browser. The first cut of this file did not model that and reported
 * twelve such paths as defects — twelve correct files accused of
 * leaking a database, which is the "red for the wrong reason" failure
 * this repo has already paid for twice.
 *
 * What made slice 6a's real bug different is exactly this: the request
 * form imported `@/modules/work`, an ORDINARY module with no directive,
 * so there was no boundary for the bundler to cut at and the whole graph
 * — `portal-writes.ts`, `withTenant`, the Prisma client, `pg` — went
 * into the client chunk. The walk therefore stops at a `"use server"`
 * file and traverses everything else.
 */
const SERVER_DIRECTIVE = directive("server");

const isServerBoundary = (file: string): boolean =>
  SERVER_DIRECTIVE.test(readFileSync(file, "utf8"));

const isTest = (path: string): boolean => /\.(test|dbtest)\.[cm]?[jt]sx?$/.test(path);

/** Parsed once per file, whatever how many entries reach it. */
const refCache = new Map<string, string[]>();

/** The files this one pulls in at RUNTIME, resolved inside `src/`. */
const valueImportsOf = (file: string): string[] => {
  const cached = refCache.get(file);
  if (cached) return cached;
  const out: string[] = [];
  const source = readFileSync(file, "utf8");
  for (const ref of moduleRefsOf(source, file)) {
    // `import type` is erased before a bundler sees it.
    if (!ref.bindsValue) continue;
    // A computed specifier cannot be followed; its literal fragments are
    // the only static truth it carries, so those are tried instead.
    const specifiers = ref.computed ? (ref.literalParts ?? []) : [ref.specifier];
    for (const specifier of specifiers) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved) out.push(resolved);
    }
  }
  refCache.set(file, out);
  return out;
};

/** The first path from `entry` to a seam file, or null. */
const pathToSeam = (entry: string): string[] | null => {
  const seen = new Set<string>([entry]);
  const queue: { file: string; trail: string[] }[] = [{ file: entry, trail: [rel(entry)] }];
  while (queue.length > 0) {
    const { file, trail } = queue.shift()!;
    for (const next of valueImportsOf(file)) {
      if (seen.has(next)) continue;
      seen.add(next);
      const nextTrail = [...trail, rel(next)];
      if ((SEAM_FILES as readonly string[]).includes(rel(next))) return nextTrail;
      // The bundler cuts here; so does the walk.
      if (isServerBoundary(next)) continue;
      queue.push({ file: next, trail: nextTrail });
    }
  }
  return null;
};

/** `walkSourceFiles` answers in posix paths RELATIVE to `src/`; every
 *  walk below works in absolute ones, so they are joined once here. */
const clientEntries = (): string[] =>
  walkSourceFiles(SRC)
    .filter((f) => !isTest(f))
    .map((f) => join(SRC, f))
    .filter((f) => CLIENT_DIRECTIVE.test(readFileSync(f, "utf8")));

describe("the database seam never reaches a browser module", () => {
  it("there are client modules to check, so the walk cannot pass vacuously", () => {
    // The control. A change to how the directive is written — or to
    // `walkSourceFiles` — would otherwise turn the assertion below into
    // a loop over nothing, and it would still be green.
    expect(clientEntries().length).toBeGreaterThan(20);
  });

  it("the seam files are where this test thinks they are", () => {
    // The second control, and the one that matters more: if `@/db` were
    // renamed, every path below would stop ending at a listed file and
    // the test would report a clean bill of health for a codebase it had
    // stopped looking at.
    for (const seam of SEAM_FILES) expect(existsSync(join(SRC, seam)), seam).toBe(true);
  });

  it("no `use client` module's import graph reaches it", () => {
    const offences = clientEntries()
      .map((entry) => ({ entry, trail: pathToSeam(entry) }))
      .filter((r) => r.trail !== null)
      .map((r) => r.trail!.join(" → "));
    // The message IS the trail, because "this client file reaches the
    // database" without the hops is a sentence that sends the reader
    // back to the graph. Every version of this bug has been three or
    // four modules deep behind an innocent-looking barrel.
    expect(offences).toEqual([]);
  });

  it("stops at a `use server` module, because the bundler does", () => {
    // The other half of the rule, and the one that keeps this test
    // honest rather than merely strict. A client component importing a
    // server action is correct and ships nothing; if this walk did not
    // model the cut it would report a dozen correct files as leaks, and
    // a test that goes red for the wrong reason is a test people turn
    // off.
    const action = join(SRC, "app", "(portal)", "portal", "requests", "new", "actions.ts");
    expect(existsSync(action)).toBe(true);
    expect(isServerBoundary(action)).toBe(true);
    // ...and that action really does reach the seam, so the stop above
    // is doing work rather than describing an empty case.
    expect(pathToSeam(action)).not.toBeNull();
  });

  it("follows a MULTI-HOP path through a barrel — the walk is measured, not assumed", () => {
    // MUTATION CHECK, INLINE, and the first version of it did not plant
    // the shape it claimed (code review). It probed `portal-writes.ts`,
    // which imports `@/db` on its own second line — a ONE-hop trail
    // with no barrel in it — so a `resolveSpecifier` that had regressed
    // to following only direct imports would still have passed.
    //
    // Both real defects were three or four modules deep behind an
    // innocent-looking barrel, so that is what this plants: the server
    // action reaches the seam only THROUGH `@/modules/work`, and the
    // assertion requires both the length and the barrel by name.
    const action = join(SRC, "app", "(portal)", "portal", "requests", "new", "actions.ts");
    expect(existsSync(action)).toBe(true);
    const trail = pathToSeam(action);
    expect(trail, "the action reaches the seam — it opens the transaction").not.toBeNull();
    expect(trail!.length).toBeGreaterThanOrEqual(3);
    expect(trail).toContain("modules/work/index.ts");
    expect(trail!.at(-1)).toMatch(/^db\//);
  });

  it("sees a DIRECT import too, so the one-hop case is covered as well", () => {
    // The degenerate end of the same walk: `portal-writes.ts` imports
    // `@/db` on its own second line. Cheap, and it separates "the
    // resolver works at all" from "the resolver follows a chain", which
    // the multi-hop case above is what really pins.
    const probe = join(SRC, "modules", "work", "portal-writes.ts");
    expect(existsSync(probe)).toBe(true);
    expect(pathToSeam(probe)).toEqual(["modules/work/portal-writes.ts", "db/index.ts"]);
  });
});
