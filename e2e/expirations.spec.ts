import { expect, test } from "@playwright/test";

import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * RENEWALS IN A BROWSER (Phase 3V slice 88): the rail's Renewals entry
 * opens `/expirations` — the fixture's lapsed licence under "Past their
 * date", its domain due in 20 days under "Within 30 days", its agreement
 * renewing in about 30 days somewhere in the feed (the boundary moves with
 * the clock, so not pinned to a group), the hosting 200 days out nowhere —
 * and a row leads to the asset's own line on the client's Assets tab. Home
 * draws the same rows in its "Renewals coming up" card.
 *
 * As the OWNER, with no authenticator: the feed never opens the vault's
 * door (C54 — logins are counted, never named, and the fixture's logins
 * carry no expiry, so the Logins card is not drawn). The feed's contents,
 * scope and gates are `expirations.dbtest.ts`'s.
 */

let seed!: E2ESeed;

test.beforeAll(() => {
  seed = requireSeed();
});

test.describe("renewals (owner)", () => {
  test("the rail opens /expirations: lapsed first, then the next 30 days; a row leads to the asset", async ({ page }) => {
    await page.goto("/home");
    await page.getByRole("navigation").getByRole("link", { name: "Renewals", exact: true }).first().click();
    await page.waitForURL(/\/expirations$/);
    await expect(page.getByRole("heading", { level: 1, name: "Renewals" })).toBeVisible();

    const lapsed = page.locator("#expirations-lapsed");
    const soon = page.locator("#expirations-soon");
    await expect(lapsed.getByTestId("expiration-row").filter({ hasText: "E2E Elementor Pro" })).toHaveCount(1);
    await expect(lapsed.getByTestId("expiration-cue").first()).toHaveText("Expired");
    const domain = soon.getByTestId("expiration-row").filter({ hasText: "e2e-acme.se" });
    await expect(domain).toHaveCount(1);
    await expect(domain.getByTestId("expiration-cue")).toHaveText(/^Expires in (19|20|21) days$/);
    // The agreement renewing in ~30 days is in the feed, as an agreement.
    await expect(page.locator(`[data-testid="expiration-row"][data-kind="agreementRenews"][data-name="${seed.serviceName}"]`)).toHaveCount(1);
    // 200 days out is past the 90-day window.
    await expect(page.getByTestId("expiration-row").filter({ hasText: "E2E website hosting" })).toHaveCount(0);
    // No fixture login has an expiry: no Logins card.
    await expect(page.getByTestId("expirations-logins")).toHaveCount(0);

    await domain.getByRole("link").click();
    await page.waitForURL(/\/clients\/[^/]+\/assets#asset-/);
    await expect(page.locator('[data-testid="asset-item"][data-name="e2e-acme.se"]')).toBeVisible();
  });

  test("Home's card shows what is due within 30 days and opens the page", async ({ page }) => {
    await page.goto("/home");
    const card = page.getByTestId("home-renewals");
    await expect(card.getByTestId("expiration-row").filter({ hasText: "E2E Elementor Pro" })).toHaveCount(1);
    await expect(card.getByTestId("expiration-row").filter({ hasText: "e2e-acme.se" })).toHaveCount(1);
    await expect(card.getByTestId("expiration-row").filter({ hasText: "E2E website hosting" })).toHaveCount(0);
    await page.getByRole("link", { name: "All renewals" }).click();
    await page.waitForURL(/\/expirations$/);
  });
});
