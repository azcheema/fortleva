import { expect, test, type Locator, type Page } from "@playwright/test";

import { STORAGE_STATE, readyYearEndWorkspace, requireSeed } from "./fixtures/tenant";

/**
 * THE CASH METHOD'S YEAR END IN A BROWSER (Phase 4 slice 111b; founder
 * decision C83). CI ONLY: a year end books invoices dated in a year that has
 * ended, and only the database's superuser owner can date one so —
 * `year-end-workspace` (`e2e/fixtures/seed-cli.ts`) answers `planted:false`
 * anywhere else (the dev database) and this file skips.
 *
 * It runs in the fixture owner's SECOND workspace: a year end needs the cash
 * method, and the first workspace is the invoice method's for good
 * (`invoices-bookkeeping.spec.ts`). The seed command RESETS it first, so a CI
 * retry finds it as the first attempt did.
 *
 *   - `/invoices` shows the reminder (C83 (a)), and its link opens the card;
 *   - the card lists the two invoices unpaid on the year's last day and their
 *     total, and says to mark every payment first;
 *   - Book the year end → the dialog → the toast naming the file, the file's
 *     row ("· year end"), the reminder gone, and the next file holding the two
 *     reversals.
 *
 * The year end's bookkeeping — which invoices, the vouchers, a late payment's
 * correction, the database's refusals — is `year-end.dbtest.ts`'s.
 */

const toast = (page: Page, text: string | RegExp): Locator => page.locator("[data-sonner-toast]", { hasText: text });

test.describe.serial("the year end", () => {
  test.use({ storageState: STORAGE_STATE, locale: "en-US" });

  // The workspace pointer lives on the SESSION ROW every spec shares
  // (`account.spec.ts`'s note): back to the first workspace after each test,
  // in a hook, which runs even after a test timeout.
  test.afterEach(async ({ page }) => {
    const seed = requireSeed();
    await page.goto("/dashboard");
    await page.getByRole("button", { name: `Open ${seed.tenantName}`, exact: true }).click();
    await page.waitForURL("**/home");
  });

  test("reminds, shows the unpaid invoices, and books the year end", async ({ page }) => {
    const seed = requireSeed();
    const ready = await readyYearEndWorkspace(seed.secondTenantId);
    // Skipped only OUTSIDE CI — in CI the seed fails loudly instead (its code review's 2).
    test.skip(!ready.planted && process.env["CI"] !== "true", "needs the database's superuser owner to plant a past year — CI only");
    expect(ready.planted, "CI plants the past year").toBe(true);
    const yearEnd = ready.yearEnd!;

    await page.goto("/dashboard");
    await page.getByRole("button", { name: `Open ${seed.secondTenantName}`, exact: true }).click();
    await page.waitForURL("**/home");

    // The reminder on /invoices, for the owner who makes the files.
    await page.goto("/invoices");
    const reminder = page.getByTestId("year-end-reminder");
    await expect(reminder).toContainText("The financial year ended on");
    await expect(reminder).toContainText("once every payment that came in by then is marked");
    await reminder.getByRole("link", { name: "Book the year end" }).click();
    await expect(page).toHaveURL(/\/invoices\/bookkeeping#year-end$/);

    // The card: both invoices, their total, the condition.
    const card = page.getByTestId("year-end");
    await expect(card).toHaveAttribute("data-year-end", yearEnd);
    await expect(card.getByTestId("year-end-invoice")).toHaveCount(2);
    await expect(card).toContainText("2 invoices");
    await expect(card).toContainText("Mark every payment that came in by");
    await expect(card.getByTestId("year-end-waiting")).toHaveCount(0);

    // Book it.
    await card.getByTestId("year-end-open").click();
    const dialog = page.getByTestId("year-end-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("2 unpaid invoices");
    await dialog.getByTestId("year-end-confirm").click();
    await expect(toast(page, /^The year end is booked in file \d+\.$/)).toBeVisible();
    await expect(dialog).toBeHidden();

    // The file's row names the year end; the card is gone; the new year's file holds the reversals.
    const row = page.getByTestId("bookkeeping-files").locator(`[data-year-end="${yearEnd}"]`);
    await expect(row).toContainText("· year end");
    await expect(page.getByTestId("year-end")).toHaveCount(0);
    await expect(page.getByTestId("bookkeeping-next")).toContainText("2 year-end entries reversed the next day");

    // And /invoices no longer reminds.
    await page.goto("/invoices");
    await expect(page.getByRole("heading", { name: "Invoices", level: 1 })).toBeVisible();
    await expect(page.getByTestId("year-end-reminder")).toHaveCount(0);
  });
});
