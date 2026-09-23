import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// The browser harness talks to the REAL app against the REAL database,
// so it needs the same secrets the dev server and the DB suite use.
// Loaded here because the config module is evaluated first in both the
// runner and every worker, before any e2e file imports src/db.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

/**
 * End-to-end harness (PLAN.md Phase 2). Chromium only — this suite
 * exists to catch behaviour the unit and DB suites structurally cannot
 * see (a control that reverts in the DOM, a theme re-applied on mount),
 * not to certify browser coverage.
 *
 * The app is built and started for real: `next dev` re-mounts under
 * Strict Mode and would mask exactly the class of mount-time bug this
 * suite hunts. A cold build + start fits inside the 3-minute budget.
 *
 * Every fixture lives in a throwaway tenant (slug "e2e-…") that
 * global-setup provisions and global-teardown removes — see
 * e2e/fixtures/tenant.ts.
 */

const PORT = Number(process.env["E2E_PORT"] ?? 3000);
export const BASE_URL = process.env["E2E_BASE_URL"] ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  // One worker: the specs share one seeded tenant and mutate the same
  // documents, and serialised runs keep the audit trail readable.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"]
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  // 120 s, not 60: several specs assert against the database, and each
  // such assertion spawns a fresh tsx + Prisma process (the generated
  // client is ESM, so it cannot run inside the CJS test worker). Three
  // of those plus two full reloads exceeded a 60 s budget on a warm
  // machine, which would have flaked in CI rather than failed honestly.
  // The CI budgets were sized when CI ran against the EU database from a
  // US runner (~100 ms per query, a page is dozens of queries). Since
  // 2026-09-01 the e2e job brings its own Postgres container, so that
  // reason is gone and these two are almost certainly oversized — they
  // are left as HANG GUARDS rather than tuned blind, because no
  // measurement of the containerised job exists yet. Bring them toward
  // the local values once the first green run gives real numbers; the
  // per-walk visual budget was already cut by a third (900 s → 600 s)
  // in the same change.
  // The local budgets stay honest.
  timeout: process.env["CI"] ? 300_000 : 120_000,
  expect: { timeout: process.env["CI"] ? 30_000 : 10_000 },
  use: {
    baseURL: BASE_URL,
    // Copy assertions read the English catalogue; the Swedish one is
    // covered by the message-parity unit test.
    locale: "en-US",
    timezoneId: "Europe/Stockholm",
    storageState: "./.auth/member.json",
    // The app registers a service worker on every authed page
    // (`PwaRegister`), and Playwright's `page.route` does not own a request
    // a service worker's fetch handler has seen — its own note on `route`
    // says so and recommends exactly this setting. Measured 2026-09-17
    // (visibility.spec.ts "a failed change says so…", 2 of 20 local
    // repeats, traces compared): with the worker allowed, the aborted POST
    // sometimes hung ~4 s and was cancelled with net::ERR_ABORTED instead
    // of failing at once with net::ERR_FAILED, and the page's fetch promise
    // never settled — no toast, no revert, the optimistic value stuck. Every
    // spec that routes (visibility, item-properties, time) was exposed.
    // `pwa.spec.ts` re-allows the worker for the one test that registers it.
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm build && pnpm start",
    url: BASE_URL,
    reuseExistingServer: !process.env["CI"],
    // Cold: install-warm build (~25s) + Next boot, with headroom.
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    // Better Auth pins its baseURL and trustedOrigins to APP_URL
    // (src/config, INV-D2): the harness origin must be that origin, or
    // every sign-in POST is refused as cross-origin.
    // MAIL_DEV_OUTBOX: `next start` sets NODE_ENV=production, where the
    // mailer refuses the dev transport — which would make every
    // mail-sending FLOW untestable from a browser, not just the mail.
    // `inviteContact` sends AFTER its transaction commits, so pressing
    // Invite would write the row and then throw, and the acceptance
    // token exists nowhere but that message. See src/config's own note:
    // this is the only place in the repository that sets it.
    env: { APP_URL: BASE_URL, PORT: String(PORT), MAIL_DEV_OUTBOX: "1" },
  },
});
