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
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    // Copy assertions read the English catalogue; the Swedish one is
    // covered by the message-parity unit test.
    locale: "en-US",
    timezoneId: "Europe/Stockholm",
    storageState: "./.auth/member.json",
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
    env: { APP_URL: BASE_URL, PORT: String(PORT) },
  },
});
