import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { CONTACT_STORAGE_STATE, requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * THE WEBSITE SPEED CHARTS, through real sessions on both planes (Phase 6
 * slice 118; founder decision C94).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT: the whole vertical as people use
 * it — the Overview's Website speed card with Google's numbers for the
 * seeded project's site (the fake Google answers for `example.invalid`),
 * phones first and computers one tap away, the "Show to the client" switch
 * and its toast — and, on the contact's own session, the portal's Reports
 * page showing the charts while the switch is on and nothing of them while
 * it is off. The completed project, which has no Production URL, says what
 * to set.
 *
 * THE FIXTURE leaves the switch ON (`seed-cli`), so the visual walk and
 * View-as photograph the charts; the toggling test turns it off and back on.
 */

let seed!: E2ESeed;

test.beforeAll(() => {
  seed = requireSeed();
});

const toast = (page: Page, text: string | RegExp): Locator => page.locator("[data-sonner-toast]", { hasText: text });

async function contactPage(browser: Browser, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });
  const page = await context.newPage();
  await page.goto(path);
  await expect(page.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 });
  return { page, close: () => context.close() };
}

test.describe("the project's Website speed card (owner)", () => {
  test("shows Google's numbers for the site, phones first, computers one tap away — every metric with its band and its table twin", async ({ page }) => {
    await page.goto(`/projects/${seed.projectKey}`);
    const card = page.getByTestId("speed-card");
    await expect(card).toBeVisible();
    await expect(card.getByText("Measured: https://example.invalid")).toBeVisible();
    await expect(card.getByTestId("speed-device-phone")).toHaveAttribute("aria-current", "page");
    for (const metric of ["lcp", "inp", "cls"]) {
      const block = card.getByTestId(`speed-metric-${metric}`);
      await expect(block.getByTestId("speed-latest")).toHaveText(/\d/);
      await expect(block.locator('[data-slot="status-badge"][data-domain="speedBand"]')).toHaveText(/Good|Needs work|Poor/);
      await expect(block.locator("summary", { hasText: "Show as a table" })).toBeVisible();
    }
    await expect(card.getByTestId("speed-metric-lcp").getByRole("heading", { name: "How fast the page loads" })).toBeVisible();
    // Computers, one tap away: the same card, the other series.
    await card.getByTestId("speed-device-desktop").click();
    await page.waitForURL(/device=desktop/);
    await expect(page.getByTestId("speed-card").getByTestId("speed-device-desktop")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("speed-card").getByTestId("speed-metric-lcp").getByTestId("speed-latest")).toHaveText(/\d/);
  });

  test("a project with no Production URL says what to set", async ({ page }) => {
    await page.goto(`/projects/${seed.completedProjectKey}`);
    const card = page.getByTestId("speed-card");
    await expect(card.getByTestId("speed-state")).toContainText("Set the Production URL above");
    await expect(card.getByTestId("speed-metric-lcp")).toHaveCount(0);
  });

  test("the switch hides the charts from the client and shows them again — the contact's Reports page follows each press", async ({ page, browser }) => {
    await page.goto(`/projects/${seed.projectKey}`);
    const card = page.getByTestId("speed-card");
    await expect(card).toHaveAttribute("data-shown", "true");
    await expect(card.getByTestId("speed-sharing")).toHaveText("The client sees it under Reports in their portal.");

    // Off.
    await page.getByTestId("speed-switch").click();
    await expect(toast(page, "Hidden from the client.")).toBeVisible();
    await expect(page.getByTestId("speed-card")).toHaveAttribute("data-shown", "false");
    await expect(page.getByTestId("speed-card").getByTestId("speed-sharing")).toHaveText("Only your team can see it.");
    {
      const { page: portal, close } = await contactPage(browser, "/portal/reports");
      try {
        await expect(portal.getByTestId("portal-speed")).toHaveCount(0);
        await expect(portal.locator("main")).not.toContainText("example.invalid");
      } finally {
        await close();
      }
    }

    // On again (the fixture's state).
    await page.getByTestId("speed-switch").click();
    await expect(toast(page, "Shown to the client.")).toBeVisible();
    await expect(page.getByTestId("speed-card")).toHaveAttribute("data-shown", "true");
    {
      const { page: portal, close } = await contactPage(browser, "/portal/reports");
      try {
        const section = portal.getByTestId("portal-speed");
        await expect(section).toBeVisible();
        await expect(section.getByTestId("portal-speed-project")).toHaveCount(1);
        await expect(section.getByText("Measured by Google at https://example.invalid")).toBeVisible();
        await expect(section.getByTestId("speed-device-phone")).toHaveAttribute("aria-current", "page");
        await expect(section.getByTestId("speed-metric-lcp").getByTestId("speed-latest")).toHaveText(/\d/);
        // Nothing of the agency's leaks: no check date, no switch.
        await expect(portal.locator("main")).not.toContainText("Checked");
        await expect(portal.getByTestId("speed-switch")).toHaveCount(0);
        // Computers, one tap away, on the portal too.
        await section.getByTestId("speed-device-desktop").click();
        await portal.waitForURL(/device=desktop/);
        await expect(portal.getByTestId("portal-speed").getByTestId("speed-device-desktop")).toHaveAttribute("aria-current", "page");
      } finally {
        await close();
      }
    }
  });
});
