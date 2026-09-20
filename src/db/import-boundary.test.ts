import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { moduleRefsOf, normalizeSpecifier, walkSourceFiles } from "./boundary-scan";

/**
 * Belt two of the ARC-16 import boundary (TENANCY.md §12): the
 * cross-tenant seam (withPlatform / getPlatformClient) is reachable only
 * from the platform plane, jobs, src/db itself, tests and the seed.
 * Belt one is the ESLint override in eslint.config.mjs; this test pins
 * the SAME allowlist so neither can drift alone, and catches dynamic
 * import (invisible to the lint rule) plus everything a file-level
 * disable comment would hide from it.
 *
 * Scans with the shared AST core (`boundary-scan.ts`) since 2026-08-31 —
 * the review of its regex sibling demonstrated that quoting, spacing and
 * comment tricks slipped the old patterns, and this file shared them.
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
  //
  // The PLATFORM AUDIT WRITER's single permitted importer. recordPlatformEvent
  // reaches app_platform (it is the only way to insert an audit row with
  // tenant_id NULL), so it is seam-grade and listed in SEAM_NAMES below.
  // One file may hold it, and that file does nothing but adapt the shared
  // auth hooks to it. If a second appears, decide deliberately whether the
  // plane really needs another writer before widening this list.
  "auth/platform-audit-hooks.ts",
] as const;

const isTest = (rel: string): boolean => /\.(test|dbtest)\.[cm]?[jt]sx?$/.test(rel);
const isAllowed = (rel: string): boolean =>
  isTest(rel) ||
  PLATFORM_SEAM_ALLOWED_PREFIXES.some((p) => rel.startsWith(p)) ||
  (PLATFORM_SEAM_ALLOWED_FILES as readonly string[]).includes(rel);

const SEAM_NAMES = new Set(["withPlatform", "getPlatformClient", "recordPlatformEvent"]);

/** The modules a namespace/dynamic/require grab reaches the seam through:
 * `@/db` (re-exports withPlatform), `db/with-tenant` (defines it), and
 * `db/client` (the raw client underneath everything). */
const SEAM_MODULE = /^(?:@\/db|.*\/db)(?:\/client|\/with-tenant|\/index)?$/;

