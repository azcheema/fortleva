import { expect, test, type Locator, type Page } from "@playwright/test";

import { acknowledgeNoticeIfShown } from "./fixtures/timer";
import { STORAGE_STATE, plantHours, requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * HOURS ONTO INVOICES IN A BROWSER (Phase 4 slice 110; founder decision C80).
 *
 *   - Four billable hours planted on the seed project, five weeks back.
 *   - Invoices → Ready to invoice lists the client; its page lists the hours,
 *     all selected; "One line per Task" previews "Övrigt arbete" (the client is
 *     Swedish, and project work has no task); one hour unchecked; Create
 *     invoice opens the draft with its line, marked as made from three entries.
 *   - The time grid's week shows those hours "On a draft invoice", and Delete
 *     asks with the sentence that the draft's line will not change (C80 (e)).
 *   - The hour left over is marked "Billed elsewhere" and then undone (C80 (g)).
 *
 * The rules underneath — rounding, the guards, crediting, the races — are the
 * dbtests' (`hours.dbtest.ts`). Runs before `invoice-issue.spec.ts` (one
 * worker, alphabetical) and issues nothing: the draft it makes stays a draft,
 * and its hours are five weeks back, out of every other time spec's weeks.
 */

const seed: E2ESeed = requireSeed();

const toast = (page: Page, text: string | RegExp): Locator => page.locator("[data-sonner-toast]", { hasText: text });

test.describe.serial("hours onto invoices", () => {
  test.use({ storageState: STORAGE_STATE, locale: "en-US" });

  let planted: { ids: string[]; day: string };

  test.beforeAll(async () => {
    planted = await plantHours(seed.tenantId, seed.projectId, seed.memberId, 4);
  });

  test("the ready list, the client's hours, lines by task, Create invoice", async ({ page }) => {
    await page.goto("/invoices");
    const row = page.getByTestId("ready-row").filter({ hasText: seed.clientName });
    await expect(row).toBeVisible();
    await row.getByRole("link", { name: seed.clientName }).click();
    await expect(page).toHaveURL(new RegExp(`/invoices/ready/${seed.clientId}`));

    const hours = page.getByTestId("hours-row");
    const rowOf = (id: string) => page.locator(`[data-testid="hours-row"][data-entry-id="${id}"]`);
    for (const id of planted.ids) await expect(rowOf(id)).toBeVisible();
    // Every waiting hour starts selected — the seed's own hours of this client too.
    await expect(hours.filter({ has: page.locator('input[type="checkbox"]:checked') })).toHaveCount(await hours.count());

    // Only three of the planted hours: everything else unchecked (the seed has
    // hours of its own here, at other rates), the fourth stays behind.
    for (const box of await hours.getByRole("checkbox").all()) await box.uncheck();
    for (const id of planted.ids.slice(0, 3)) await rowOf(id).getByRole("checkbox").check();

    // Lines by task: project work without a task is "Other work" — in the
    // client's language, Swedish — one line, 1 + 1,5 + 2 h at 1 000 SEK.
    await page.getByTestId("hours-grouping").selectOption("TASK");
    const preview = page.getByTestId("hours-preview-line");
    await expect(preview).toHaveCount(1);
    await expect(preview).toContainText("Övrigt arbete");
    await expect(preview).toContainText("4.5 h");
    await expect(page.getByTestId("hours-preview-total")).toContainText("4,500.00");

    await page.getByTestId("hours-create").click();
    await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 20_000 });
    const line = page.getByTestId("invoice-line").filter({ hasText: "Övrigt arbete" });
    await expect(line).toBeVisible();
    await expect(line.getByTestId("invoice-line-hours")).toContainText("3");
    await expect(page.getByTestId("invoice-hours").getByTestId("invoice-hour")).toHaveCount(3);
  });

  test("the time grid says the hour is on a draft invoice, and Delete says the line won't change", async ({ page }) => {
    await page.goto(`/time?w=${planted.day}`);
    await acknowledgeNoticeIfShown(page);
    const row = page.locator(`[data-testid="time-entry-row"][data-entry-id="${planted.ids[0]}"]`);
    await expect(row.getByTestId("entry-billing")).toHaveText("On a draft invoice");
    await row.getByRole("button", { name: /^Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(page.getByText("It's on a draft invoice, and the draft's line won't change.")).toBeVisible();
    await page.keyboard.press("Escape");
    // The hour left behind carries no badge.
    await expect(page.locator(`[data-testid="time-entry-row"][data-entry-id="${planted.ids[3]}"]`).getByTestId("entry-billing")).toHaveCount(0);
  });

  test("an hour marked billed elsewhere leaves the list, and Undo puts it back", async ({ page }) => {
    await page.goto(`/invoices/ready/${seed.clientId}`);
    const left = planted.ids[3]!;
    const rowOf = () => page.locator(`[data-testid="hours-row"][data-entry-id="${left}"]`);
    await expect(rowOf()).toBeVisible();
    // Only this one: the rest of the page's hours (other specs' or none) unchecked.
    for (const box of await page.getByTestId("hours-row").getByRole("checkbox").all()) await box.uncheck();
    await rowOf().getByRole("checkbox").check();
    await page.getByRole("button", { name: "Billed elsewhere" }).click();
    await page.getByRole("button", { name: "Yes" }).click();
    await expect(toast(page, "1 entry marked.")).toBeVisible();
    await expect(rowOf()).toHaveCount(0);
    const marked = page.locator(`[data-testid="marked-row"][data-entry-id="${left}"]`);
    await expect(marked).toHaveAttribute("data-mark", "BILLED_ELSEWHERE");

    await marked.getByRole("checkbox").check();
    await page.getByTestId("marked-undo").click();
    await expect(toast(page, "1 entry is back on the list.")).toBeVisible();
    await expect(rowOf()).toBeVisible();
  });
});
