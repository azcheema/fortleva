import { expect, test, type Page } from "@playwright/test";

import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * 2T in a browser (PLAN.md Phase 2T "Demo" + the 2026-08-20 D1/D2/D6
 * deltas): the staff notice gates the first timer; the quick start runs
 * a timer that the header pill shows ticking and stops; starting another
 * timer auto-stops the first and the toast offers UNDO; an instant
 * (project-less) task works; a break stops the running timer and the
 * day reconciles; a typed "1h 30m" entry lands in the week grid; and the
 * employee cannot reach the team view. Everything happens inside the
 * throwaway e2e tenant (fixtures/tenant.ts) and is removed by teardown.
 */

let seed!: E2ESeed;

test.beforeAll(() => {
  seed = requireSeed();
});

// The pill is mounted twice (desktop header slot + mobile slot); the
// desktop one comes first in the DOM and is the visible one at this viewport.
const pill = (page: Page) => page.getByTestId("timer-pill").first();
const idlePill = (page: Page) => page.getByTestId("timer-pill-idle").first();
const stopButton = (page: Page) => page.getByTestId("timer-pill-stop").first();
const elapsedClock = (page: Page) => page.getByTestId("timer-pill-elapsed").first();

async function acknowledgeNoticeIfShown(page: Page): Promise<void> {
  const ack = page.getByTestId("notice-acknowledge");
  if (await ack.isVisible().catch(() => false)) {
    await ack.click();
    await expect(ack).toHaveCount(0, { timeout: 15_000 });
  }
}

async function stopIfRunning(page: Page): Promise<void> {
  const stop = stopButton(page);
  if (await stop.isVisible().catch(() => false)) {
    await stop.click();
    await expect(idlePill(page)).toBeVisible({ timeout: 15_000 });
  }
}

test.describe("my time (owner)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/time");
    await expect(page.getByRole("heading", { name: "My time" })).toBeVisible();
    await acknowledgeNoticeIfShown(page);
    await stopIfRunning(page);
  });

  test("an instant task: quick start → the pill ticks → stop → the row is in the week", async ({ page }) => {
    await page.getByTestId("quick-start-description").fill("E2E instant task");
    await page.getByTestId("quick-start-start").click();
    await expect(pill(page)).toBeVisible({ timeout: 15_000 });
    await expect(pill(page)).toContainText("E2E instant task");

    // The elapsed clock moves (1 Hz from the server start instant).
    const elapsed = elapsedClock(page);
    const before = await elapsed.textContent();
    await expect.poll(async () => elapsed.textContent(), { timeout: 5_000 }).not.toBe(before);
    // The tab title mirrors it.
    await expect.poll(async () => page.title(), { timeout: 5_000 }).toMatch(/^\d+:\d\d:\d\d · /);

    await stopButton(page).click();
    await expect(idlePill(page)).toBeVisible({ timeout: 15_000 });
    const row = page.getByTestId("time-entry-row").filter({ hasText: "E2E instant task" });
    await expect(row.first()).toBeVisible();
    await expect(row.first()).toContainText("Not billable");
  });

  test("a project timer; starting another auto-stops it and the toast offers Undo", async ({ page }) => {
    await page.getByTestId("quick-start-project").selectOption(seed.projectId);
    await page.getByTestId("quick-start-description").fill("E2E project work");
    await page.getByTestId("quick-start-start").click();
    await expect(pill(page)).toContainText(seed.projectKey, { timeout: 15_000 });

    await page.getByTestId("quick-start-description").fill("E2E second timer");
    await page.getByTestId("quick-start-start").click();
    const toast = page.getByText(/was stopped/);
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(pill(page)).toContainText("E2E second timer");

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(pill(page)).toContainText(seed.projectKey, { timeout: 15_000 });
    await expect(pill(page)).not.toContainText("E2E second timer");

    await stopButton(page).click();
    await expect(idlePill(page)).toBeVisible({ timeout: 15_000 });
  });

  test("shift: clock in, a break stops the running timer, clock out", async ({ page }) => {
    await page.getByTestId("quick-start-description").fill("E2E before break");
    await page.getByTestId("quick-start-start").click();
    await expect(pill(page)).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("shift-clock-in").click();
    await expect(page.getByText("Clocked in", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("shift-start-break").click();
    await expect(page.getByText(/the running timer was stopped/)).toBeVisible({ timeout: 15_000 });
    await expect(idlePill(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("On break", { exact: true })).toBeVisible();

    await page.getByTestId("shift-end-break").click();
    await expect(page.getByText("Clocked in", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("shift-clock-out").click();
    await expect(page.getByText("Clocked out", { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test("a typed duration entry lands in the week grid", async ({ page }) => {
    await page.getByTestId("new-entry-duration").fill("1h 30m");
    await page.getByTestId("new-entry-description").fill("E2E manual entry");
    await page.getByTestId("new-entry-submit").click();
    const row = page.getByTestId("time-entry-row").filter({ hasText: "E2E manual entry" });
    await expect(row.first()).toBeVisible({ timeout: 15_000 });
    await expect(row.first()).toContainText("1h 30m");
  });
});

test.describe("as the employee", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill(seed.employeeEmail);
    await page.locator("#password").fill(seed.employeePassword);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("**/home", { timeout: 30_000 });
  });

  test("may track own time but cannot see the team view", async ({ page }) => {
    await page.goto("/time");
    await expect(page.getByRole("heading", { name: "My time" })).toBeVisible();
    await page.goto("/time/team");
    await expect(page.getByText("You do not have permission to see the team's time.")).toBeVisible();
  });
});
