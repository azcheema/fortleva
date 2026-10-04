import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { moduleRefsOf, walkSourceFiles } from "@/db/boundary-scan";

/**
 * `withPlatform` IS UNREACHABLE FROM THE PORTAL'S ROUTES — one of Phase
 * 3V's owed non-negotiable tests (PLAN Phase 3V; SECURITY.md's "Credential
 * share links" row), written with the share links that made it urgent
 * (slice 90).
 *
 * `src/db/import-boundary.test.ts` asks WHO may name the seam. This asks a
 * different question: what a request to a portal route can REACH, through
 * its whole server import graph — because a share link is a bearer token
 * that crosses the portal boundary by design, and resolving it under the
 * RLS-bypassing seam would skip every policy at once. The share page
 * resolves its token under `withTenant(tenantId, {type:'system'})`; this
 * test is what keeps a later import from quietly changing that.
 *
 * THE WALK follows every VALUE import that resolves inside `src/` —
 * `"use server"` files included, since an action runs on the server with
 * the page — and skips `import type` (erased) and packages (not ours). A
 * file counts as REACHING THE SEAM when it binds `withPlatform` or
 * `getPlatformClient` by name, or grabs a seam module whole; `src/db/`
 * itself is the seam's home and is not counted (every graph reaches its
 * barrel for `withTenant`).
 *
 * THE ENTRIES are every file under `app/(portal)/` AND the root files that
 * render on the same request (`app/layout.tsx`, `app/not-found.tsx` — the
 * security review's nit: they run for a share page too).
 *
 * WHAT IS PINNED: the share route reaches the seam NOWHERE; and across
 * every portal route, the files that do are exactly the invitation's
 * token half (`clients/contact-invite-token.ts` — grandfathered in
 * `import-boundary.test.ts`, cross-tenant by construction: an invitee has
 * no tenant yet). A new entry is a decision, not a detail.
 */

const SRC = join(process.cwd(), "src");
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const SEAM_NAMES = new Set(["withPlatform", "getPlatformClient"]);
const SEAM_MODULE = /(^@\/db\/?$)|(\/db\/?$)|(\/db\/(index|with-tenant|client)(\.[cm]?[jt]sx?)?$)/;

const rel = (abs: string): string => relative(SRC, abs).split(sep).join("/");
const isTest = (path: string): boolean => /\.(test|dbtest)\.[cm]?[jt]sx?$/.test(path);

const resolveSpecifier = (fromFile: string, specifier: string): string | null => {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = join(dirname(fromFile), specifier);
  else return null;
  for (const ext of RESOLVE_EXTENSIONS) {
    if (existsSync(base + ext) && statSync(base + ext).isFile()) return base + ext;
  }
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const ext of RESOLVE_EXTENSIONS) {
      const index = join(base, `index${ext}`);
      if (existsSync(index) && statSync(index).isFile()) return index;
    }
  }
  if (existsSync(base) && statSync(base).isFile()) return base;
  return null;
};

type Scan = { readonly imports: readonly string[]; readonly seam: boolean };
const scans = new Map<string, Scan>();

const scan = (file: string): Scan => {
  const cached = scans.get(file);
  if (cached) return cached;
  const imports: string[] = [];
  let seam = false;
  for (const ref of moduleRefsOf(readFileSync(file, "utf8"), file)) {
    if (!ref.bindsValue) continue;
    const specifiers = ref.computed ? (ref.literalParts ?? []) : [ref.specifier];
    for (const specifier of specifiers) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved) imports.push(resolved);
      if (ref.names.some((n) => SEAM_NAMES.has(n))) seam = true;
      if (ref.names.includes("*") && SEAM_MODULE.test(specifier)) seam = true;
    }
  }
  const result = { imports, seam };
  scans.set(file, result);
  return result;
};

/** Every file outside `src/db/` that `entry`'s graph reaches and that reaches for the seam. */
const seamUsersFrom = (entry: string): string[] => {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  const users = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (!rel(file).startsWith("db/") && scan(file).seam) users.add(rel(file));
    for (const next of scan(file).imports) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...users].sort();
};

/** The root files every request to a portal page renders through. */
const ROOT_FILES = ["app/layout.tsx", "app/not-found.tsx"] as const;

const portalRouteFiles = (): string[] =>
  walkSourceFiles(SRC)
    .filter((f) => f.startsWith("app/(portal)/") && !isTest(f))
    .map((f) => join(SRC, f));

const rootFiles = (): string[] => ROOT_FILES.map((f) => join(SRC, f));

describe("withPlatform is unreachable from the portal's routes (Phase 3V, slice 90)", () => {
  it("the walk has routes to walk, and sees the seam where it is (controls)", () => {
    const files = portalRouteFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.map(rel)).toContain("app/(portal)/portal/share/[token]/page.tsx");
    // A graph that names the seam is seen: the invitation's token half.
    expect(seamUsersFrom(join(SRC, "clients", "contact-invite-token.ts"))).toEqual(["clients/contact-invite-token.ts"]);
    // ...and a file that only takes withTenant from the barrel is not.
    expect(scan(join(SRC, "modules", "vault", "share-open.ts")).seam).toBe(false);
    // The namespace grab is seen whatever the barrel's spelling.
    for (const spec of ["@/db", "@/db/", "@/db/index", "@/db/index.ts", "../db", "./db/with-tenant"]) {
      expect(SEAM_MODULE.test(spec), spec).toBe(true);
    }
    expect(SEAM_MODULE.test("@/db/context")).toBe(false);
    for (const root of rootFiles()) expect(existsSync(root), rel(root)).toBe(true);
  });

  it("the share route reaches the seam NOWHERE — its token resolves under withTenant", () => {
    const share = portalRouteFiles().filter((f) => rel(f).startsWith("app/(portal)/portal/share/"));
    expect(share.length).toBeGreaterThanOrEqual(3);
    for (const entry of [...share, ...rootFiles()]) expect(seamUsersFrom(entry), rel(entry)).toEqual([]);
  });

  it("across every portal route, only the invitation's token half reaches it (pinned)", () => {
    const users = new Set<string>();
    for (const entry of [...portalRouteFiles(), ...rootFiles()]) for (const u of seamUsersFrom(entry)) users.add(u);
    expect([...users].sort()).toEqual(["clients/contact-invite-token.ts"]);
  });
});