/** The seam-reaching references in one file's source. */
export const seamUsagesIn = (source: string, fileName = "probe.ts"): string[] => {
  const hits: string[] = [];
  for (const ref of moduleRefsOf(source, fileName)) {
    if (ref.computed) {
      // Same two nets as the raw belt: the squash (concat/template
      // reassembly) and every string-literal fragment (ternary branches).
      const squashed = ref.specifier.replace(/[\s"'`+(){}$]/g, "");
      const candidates = [squashed, ...(ref.literalParts ?? [])];
      if (candidates.some((c) => SEAM_MODULE.test(normalizeSpecifier(c)))) {
        hits.push(`computed ${ref.kind} ${ref.specifier}`);
      }
    } else if (!ref.bindsValue) {
      continue;
    } else if (ref.names.some((n) => SEAM_NAMES.has(n))) {
      hits.push(`${ref.kind} { ${ref.names.filter((n) => SEAM_NAMES.has(n)).join(", ")} } from ${ref.specifier}`);
    } else if (SEAM_MODULE.test(normalizeSpecifier(ref.specifier)) && ref.names.includes("*")) {
      // A namespace import, `export *` or dynamic import of a seam module
      // hands over the whole namespace, withPlatform included.
      hits.push(`${ref.kind} * ${ref.specifier}`);
    }
  }
  return hits;
};

describe("ARC-16 import boundary: withPlatform / getPlatformClient", () => {
  const files = walkSourceFiles(SRC);

  it("the allowlist is pinned (review with every phase)", () => {
    expect([...PLATFORM_SEAM_ALLOWED_PREFIXES]).toEqual(["db/", "jobs/", "app/(platform)/"]);
    expect([...PLATFORM_SEAM_ALLOWED_FILES]).toEqual([
      "members/invites.ts",
      "members/provisioning.ts",
      "members/dbtest-fixture.ts",
      // Added 2026-09-11 with the platform-plane audit trail: the single
      // permitted importer of recordPlatformEvent, which is the only way
      // to write an audit row with tenant_id NULL.
      "auth/platform-audit-hooks.ts",
    ]);
  });

  it("no tenant-plane file imports the seam", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      if (isAllowed(rel)) continue;
      const source = readFileSync(join(SRC, rel), "utf8");
      for (const hit of seamUsagesIn(source, rel)) offenders.push(`${rel} → ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the grandfathered files still exist (remove the entry when they move)", () => {
    for (const rel of PLATFORM_SEAM_ALLOWED_FILES) {
      expect(() => statSync(join(SRC, rel)), rel).not.toThrow();
    }
  });

  // ── negative controls ─────────────────────────────────────────────

  it("catches the named import, the re-export and the mention-free namespace grab", () => {
    expect(seamUsagesIn(`import { withPlatform } from "@/db";`)).toHaveLength(1);
    expect(seamUsagesIn(`export { withPlatform } from "@/db";`)).toHaveLength(1);
    expect(seamUsagesIn(`import { getPlatformClient } from "@/db/with-tenant";`)).toHaveLength(1);
    expect(seamUsagesIn(`import * as db from "@/db";`)).toHaveLength(1);
    expect(seamUsagesIn(`const db = await import("@/db");`)).toHaveLength(1);
    expect(seamUsagesIn("const db = await import(`@/db/with-tenant`);")).toHaveLength(1);
    expect(seamUsagesIn(`const { withPlatform } = require("@/db");`)).toHaveLength(1);
    // The later-review evasions: a bare star re-export, an aliased grab,
    // a \u-escaped identifier, comment-split calls, and literal-only
    // computed assemblies of seam modules.
    expect(seamUsagesIn(`export * from "@/db";`)).toHaveLength(1);
    expect(seamUsagesIn(`import { withPlatform as wp } from "@/db";`)).toHaveLength(1);
    expect(seamUsagesIn('import { \\u0077ithPlatform } from "@/db";')).toHaveLength(1);
    expect(seamUsagesIn(`const db = await import/* split */("@/db");`)).toHaveLength(1);
    expect(seamUsagesIn(`import * as/* split */db from "@/db";`)).toHaveLength(1);
    expect(seamUsagesIn(`const db = await import("@/db/" + "index");`)).toHaveLength(1);
    expect(seamUsagesIn(`const db = await import("@/db/with-tenant/.." + "/with-tenant");`)).toHaveLength(1);
    expect(seamUsagesIn(`const db = await import(flag ? "@/db" : "@/lib/ids");`)).toHaveLength(1);
  });

  it("allows withTenant and prose", () => {
    expect(seamUsagesIn(`import { withTenant } from "@/db";`)).toEqual([]);
    expect(seamUsagesIn(`// withPlatform is platform-plane only`)).toEqual([]);
    expect(seamUsagesIn(`throw new Error("use withPlatform from the platform plane");`)).toEqual([]);
    expect(seamUsagesIn(`import type { PlatformActor } from "@/db";`)).toEqual([]);
  });
});

// ── The portal identity seam (Phase 3) ──────────────────────────────

/**
 * `portalAuthClient` is the only object in the product that can read a
 * `contact` row with no tenant context — the auth path's narrow
 * admission, described in src/db/portal-identity.ts. It is not
 * BYPASSRLS and it names exactly one row, but it is reached by
 * UNAUTHENTICATED requests, which is reason enough to hold it to the
 * recordPlatformEvent standard: one permitted importer, named here.
 *
 * It gets its own allowlist rather than joining SEAM_NAMES above,
 * because that list's prefixes (`jobs/`, `app/(platform)/`) have no
 * business with portal credentials and inheriting them would widen the
 * surface silently.
 */
export const PORTAL_IDENTITY_ALLOWED_FILES = ["auth/portal.ts"] as const;

const PORTAL_SEAM_NAMES = new Set(["portalAuthClient"]);
/**
 * Matches the module that DEFINES the seam and the barrel that
 * RE-EXPORTS it. `@/db` has to be in here, and leaving it out was the
 * hole both reviews of this slice found: the first version matched only
 * `…/portal-identity`, so `import * as db from "@/db"` bound the whole
 * namespace — `portalAuthClient` included — and neither branch fired.
 *
 * That is not theoretical. `src/auth/index.ts`, `platform.ts`,
 * `active-tenant.ts`, `factor-guard.ts` and `step-up.ts` all carry a
 * FILE-LEVEL `/* eslint-disable no-restricted-imports *\/`, so belt one
 * does not apply to them at all — and catching a file-level disable is
 * the stated reason belt two exists. A one-line namespace import in
 * `src/auth/platform.ts` would have handed the platform instance the
 * portal seam with both belts silent. The platform matcher 100 lines
 * above has always covered this shape; this one now matches it.
 */
const PORTAL_SEAM_MODULE = /^(?:@\/db|.*\/db)(?:\/portal-identity|\/index)?$/;

export const portalIdentityUsagesIn = (source: string, fileName = "probe.ts"): string[] => {
  const hits: string[] = [];
  for (const ref of moduleRefsOf(source, fileName)) {
    const spec = normalizeSpecifier(ref.specifier);
    if (ref.computed) {
      const squashed = ref.specifier.replace(/[\s"'`+(){}$]/g, "");
      const candidates = [squashed, ...(ref.literalParts ?? [])];
      if (candidates.some((c) => PORTAL_SEAM_MODULE.test(normalizeSpecifier(c)))) {
        hits.push(`computed ${ref.kind} ${ref.specifier}`);
      }
      continue;
    }
    if (!ref.bindsValue) continue;
    if (ref.names.some((n) => PORTAL_SEAM_NAMES.has(n))) {
      hits.push(`${ref.kind} { portalAuthClient } from ${ref.specifier}`);
    } else if (PORTAL_SEAM_MODULE.test(spec) && ref.names.includes("*")) {
      // A namespace import, `export *` or dynamic import of a seam
      // module hands over the whole namespace, portalAuthClient
      // included — the evasion the first version of this scan missed.
      hits.push(`${ref.kind} * ${ref.specifier}`);
    } else if (/(?:^|\/)portal-identity$/.test(spec)) {
      // Any value import of the defining module itself. `@/db` is NOT
      // in this branch: importing some other export of the barrel is
      // ordinary and must stay legal.
      hits.push(`${ref.kind} ${ref.specifier}`);
    }
  }
  return hits;
};

describe("portal identity boundary: portalAuthClient", () => {
  const files = walkSourceFiles(SRC);

  it("the allowlist is pinned (one importer — widen only deliberately)", () => {
    expect([...PORTAL_IDENTITY_ALLOWED_FILES]).toEqual(["auth/portal.ts"]);
  });

  it("only the portal auth instance reaches it", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      // Tests are NOT exempt here, deliberately, and that is a
      // difference from the platform belt above. Belt one (block A of
      // eslint.config.mjs) bars a test outside src/db from importing
      // the portal seam, so exempting them here would have the two
      // belts disagree — a future dbtest would hit a lint error this
      // file called fine (review). A test that genuinely needs the seam
      // lives in src/db and imports it relatively, as the two in this
      // slice do.
      if (rel.startsWith("db/")) continue; // defines and re-exports it
      if ((PORTAL_IDENTITY_ALLOWED_FILES as readonly string[]).includes(rel)) continue;
      const source = readFileSync(join(SRC, rel), "utf8");
      for (const hit of portalIdentityUsagesIn(source, rel)) offenders.push(`${rel} → ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the permitted importer still exists (remove the entry when it moves)", () => {
    for (const rel of PORTAL_IDENTITY_ALLOWED_FILES) {
      expect(() => statSync(join(SRC, rel)), rel).not.toThrow();
    }
  });

  it("catches the named import, the module grab and the reassembled specifier", () => {
    expect(portalIdentityUsagesIn(`import { portalAuthClient } from "@/db";`)).toHaveLength(1);
    expect(portalIdentityUsagesIn(`export { portalAuthClient } from "@/db";`)).toHaveLength(1);
    expect(portalIdentityUsagesIn(`import * as pi from "@/db/portal-identity";`)).toHaveLength(1);
    expect(portalIdentityUsagesIn(`const m = await import("@/db/portal-identity");`)).toHaveLength(1);
    expect(
      portalIdentityUsagesIn(`const m = await import("@/db/portal-" + "identity");`),
    ).toHaveLength(1);
    expect(portalIdentityUsagesIn(`import { portalAuthClient as c } from "@/db";`)).toHaveLength(1);
  });

  it("catches the namespace grab of the BARREL — the hole both reviews found", () => {
    // Each of these binds the whole `@/db` namespace, portalAuthClient
    // included, without ever naming it. The first version of this scan
    // matched none of them, and its negative-control block probed only
    // `@/db/portal-identity`, so it passed with the hole wide open.
    expect(portalIdentityUsagesIn(`import * as db from "@/db";`)).toHaveLength(1);
    expect(portalIdentityUsagesIn(`export * from "@/db";`)).toHaveLength(1);
    expect(portalIdentityUsagesIn(`const db = await import("@/db");`)).toHaveLength(1);
    expect(portalIdentityUsagesIn(`const { portalAuthClient } = require("@/db");`)).toHaveLength(1);
    expect(portalIdentityUsagesIn(`import * as db from "../db";`)).toHaveLength(1);
  });

  it("leaves the rest of the data layer alone", () => {
    expect(portalIdentityUsagesIn(`import { withTenant } from "@/db";`)).toEqual([]);
    expect(portalIdentityUsagesIn(`// portalAuthClient lives in src/db`)).toEqual([]);
    expect(portalIdentityUsagesIn(`import type { PortalIdentityRefused } from "@/db";`)).toEqual([]);
    // The PURE policy module is importable anywhere: it holds no client,
    // opens no connection and reaches no row.
    expect(
      portalIdentityUsagesIn(`import { assertWritable } from "@/db/portal-identity-policy";`),
    ).toEqual([]);
  });
});
