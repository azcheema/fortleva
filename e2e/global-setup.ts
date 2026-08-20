import { mkdirSync, rmSync } from "node:fs";

import { join } from "node:path";

import { chromium } from "@playwright/test";

import {
  AUTH_DIR,
  STORAGE_STATE,
  provisionE2ETenant,
  requireSeed,
  sweepStaleE2ETenants,
  teardownE2ETenant,
} from "./fixtures/tenant";

/**
 * Provision the throwaway tenant, then sign its owner in through the
 * REAL login form (no cookie forgery: the session must come out of
 * Better Auth exactly as a person's would) and save the storage state.
 *
 * Playwright starts the webServer before global setup, so the form is
 * there to be filled. Any failure after provisioning tears the tenant
 * down immediately — global teardown would too, but a fixture must
 * never leave its cleanup to a later step.
 */
export default async function globalSetup(): Promise<void> {
  const baseURL = process.env["E2E_BASE_URL"] ?? "http://127.0.0.1:3000";
  // One clean screenshot set per run (e2e/visual.spec.ts writes here).
  // Done from global setup because Playwright recycles the worker after
  // a failing test, so the spec's own module scope runs more than once.
  rmSync(join(process.cwd(), ".design-shots"), { recursive: true, force: true });
  // Teardown is keyed on a seed file, so a killed run (or a webServer
  // that dies mid-suite) orphans its tenant. Sweep anything older than
  // 90 minutes before provisioning; a concurrent run is never in range.
  // 90 min, not 15: the age guard is what keeps a CONCURRENT run's tenant
  // out of range, and a run on the CI link (US runner, EU database) takes
  // 30+ min — a local run's sweep once deleted a live CI fixture mid-run.
  const swept = await sweepStaleE2ETenants(90);
  if (swept > 0) console.log(`[e2e] swept ${swept} orphaned throwaway tenant(s)`);
  const { password, tenantSlug } = await provisionE2ETenant();
  console.log(`[e2e] throwaway tenant ${tenantSlug} provisioned`);

  try {
    mkdirSync(AUTH_DIR, { recursive: true });
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ baseURL, locale: "en-US" });
      const page = await context.newPage();
      const seed = requireSeed();
      await page.goto("/login");
      await page.locator("#email").fill(seed.email);
      await page.locator("#password").fill(password);
      await page.locator('form button[type="submit"]').click();
      await page.waitForURL("**/home", { timeout: 30_000 });
      await context.storageState({ path: STORAGE_STATE });
      await context.close();
    } finally {
      await browser.close();
    }
  } catch (e) {
    await teardownE2ETenant().catch(() => undefined);
    throw e;
  }
}
