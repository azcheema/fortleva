import { expect, test, type Locator, type Page } from "@playwright/test";

import { STORAGE_STATE } from "./fixtures/tenant";

/**
 * THE BOOKKEEPING FILE IN A BROWSER (Phase 4 slice 111; founder decision C82).
 *
 *   - Invoices → Bookkeeping: before a method is chosen, the page says so and
 *     links to Settings.
 *   - Settings → Invoicing → Bookkeeping: "Book invoices" set to "When they're
 *     issued" — saved, toasted.
 *   - Back on Bookkeeping: what is new (the invoices and credit notes the
 *     earlier invoice specs issued), Make file → "File 1 is ready." and its
 *     row; the Fortnox file downloads as an SIE 4 import in code page 437
 *     (`#FLAGGA 0`, `#FORMAT PC8`, vouchers), the list as a workbook (a zip);
 *     then "Nothing new".
 *   - The method is fixed once a file exists: the settings card says so.
 *
 * The bookkeeping's rules — each event once, the cash method, the year cut,
 * the database's guards — are `src/modules/invoicing/bookkeeping.dbtest.ts`'s.
 *
 * Runs after `invoice-issue.spec.ts`, `invoice-send.spec.ts` and
 * `invoice-hours.spec.ts` (alphabetical, one worker), whose issued invoices it
 * files; before `invoices.spec.ts` and the visual walk, whose
 * `invoices-bookkeeping` stop then shows File 1.
 */

const toast = (page: Page, text: string | RegExp): Locator => page.locator("[data-sonner-toast]", { hasText: text });

test.describe.serial("the bookkeeping file", () => {
  test.use({ storageState: STORAGE_STATE, locale: "en-US" });

  test("asks for a method, makes a file, and hands over both downloads", async ({ page }) => {
    await page.goto("/invoices");
    await page.getByTestId("open-bookkeeping").click();
    await expect(page).toHaveURL(/\/invoices\/bookkeeping$/);
    await expect(page.getByRole("heading", { name: "Bookkeeping", level: 1 })).toBeVisible();
    // A CI retry finds the method chosen and the file made by the first
    // attempt (the code review's 8): each step runs only while it is due.
    const noMethod = page.getByTestId("bookkeeping-no-method");
    const files = page.getByTestId("bookkeeping-files");
    await expect(noMethod.or(page.getByTestId("bookkeeping-next")).or(page.getByTestId("bookkeeping-nothing"))).toBeVisible();
    if (await noMethod.isVisible()) {
      await expect(noMethod).toContainText("Choose how your company books invoices");
      await noMethod.getByRole("link", { name: "Choose in Settings" }).click();
      await expect(page).toHaveURL(/\/settings\/invoicing#bookkeeping$/);

      const card = page.getByTestId("bookkeeping-settings");
      await card.getByRole("button", { name: /^Edit Book invoices, currently/ }).click();
      const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
      await card.getByLabel("Book invoices", { exact: true }).selectOption({ label: "When they're issued (invoice method)" });
      await answered;
      await expect(toast(page, "Saved")).toBeVisible();
      await expect(card.getByRole("button", { name: "Edit Book invoices, currently When they're issued (invoice method)" })).toBeVisible();
      await page.goto("/invoices/bookkeeping");
    }

    const next = page.getByTestId("bookkeeping-next");
    if (await next.isVisible()) {
      await expect(next).toContainText("invoice");
      await next.getByTestId("bookkeeping-make").click();
      await expect(toast(page, /^File \d+ is ready\./)).toBeVisible();
    }
    await expect(page.getByTestId("bookkeeping-nothing")).toHaveText("Nothing new. Everything is in a file.");
    const row = files.getByTestId("bookkeeping-file").first();
    await expect(row).toBeVisible();
    const number = await row.getAttribute("data-number");

    // The Fortnox file: an SIE 4 import, in code page 437, as an attachment.
    const sieHref = await row.getByTestId("bookkeeping-sie").getAttribute("href");
    const sie = await page.request.get(sieHref!);
    expect(sie.status()).toBe(200);
    expect(sie.headers()["content-disposition"]).toContain(`filename="fortleva-fakt-${number}.si"`);
    expect(sie.headers()["cache-control"]).toContain("no-store");
    const body = (await sie.body()).toString("latin1");
    expect(body.startsWith("#FLAGGA 0\r\n#PROGRAM \"Fortleva\" 1.0\r\n#FORMAT PC8\r\n")).toBe(true);
    expect(body).toContain("#SIETYP 4\r\n");
    expect(body).toMatch(/#VER "F" "" \d{8} "Faktura \d+ /);

    // The list: a workbook (a zip).
    const xlsxHref = await row.getByTestId("bookkeeping-xlsx").getAttribute("href");
    const xlsx = await page.request.get(xlsxHref!);
    expect(xlsx.status()).toBe(200);
    expect(xlsx.headers()["content-type"]).toContain("spreadsheetml");
    expect((await xlsx.body()).subarray(0, 2).toString("latin1")).toBe("PK");

    // The method is fixed now.
    await page.goto("/settings/invoicing#bookkeeping");
    await expect(page.getByTestId("bookkeeping-settings")).toContainText("Fixed now that a bookkeeping file has been made.");
  });
});
