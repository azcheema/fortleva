import { expect, test, type Locator, type Page } from "@playwright/test";

import { SLOW } from "./fixtures/keys";
import { STORAGE_STATE, requireSeed, resetUpdateLayouts } from "./fixtures/tenant";

/**
 * PROGRESS-UPDATE LAYOUTS AND QUIET HOURS in a browser (Phase 5 slice 105;
 * founder decision C73).
 *
 * Layouts: the owner makes one in the dialog — Blockers left out, a heading
 * of their own moved up to follow Done, Hours unticked — makes it the workspace's
 * default, and a new update on the seeded project opens with exactly those
 * headings in that order and Hours unticked. The keyboard part only a browser
 * can measure: a moved heading keeps focus on its own button.
 *
 * Quiet hours: switching them on opens on 19:00–07:00, a changed hour and the
 * weekend tick survive a reload, and switching them OFF stays off — the form
 * posts the hour selects on that change too (the design review's M1).
 *
 * Both leave the workspace as they found it, pass or fail: the layouts reset
 * through the fixture CLI before and after (`updates.spec.ts` and the visual
 * sweep run after this file and expect Fortleva standard); quiet hours are
 * switched off again in `afterEach` (later specs expect the owner's mail).
 */

const seed = requireSeed();

test.use({ storageState: STORAGE_STATE, locale: "en-US" });

const toast = (page: Page, text: string | RegExp): Locator => page.locator("[data-sonner-toast]", { hasText: text });

/**
 * Do `act` and wait for the server action it fires to ANSWER. `AutoForm`
 * saves in a transition with no navigation, so a reload straight after the
 * change can cancel the save before it leaves the browser (the first run of
 * this file did exactly that); the action's own POST to the page is the
 * signal that it reached the server.
 */
async function saved(page: Page, path: string, act: () => Promise<void>): Promise<void> {
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === path);
  await act();
  await answered;
}

test.describe("update layouts", () => {
  test.beforeEach(async () => {
    await resetUpdateLayouts(seed.tenantId);
  });
  test.afterEach(async () => {
    await resetUpdateLayouts(seed.tenantId);
  });

  test("a layout made the default lays out the next new update: its headings, its order, its numbers", async ({ page }) => {
    const name = `Weekly check-in ${Date.now()}`;
    await page.goto("/settings/updates");
    await expect(page.getByRole("heading", { name: "Progress updates", level: 1 })).toBeVisible();
    await page.getByTestId("new-layout").click();
    const dialog = page.getByRole("dialog", { name: "New layout" });
    await expect(dialog).toBeVisible();

    await dialog.getByTestId("layout-name").fill(name);
    await dialog.getByTestId("layout-include-BLOCKERS").uncheck();
    await expect(dialog.getByTestId("layout-include-DONE")).toBeDisabled();
    await dialog.getByTestId("layout-add-heading").click();
    // The new heading's name takes the focus (no `autoFocus` — a layout effect).
    const own = dialog.getByTestId("layout-own-heading");
    await expect(own).toBeFocused();
    await own.fill("SEO this month");
    // Move it to just after Done (it was added last, after Decisions needed
    // and the unticked Blockers): three steps up, the focus staying on its
    // button each time.
    const up = dialog.getByRole("button", { name: "Move SEO this month up" });
    for (let i = 0; i < 3; i += 1) {
      await up.click();
      await expect(up).toBeFocused();
    }
    await dialog.getByTestId("layout-number-hours").uncheck();
    await dialog.getByTestId("layout-save").click();
    await expect(toast(page, "Layout created.")).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(dialog).toBeHidden();
    // The dialog hands focus back to the page's ONE "New layout" button, which
    // the first layout's arrival does not unmount (the code review's L3).
    await expect(page.getByTestId("new-layout")).toBeFocused();
    const row = page.getByTestId("layout-row").filter({ hasText: name });
    await expect(row).toContainText("Summary · Done · SEO this month · Next · Decisions needed");

    await saved(page, "/settings/updates", async () => {
      await page.getByTestId("default-layout").selectOption({ label: name });
    });
    await expect
      .poll(
        async () => {
          await page.reload();
          return page.getByTestId("layout-row").filter({ hasText: name }).getByText("Default").count();
        },
        { timeout: 20_000 * SLOW },
      )
      .toBe(1);

    await page.goto(`/projects/${seed.projectKey}/updates/new`);
    await expect(page.getByTestId("update-composer")).toBeVisible({ timeout: 30_000 });
    const order = await page
      .locator('[data-testid^="update-section-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(order).toEqual([
      "update-section-SUMMARY",
      "update-section-DONE",
      "update-section-custom-0",
      "update-section-NEXT",
      "update-section-DECISIONS_NEEDED",
    ]);
    await expect(page.getByText("SEO this month", { exact: true })).toBeVisible();
    await expect(page.getByTestId("include-hours")).not.toBeChecked();
    await expect(page.getByTestId("include-tasks")).toBeChecked();
  });
});

test.describe("quiet hours", () => {
  const PAGE = "/settings/notifications";
  const box = (page: Page) => page.getByTestId("quiet-hours");
  const weekends = (page: Page) => page.getByTestId("quiet-weekends");
  /** Reload until the page shows what was saved. */
  const settles = async (page: Page, read: () => Promise<unknown>, value: unknown) =>
    expect
      .poll(
        async () => {
          await page.reload();
          return read();
        },
        { timeout: 20_000 * SLOW },
      )
      .toEqual(value);

  test.afterEach(async ({ page }) => {
    // Pass or fail, the owner leaves with no quiet time: later specs expect
    // their mail to go at once.
    await page.goto("/settings/notifications");
    if (await weekends(page).isChecked()) {
      await saved(page, PAGE, () => weekends(page).uncheck());
      await settles(page, () => weekends(page).isChecked(), false);
    }
    if (await box(page).isChecked()) {
      await saved(page, PAGE, () => box(page).uncheck());
      await settles(page, () => box(page).isChecked(), false);
    }
  });

  test("on opens at 19:00–07:00; an hour and the weekend survive a reload; off stays off", async ({ page }) => {
    await page.goto("/settings/notifications");
    await expect(page.getByRole("heading", { name: "Quiet hours" })).toBeVisible();
    await expect(box(page)).not.toBeChecked();
    await expect(page.getByTestId("quiet-from")).toHaveCount(0);

    await saved(page, PAGE, () => box(page).check());
    await settles(page, () => page.getByTestId("quiet-from").inputValue(), "19");
    await expect(page.getByTestId("quiet-to")).toHaveValue("7");
    // The hour the other list holds cannot be chosen.
    await expect(page.getByTestId("quiet-to").locator('option[value="19"]')).toBeDisabled();

    await saved(page, PAGE, async () => {
      await page.getByTestId("quiet-to").selectOption("6");
    });
    await settles(page, () => page.getByTestId("quiet-to").inputValue(), "6");

    await saved(page, PAGE, () => weekends(page).check());
    await settles(page, () => weekends(page).isChecked(), true);

    // OFF while both hour lists are on the page — and they post with it.
    await saved(page, PAGE, () => box(page).uncheck());
    await settles(page, () => box(page).isChecked(), false);
    await expect(page.getByTestId("quiet-from")).toHaveCount(0);
  });
});
