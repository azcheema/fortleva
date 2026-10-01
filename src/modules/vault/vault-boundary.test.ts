import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { GUARDED_FACTOR_PATHS, factorMutationVerdict } from "@/auth/factor-policy";

/**
 * THE VAULT'S CIPHERTEXT HAS ONE READER (SECURITY.md §6.3, "Class split +
 * omit": belt two). `src/db/client.ts` omits the three ciphertext columns
 * from every read in the product; a call site gets one back only by
 * NAMING it — `omit: { secretCiphertext: false }`, or a `select` of it,
 * which Prisma also honours over a global omit. So the test is on the
 * NAME: outside the files below, no product source under `src/` may
 * mention a vault ciphertext column at all.
 *
 * Deliberately crude, like `enforcement.test.ts`: a mention in a comment
 * fails too, and that is the right way round — nobody types a column name
 * into another file by accident, and a reviewer should be asked why.
 *
 * THE NAME TEST ALONE WAS NOT ENOUGH (security review, 2026-10-01):
 * `readSecret` decrypts given a transaction and an id, with none of the
 * reveal path's gates, and a raw `SELECT * FROM credential_secret` names
 * no column. So, outside the module, nothing may import its internals
 * (only `@/modules/vault`, the index, whose exports all gate), and
 * nothing outside four allow-listed files may name the secret TABLES.
 * Both checks were tightened by the fix-pass review: an import is
 * RESOLVED against the importing file (`../vault/secret-store` from
 * another module is the same file as `@/modules/vault/secret-store`), and
 * names are matched without regard to case, because Postgres folds an
 * unquoted `CREDENTIAL_SECRET` to the same table.
 *
 * And the module itself never logs (the "log-scrub" half that a static
 * scan can carry; `vault.dbtest.ts` spies on the console through a whole
 * lifecycle for the other half): no `console.` anywhere in it.
 */

const SRC = join(process.cwd(), "src");
const COLUMNS = /\b(secretCiphertext|totpSecretCiphertext|secret_ciphertext|totp_secret_ciphertext)\b/i;

/** Files that may name the columns, and why. */
const ALLOWED = new Set([
  "modules/vault/secret-store.ts", // the one reader and writer
  "db/client.ts", // the global omit itself
  "export/manifest.ts", // the export's excluded columns
]);

/** The secret tables, by every spelling a reader or raw SQL would use. */
const TABLES = /\b(credential_secrets?|credential_versions?|credentialSecrets?|credentialVersions?)\b/i;

/** Infrastructure that must list every model, and so names these. */
const TABLES_ALLOWED = new Set([
  "modules/vault/secret-store.ts",
  "db/client.ts", // the global omit
  "db/model-registry.ts", // the census
  "export/manifest.ts", // the export's excluded columns
]);

/** Every module specifier in a file: static, re-export, dynamic, require. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "generated" ? [] : walk(full);
    return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name) ? [full] : [];
  });

const rel = (file: string) => relative(SRC, file).split(sep).join("/");
const isTest = (path: string) => /\.(test|dbtest)\.tsx?$/.test(path);

/**
 * Where a specifier in `fromFile` lands, as a path under `src/` without an
 * extension — or null for a package. `@/x` is `src/x`; a relative one is
 * resolved against the importing file's directory.
 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let abs: string;
  if (spec.startsWith("@/")) abs = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) abs = resolve(dirname(fromFile), spec);
  else return null;
  return rel(abs).replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, "");
}

/** A vault file other than the index (`modules/vault` or `modules/vault/index`). */
const isVaultInternal = (target: string | null): boolean =>
  target !== null && target.startsWith("modules/vault/") && target !== "modules/vault/index";

const importsOf = (file: string, text: string): (string | null)[] =>
  [...text.matchAll(SPECIFIER)].map((m) => resolveSpecifier(file, m[1]!));

