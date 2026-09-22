import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    /**
     * VITEST'S DEFAULT IS 5 s AND SEVERAL OF THIS SUITE'S TRIPWIRES ARE
     * O(REPO SIZE) — `import-boundary.test.ts`, `portal-projections.test.ts`
     * and their siblings read and AST-parse every file under `src/`, so
     * their cost grows with every slice while the default budget does
     * not. Measured 2026-09-22 (slice 6c): `import-boundary` runs in
     * 2.0 s alone and TIMED OUT at 5 s under the full suite's
     * parallelism, having passed on the same machine an hour earlier —
     * about 1500 added lines was the difference.
     *
     * Raised rather than the scans narrowed, because a timeout is not an
     * assertion: nothing here is relaxed, and the failure mode this
     * prevents is the dangerous one — a whole-tree security tripwire
     * that starts going red for a reason it is not about, gets called
     * flaky, and gets deleted. 30 s is far past any honest scan and
     * still catches a real hang.
     */
    testTimeout: 30_000,
    /**
     * Paired with the above the way `vitest.db.config.ts` pairs its two,
     * and for the reason that config records: nothing here hoists a
     * whole-tree scan into a `beforeAll` TODAY, so this changes nothing
     * — and the day one does, it would time out at the 10 s default for
     * exactly the reason the comment above exists to prevent.
     */
    hookTimeout: 30_000,
  },
});
