import { expect, test, type Page } from "@playwright/test";

import { isActionPost } from "./fixtures/actions";
import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * A CLIENT'S AGREEMENTS, EDITED READ-FIRST (Phase 4 slice 113; founder
 * decision C88): an agreement's price and renewal date now move renewal
 * dates on and (slice 113b) draft invoices, so both are editable on the
 * Agreements tab — every value text until pressed, saved through the row;
 * pause and run again on one click; ending and deleting ask first.
 *
 * As the OWNER. Every value is asserted after a full reload, so what is
 * checked is the stored row and not the DOM the edit left behind. The
 * services' guarantees — the gates, the scope, the kind's rules, the year
 * range, the job that moves dates on — are `agreement-renewals.dbtest.ts`'s;
 * this proves the screen reaches them. Everything happens inside the
 * throwaway e2e tenant and is removed by teardown.
 */

let seed!: E2ESeed;

test.beforeAll(() => {
  seed = requireSeed();
});

/**
 * The agreement this spec adds lives on the seed's OTHER client (the long
 * name): `settings.spec.ts` counts the main client's agreements in its rate
 * form, and a run that fails half-way (a retry adds a second) must not leave
 * one there (the code review).
 */
const tab = (clientId = seed.longClientId) => `/clients/${clientId}/agreements`;
const rowOf = (page: Page, name: string) => page.locator(`[data-testid="agreement-item"][data-name="${name}"]`);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test.describe("a client's Agreements tab (owner)", () => {
  test("add an agreement, edit its price and renewal date read-first, pause it, run it again, end it, delete it", async ({ page }) => {
    await page.goto(tab());
    const name = `E2E hosting ${Date.now()}`;
    await page.locator("#s-name").fill(name);
    await page.locator("#s-kind").selectOption("RECURRING");
    await page.locator("#s-interval").selectOption("MONTHLY");
    await page.locator("#s-price").fill("500");
    await page.locator("#s-renews").fill(inDays(40));
    await page.getByRole("button", { name: "Add service" }).click();
    await expect(page.getByText(`Added ${name}`)).toBeVisible();
    const row = rowOf(page, name);
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: /^Edit Price ex\. VAT, currently / })).toContainText("500");

    // The price: a button until pressed; Enter saves.
    await row.getByRole("button", { name: /^Edit Price ex\. VAT, currently / }).click();
    const priced = page.waitForResponse((res) => isActionPost(res.request()));
    await page.keyboard.type("650");
    await page.keyboard.press("Enter");
    await priced;
    await page.reload();
    await expect(rowOf(page, name).getByRole("button", { name: /^Edit Price ex\. VAT, currently / })).toContainText("650");

    // The renewal date: a date control, TYPED as a person types it (the
    // browser is en-US: month, day, year) — the row's form saves a date on
    // BLUR, and Enter blurs it. Not `fill`: on CI run 38267530088 a `fill`
    // then Enter closed the editor on the new date and posted NOTHING (the
    // form's focus snapshot already held the filled value), the one inline
    // date no other spec had exercised.
    const next = inDays(70);
    await rowOf(page, name).getByRole("button", { name: /^Edit Renews on, currently / }).click();
    const control = rowOf(page, name).locator('input[type="date"][name="renewsAt"]');
    await expect(control).toBeFocused();
    const dated = page.waitForResponse((res) => isActionPost(res.request()));
    const [y, m, d] = next.split("-");
    await page.keyboard.type(`${m}${d}${y}`);
    await expect(control).toHaveValue(next);
    await page.keyboard.press("Enter");
    await dated;
    await page.reload();
    // At rest the row carries the stored day in its hidden input (what it posts).
    await expect(rowOf(page, name).locator('input[type="hidden"][name="renewsAt"]')).toHaveValue(next);
    // …and the price survived the date's save (the row posts every field).
    await expect(rowOf(page, name).getByRole("button", { name: /^Edit Price ex\. VAT, currently / })).toContainText("650");

    // Pause and run again act on one click.
    await rowOf(page, name).getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Pause" }).click();
    await expect(rowOf(page, name).getByText("Paused", { exact: true })).toBeVisible();
    await rowOf(page, name).getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Run again" }).click();
    await expect(rowOf(page, name).getByText("Paused", { exact: true })).toHaveCount(0);

    // Ending asks first — it used to act on one click — and can't be undone.
    await rowOf(page, name).getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "End agreement" }).click();
    await expect(rowOf(page, name).getByText("Ended", { exact: true })).toHaveCount(0);
    await rowOf(page, name).getByRole("button", { name: "Yes" }).click();
    await expect(rowOf(page, name).getByText("Ended", { exact: true })).toBeVisible();
    // An ended agreement's end date is text now: the day it ended, kept.
    await expect(rowOf(page, name).getByRole("button", { name: /^Edit Ends on/ })).toHaveCount(0);
    await rowOf(page, name).getByRole("button", { name: `Actions for ${name}` }).click();
    await expect(page.getByRole("menuitem", { name: "Pause" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "End agreement" })).toHaveCount(0);

    // Delete asks first too.
    await page.getByRole("menuitem", { name: "Delete agreement" }).click();
    await rowOf(page, name).getByRole("button", { name: "Yes" }).click();
    await expect(rowOf(page, name)).toHaveCount(0);
  });

  test("a one-time agreement shows neither an interval nor a renewal date", async ({ page }) => {
    await page.goto(tab(seed.clientId));
    const migration = rowOf(page, "Migrering");
    await expect(migration).toBeVisible();
    // Billing is text, never a control (one keystroke must not clear a date).
    await expect(migration.getByText("One-time", { exact: true })).toBeVisible();
    await expect(migration.getByRole("button", { name: /^Edit Billing/ })).toHaveCount(0);
    await expect(migration.getByRole("button", { name: /^Edit Interval/ })).toHaveCount(0);
    await expect(migration.getByRole("button", { name: /^Edit Renews on/ })).toHaveCount(0);
  });
});