describe("vault ciphertext boundary", () => {
  const files = walk(SRC).filter((f) => !isTest(rel(f)));

  it("no product file outside the allow-list names a vault ciphertext column", () => {
    const offenders = files.filter((f) => !ALLOWED.has(rel(f)) && COLUMNS.test(readFileSync(f, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("every allow-listed file exists and still names a column (the list is not stale)", () => {
    for (const path of ALLOWED) {
      expect(COLUMNS.test(readFileSync(join(SRC, path), "utf8")), path).toBe(true);
    }
  });

  it("nothing outside the vault module imports its internals — the index only", () => {
    const outside = files.filter((f) => !rel(f).startsWith("modules/vault/"));
    const offenders = outside.filter((f) => importsOf(f, readFileSync(f, "utf8")).some(isVaultInternal)).map(rel);
    expect(offenders).toEqual([]);
  });

  it("the secret tables are named only by the secret store and three infrastructure files", () => {
    const offenders = files.filter((f) => !TABLES_ALLOWED.has(rel(f)) && TABLES.test(readFileSync(f, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("the boundary patterns bite (controls)", () => {
    const fromWork = join(SRC, "modules", "work", "x.ts");
    const fromModules = join(SRC, "modules", "x.ts");
    const fromApp = join(SRC, "app", "(tenant)", "page.tsx");
    const internal = (file: string, code: string) => importsOf(file, code).some(isVaultInternal);
    expect(internal(fromApp, `import { readSecret } from "@/modules/vault/secret-store";`)).toBe(true);
    expect(internal(fromWork, `import { readSecret } from "../vault/secret-store";`)).toBe(true);
    expect(internal(fromModules, `export * from "./vault/budget";`)).toBe(true);
    expect(internal(fromApp, `const m = await import("@/modules/vault/secret-store");`)).toBe(true);
    expect(internal(fromApp, `import "@/modules/vault/totp";`)).toBe(true);
    expect(internal(fromApp, `import { revealCredentialField } from "@/modules/vault";`)).toBe(false);
    expect(internal(fromWork, `import { x } from "../vault";`)).toBe(false);
    expect(internal(fromWork, `import { x } from "../vault/index";`)).toBe(false);
    // …and the tripwire's own test sees an import of the INDEX as reaching the vault.
    expect(importsOf(fromApp, `import { revealCredentialField } from "@/modules/vault";`)).toEqual(["modules/vault"]);
    expect(TABLES.test("SELECT * FROM credential_secret")).toBe(true);
    expect(TABLES.test("SELECT * FROM CREDENTIAL_SECRET")).toBe(true);
    expect(TABLES.test("tx.credentialVersion.findMany()")).toBe(true);
    expect(TABLES.test("replaceCredentialSecret(ctx)")).toBe(false);
    expect(TABLES.test("include: { credentialSecrets: true }")).toBe(true);
    expect(COLUMNS.test("SELECT SECRET_CIPHERTEXT FROM x")).toBe(true);
  });

  it("the index exports only the gated services — never the store, the budget, the scope or the raw TOTP", () => {
    const index = join(SRC, "modules", "vault", "index.ts");
    const targets = importsOf(index, readFileSync(index, "utf8"));
    expect(targets.sort()).toEqual(["modules/vault/ctx", "modules/vault/fields", "modules/vault/items", "modules/vault/reveal"]);
    // ctx is re-exported for its TYPE only.
    expect(readFileSync(index, "utf8")).toMatch(/export type \{ VaultCtx \} from "\.\/ctx";/);
  });

  it("the vault module never logs", () => {
    const vault = files.filter((f) => rel(f).startsWith("modules/vault/"));
    expect(vault.length).toBeGreaterThan(5);
    const loggers = vault.filter((f) => /\bconsole\s*\./.test(readFileSync(f, "utf8"))).map(rel);
    expect(loggers).toEqual([]);
  });

  /**
   * THE ORDER OF THE NEXT TWO SLICES, ENFORCED (fix-pass review). Until
   * slice 83, a MEMBER may read their authenticator's seed with the
   * password alone (`/two-factor/get-totp-uri`, `src/auth/factor-policy.ts`),
   * which defeats every step-up the vault relies on. Nothing reaches the
   * vault from a page or route today; the day something does, this fails
   * unless the member's factor is protected by then.
   */
  it("nothing reaches the vault while a member can mint, read or remove a factor with the password alone", () => {
    // EVERY guarded path (narrow review): reading the seed, swapping the
    // factor, removing it, or reissuing backup codes — a backup code also
    // passes the vault's step-up (`src/auth/step-up.ts`).
    const open = [...GUARDED_FACTOR_PATHS].filter(
      (path) =>
        factorMutationVerdict({
          path,
          hasSession: true,
          isPlatformPrincipal: false,
          hasVerifiedFactor: true,
          hasReissueIntent: false,
          mfaVerifiedAt: null,
          now: Date.now(),
        }) === "allow",
    );
    // PINNED, so nothing disarms this silently (third narrow review). The
    // live guard (`src/auth/factor-guard.ts`) builds this policy's input and
    // today passes `hasVerifiedFactor: false` for every member, so a fix in
    // the policy alone would close nothing: slice 83 must change THIS list
    // deliberately, and prove the GUARD closes each path, not only the policy.
    expect(open.sort()).toEqual([
      "/two-factor/disable",
      "/two-factor/enable",
      "/two-factor/generate-backup-codes",
      "/two-factor/get-totp-uri",
    ]);
    // EVERY importer outside the module, not only pages: a helper a route
    // imports would reach the vault just the same.
    const reaching = files.filter(
      (f) => !rel(f).startsWith("modules/vault/") && importsOf(f, readFileSync(f, "utf8")).some((t) => t !== null && t.startsWith("modules/vault")),
    );
    if (open.length > 0) expect(reaching.map(rel), `open factor paths: ${open.join(", ")}`).toEqual([]);
  });
});
