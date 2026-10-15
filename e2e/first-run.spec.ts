import { expect, test, type Page } from "@playwright/test";

import { firstRunOn, requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * THE GETTING-STARTED LIST on Home (Phase 6 slice 121; founder decision
 * C97 (d)), through the owner's real session.
 *
 * IN THE SECOND WORKSPACE: the shared one has the list switched off by the
 * seed (its Home is other specs' counts and the visual walk's photographs),
 * while the second has only its owner and no task, so the list is there.
 * This file runs before `import.spec.ts`, which then gives that workspace a
 * client, a project and tasks. The workspace pointer is the SESSION's, so
 * every test switches there and the afterEach switches back.
 */

let seed!: E2ESeed;

test.beforeAll(() => {
  seed = requireSeed();
});

async function into(page: Page, name: string) {
  await page.goto("/dashboard");
  await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  await page.waitForURL("**/home");
}

test.beforeEach(async ({ page }) => {
  // On, whatever an earlier attempt's Hide left (a CI retry starts here).
  await firstRunOn(seed.secondTenantId);
  await into(page, seed.secondTenantName);
});

test.afterEach(async ({ page }) => {
  await into(page, seed.tenantName);
});

test("the list shows what is left to do, links each step, and Hide puts it away until Preferences brings it back", async ({ page }) => {
  const list = page.getByTestId("first-run");
  await expect(list).toBeVisible();
  // Only the owner, so inviting the team is still to do; a step links to where it is done.
  const team = list.locator('li[data-step="team"]');
  await expect(team).toHaveAttribute("data-done", "false");
  await expect(team.getByRole("link", { name: "Invite people" })).toHaveAttribute("href", "/members");
  // The client step is there; whether it is done depends on whether
  // `import.spec.ts` (which adds a client here) ran first, e.g. on a retry.
  await expect(list.locator('li[data-step="client"]')).toHaveCount(1);

  await page.getByTestId("first-run-hide").click();
  await expect(page.locator("[data-sonner-toast]", { hasText: "The getting-started list is hidden." })).toBeVisible();
  await expect(list).toHaveCount(0);

  await page.goto("/settings/preferences");
  const box = page.getByTestId("pref-onboarding-checklist");
  await expect(box).not.toBeChecked();
  await box.check();
  // The settings form saves on change; its success is the quiet "Saved" tick.
  await expect(page.locator("form", { has: box }).getByText("Saved")).toBeVisible({ timeout: 15_000 });
  await page.goto("/home");
  await expect(page.getByTestId("first-run")).toBeVisible();
});
