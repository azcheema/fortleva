import { mkdirSync, rmSync } from "node:fs";

import { join } from "node:path";

import { chromium } from "@playwright/test";

import { sessionCookieName } from "../src/config";

import {
  AUTH_DIR,
  CONTACT_STORAGE_STATE,
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
  // out of range — a local run's sweep once deleted a live CI fixture
  // mid-run. The CI e2e job stopped being in range on 2026-09-01 (it has
  // its own service container now); what is still in range is another
  // LOCAL run and a dispatched `neon-smoke.yml`, whose ceiling is 75 min
  // — which is why the guard stays at 90 rather than dropping.
  const swept = await sweepStaleE2ETenants(90);
  if (swept > 0) console.log(`[e2e] swept ${swept} orphaned throwaway tenant(s)`);
  const { password, contactPassword, tenantSlug } = await provisionE2ETenant();
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

      // ── The CONTACT session (Phase 3) ────────────────────────────
      // Through the REAL endpoint, in a context of its own, for the same
      // reason the owner goes through the real form: a forged cookie
      // proves nothing about the plane that has to mint it. There is no
      // /portal/login FORM yet (the invite slice owns it), so this posts
      // to the sign-in route the portal instance actually mounts —
      // `context.request` shares the context's cookie jar, so the
      // Set-Cookie lands exactly where a browser's would.
      //
      // A SEPARATE CONTEXT, never a second cookie in the member jar: the
      // planes are separate tables with separate secrets, and a browser
      // holding both is a state the walk should not be inventing on its
      // own (the memo's §2.1 question, which the founder answered with
      // "View-as renders under the member's own session" — so no real
      // surface ever has two).
      const portal = await browser.newContext({ baseURL, locale: "en-US" });
      try {
        const signIn = await portal.request.post("/api/portal-auth/sign-in/email", {
          data: { email: seed.contactEmail, password: contactPassword },
        });
        if (!signIn.ok()) {
          // The body is Better Auth's deliberately constant refusal, so
          // it says nothing useful and nothing secret. The STATUS is the
          // diagnosis.
          throw new Error(`[e2e] portal sign-in failed: ${signIn.status()}`);
        }
        // The NAME comes from src/config — AGENTS.md's rule that no
        // cookie name lives outside it applies to the harness too, and a
        // literal here would silently stop asserting anything the day the
        // prefix changed.
        const cookieName = sessionCookieName("portal");
        const cookies = await portal.cookies();
        if (!cookies.some((c) => c.name === cookieName)) {
          throw new Error("[e2e] portal sign-in set no session cookie");
        }
        await portal.storageState({ path: CONTACT_STORAGE_STATE });
      } finally {
        await portal.close();
      }
    } finally {
      await browser.close();
    }
  } catch (e) {
    await teardownE2ETenant().catch(() => undefined);
    throw e;
  }
}
