import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * EVERY auth after-hook body must sit inside `guarded()`.
 *
 * A static scan rather than a behavioural test, for a reason: the hooks
 * live in `audit-hooks.ts`, which reaches `@/db` and therefore the Prisma
 * client, so importing it needs DATABASE_URL — and the unit suite runs in
 * CI before `migrate deploy`, with nothing to connect to. The property is
 * structural anyway, and structure is what regressed.
 *
 * WHAT REGRESSED, so the next reader does not re-introduce it: until
 * 2026-09-11 `guarded()` wrapped only the EMITTER call. The handlers did
 * `internalAdapter.findUserByEmail(…)` and `ctx.getSignedCookie(…)`
 * outside it. Better Auth's `runAfterHooks` turns whatever an after-hook
 * throws into the RESPONSE — an APIError replaces an already-successful
 * one, anything else becomes a 500 — and by then the session row and
 * cookie are written. So the user was signed in and told they were not.
 * The cookie read runs on every successful two-factor sign-in and
 * verifies a signature against a shared secret, so a malformed cookie or
 * a rotated secret was enough. On the ops console, where a second factor
 * is mandatory, that path is the only way in.
 */

const SOURCE = readFileSync(join(process.cwd(), "src/auth/audit-hooks.ts"), "utf8");

/** Byte offsets of every `handler: createAuthMiddleware(` in the file. */
const handlerOffsets = (): number[] => {
  const needle = "handler: createAuthMiddleware(";
  const out: number[] = [];
  for (let i = SOURCE.indexOf(needle); i !== -1; i = SOURCE.indexOf(needle, i + 1)) {
    out.push(i + needle.length);
  }
  return out;
};

/** The handler's source, to the start of the next hook object. */
const bodyAt = (start: number): string => {
  const next = SOURCE.indexOf("matcher:", start);
  return SOURCE.slice(start, next === -1 ? SOURCE.length : next);
};

describe("auth after-hooks are wrapped in guarded()", () => {
  it("finds the hooks at all (the scan must not silently match nothing)", () => {
    // A scan that matches zero handlers passes vacuously and would hide
    // exactly the regression it exists to catch.
    expect(handlerOffsets().length).toBeGreaterThanOrEqual(2);
  });

  it("makes guarded() the FIRST thing every handler does", () => {
    // Comparing the position of `guarded(` against the first `await ` was
    // the first cut, and it was weaker than it read: it flagged the
    // perfectly correct `await guarded(…)` form, and it happily allowed an
    // unguarded SYNCHRONOUS statement before the wrapper — which is the
    // regression shape too, since a synchronous throw inside an after-hook
    // becomes the response just as an awaited one does. Match the opening
    // instead of racing two indices.
    for (const start of handlerOffsets()) {
      const body = bodyAt(start);
      const arrow = body.indexOf("=>");
      expect(arrow, `a handler has no arrow function:\n${body.slice(0, 200)}`).toBeGreaterThanOrEqual(0);

      const opening = body
        .slice(arrow + 2)
        .replace(/\/\/[^\n]*/g, "") // line comments
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^\{\s*/, "") // optional block body
        .replace(/^(?:return\s+|await\s+)+/, ""); // both are fine before guarded()

      expect(
        opening.startsWith("guarded("),
        "a handler does not open with guarded() — anything before it throws into " +
          "Better Auth's runAfterHooks and REPLACES the response:\n  opens with: " +
          opening.slice(0, 120),
      ).toBe(true);
    }
  });

  it("keeps guarded() catching everything and rethrowing nothing", () => {
    const from = SOURCE.indexOf("const guarded =");
    const to = SOURCE.indexOf("export type LoginMethod");
    // Unchecked anchors silently widen the slice to the whole file, at
    // which point the assertions below stop being about guarded() and
    // start passing for the wrong reason.
    expect(from, "anchor `const guarded =` not found").toBeGreaterThanOrEqual(0);
    expect(to, "anchor `export type LoginMethod` not found").toBeGreaterThan(from);

    const impl = SOURCE.slice(from, to);
    expect(impl).toContain("try {");
    expect(impl).toContain("catch");
    // A rethrow would defeat the wrapper entirely.
    expect(impl).not.toContain("throw");
  });
});
