import { expect, test } from "@playwright/test";

import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * /projects/[key]/money in a browser (PLAN.md 2T screens; UI.md §3.1 —
 * a sub-view of the Time tab; UI.md rule 14 "cost is sensitive"): the
 * owner — rate:view_bill — reaches it from the Time tab and gets the
 * value tiles, and while the tenant's cost layer
 * (finance.costRates.enabled, off by default) is off there is no cost
 * control anywhere on the page, not even for the owner; the employee
 * gets neither the Time tab nor the page. Everything happens inside the
 * throwaway e2e tenant (fixtures/tenant.ts) and is removed by teardown.
 */

let seed!: E2ESeed;

test.beforeAll(() => {
  seed = requireSeed();
});

test.describe("project money (owner)", () => {
  test("the Time tab links to the money sub-view, which renders the value tiles; no cost control while the cost layer is off", async ({ page }) => {
    await page.goto(`/projects/${seed.projectKey}/time`);
    const tabs = page.locator('nav[data-slot="tab-strip"]');
    await expect(tabs.getByRole("link", { name: "Time", exact: true })).toHaveAttribute("aria-current", "page");
    await page.getByTestId("time-money-link").click();
    await page.waitForURL(/\/projects\/[^/]+\/money\?from=/);
    // A sub-view of Time: the tab strip has no Money tab and Time stays current.
    await expect(tabs.getByRole("link", { name: "Money", exact: true })).toHaveCount(0);
    await expect(tabs.getByRole("link", { name: "Time", exact: true })).toHaveAttribute("aria-current", "page");

    const tiles = page.getByTestId("money-tiles");
    await expect(tiles).toBeVisible();
    await expect(tiles.getByText("Billable hours")).toBeVisible();
    await expect(tiles.getByText("Value", { exact: true })).toBeVisible();
    // The ✦ half does not exist on the page until the tenant turns the
    // cost layer on — no tile, no reveal control, nothing to click.
    await expect(tiles.getByText("Internal cost")).toHaveCount(0);
    await expect(page.getByTestId("money-reveal-cost")).toHaveCount(0);
    await expect(page.getByText("Internal cost", { exact: true })).toHaveCount(0);

    // Month navigation keeps the view on the money page.
    await page.getByRole("link", { name: "Previous month" }).click();
    await page.waitForURL(/\/money\?from=\d{4}-\d{2}-01&to=/);
    await expect(page.getByTestId("money-tiles")).toBeVisible();
  });
});

test.describe("project money (employee)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill(seed.employeeEmail);
    await page.locator("#password").fill(seed.employeePassword);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("**/home", { timeout: 30_000 });
  });

  test("has no Time tab and the money page is the forbidden state", async ({ page }) => {
    await page.goto(`/projects/${seed.projectKey}`);
    const tabs = page.locator('nav[data-slot="tab-strip"]');
    await expect(tabs.getByRole("link", { name: "Overview" })).toBeVisible();
    await expect(tabs.getByRole("link", { name: "Time", exact: true })).toHaveCount(0);

    await page.goto(`/projects/${seed.projectKey}/money`);
    await expect(page.getByText("You do not have permission to see this project's money.")).toBeVisible();
    await expect(page.getByTestId("money-tiles")).toHaveCount(0);
  });
});
