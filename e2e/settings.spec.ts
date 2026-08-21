import { expect, test } from "@playwright/test";

import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * The 2T settings surfaces in a browser (PLAN.md 2T screens; UI.md §3.1
 * "Settings", rule 12, rule 14): /settings/rates lists the seeded bill
 * cards, adds a member card with the pinned rate-change wording in the
 * toast and closes it again; the COST half is offered only behind a
 * two-factor confirmation (the owner has no factor enrolled, so the
 * section shows the confirm link and no amounts); /settings/time shows
 * the acknowledgment table and manages work types (add, rename inline,
 * archive, restore); the client's Agreements tab shows the seeded
 * agreement with its rate and the agreement-rate cards. The employee
 * (no rate:view_bill, no settings:view) reaches neither settings page.
 * Everything happens inside the throwaway e2e tenant and is removed by
 * teardown.
 */

let seed!: E2ESeed;
const SLOW = process.env["CI"] ? 3 : 1;

test.beforeAll(() => {
  seed = requireSeed();
});

test.describe("rates (owner)", () => {
  test("lists the seeded bill cards; adds and closes a member card with the pinned wording; cost is behind two-factor", async ({ page }) => {
    await page.goto("/settings/rates");
    await expect(page.getByRole("heading", { name: "Rates", level: 1 })).toBeVisible();
    const rows = page.getByTestId("rate-card-row");
    // The fixture seeds a workspace default (950 SEK) and an agreement card (1 200 SEK).
    await expect(rows.filter({ hasText: "Workspace default" }).first()).toBeVisible();
    await expect(rows.filter({ hasText: "Förvaltning" }).first()).toBeVisible();
    await expect(rows.filter({ hasText: "Workspace default" }).first()).toContainText("950");

    // COST: the owner holds rate:view_cost but has no factor enrolled —
    // the section offers the confirmation, lists nothing, reveals nothing.
    await expect(page.getByRole("heading", { name: /Internal cost rates/ })).toBeVisible();
    await expect(page.getByTestId("cost-mfa-link")).toBeVisible();
    await expect(page.getByTestId("cost-reveal")).toHaveCount(0);
    await expect(page.getByTestId("rate-bill-form")).toBeVisible();
    await expect(page.getByTestId("rate-cost-form")).toHaveCount(0);

    // Add a member card (a dimension nothing else uses, so the fixture is untouched).
    const form = page.getByTestId("rate-bill-form");
    await form.locator("#rate-bill-scope").selectOption("MEMBER");
    await form.locator("#rate-bill-member").selectOption({ label: "E2E Owner" });
    await page.getByTestId("rate-bill-amount").fill("875");
    await page.getByTestId("rate-bill-submit").click();
    await expect(page.getByText(/past entries unchanged; use Reprice to correct history/)).toBeVisible({ timeout: 15_000 * SLOW });
    const memberRow = rows.filter({ hasText: "E2E Owner" }).first();
    await expect(memberRow).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(memberRow).toContainText("875");
    await expect(memberRow).toHaveAttribute("data-open", "1");

    // Close it in place: the row menu → "Close card…" → the date form below the table.
    await memberRow.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Close card…" }).click();
    const closeForm = page.getByTestId("rate-card-close-form");
    await expect(closeForm).toBeVisible();
    await page.getByTestId("rate-card-row-form-submit").click();
    await expect(page.getByText("Card closed.")).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(rows.filter({ hasText: "E2E Owner" }).first()).toHaveAttribute("data-open", "0", { timeout: 15_000 * SLOW });
  });
});

test.describe("time tracking settings (owner)", () => {
  test("shows the notice status and manages work types: add, rename inline, archive, restore", async ({ page }) => {
    await page.goto("/settings/time");
    await expect(page.getByRole("heading", { name: "Time tracking", level: 1 })).toBeVisible();
    await expect(page.getByText(/Version 1, published/)).toBeVisible();
    // Both fixture members are listed with their standing against version 1.
    const ackRows = page.getByTestId("notice-ack-row");
    await expect(ackRows).toHaveCount(2);
    await expect(page.getByText(/of 2 members have read version 1/)).toBeVisible();
    // The publish editor waits behind the disclosure; opening it reveals both locales' fields.
    await page.locator('summary[data-slot="disclosure-trigger"]', { hasText: "Edit the text and publish" }).click();
    await expect(page.getByTestId("notice-publish-form")).toBeVisible();
    await expect(page.locator("#notice-title-sv")).toHaveValue(/Fortleva/);

    // Six seeded work types (in the tenant's default locale, sv).
    const typeRows = page.getByTestId("work-type-row");
    await expect(typeRows).toHaveCount(6);

    // Add one.
    await page.getByTestId("work-type-name").fill("E2E Review");
    await page.locator("#work-type-billable").selectOption("no");
    await page.getByTestId("work-type-submit").click();
    const row = typeRows.filter({ hasText: "E2E Review" }).first();
    await expect(row).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(row).toContainText("Not billable");

    // Rename it through the inline edit (Enter opens, type, Enter commits — AutoForm posts on blur).
    // While editing, the value lives in the control, not in the row's text, so the open
    // control is found by its accessible name rather than through the row's hasText filter.
    const trigger = row.getByRole("button", { name: /Edit name, currently E2E Review/ });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const input = page.getByRole("textbox", { name: "Edit name" });
    await expect(input).toBeVisible();
    await input.fill("E2E Review renamed");
    await page.keyboard.press("Enter");
    // AutoForm's success is its quiet "Saved" tick (the action's message is only used for errors).
    await expect(typeRows.filter({ hasText: "E2E Review renamed" }).first()).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(typeRows.filter({ hasText: "E2E Review renamed" }).first().getByText("Saved")).toBeVisible({ timeout: 15_000 * SLOW });

    // Archive → it leaves the live table, reappears under the disclosure; restore brings it back.
    const renamed = typeRows.filter({ hasText: "E2E Review renamed" }).first();
    await renamed.getByRole("button", { name: /Actions for/ }).click();
    // Reversible, so the menu item acts at once — no confirm question.
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(page.getByText("Work type archived.")).toBeVisible({ timeout: 15_000 * SLOW });
    const archivedRow = typeRows.filter({ hasText: "E2E Review renamed" }).first();
    await expect(archivedRow).toHaveAttribute("data-archived", "1", { timeout: 15_000 * SLOW });
    // The archived list waits behind the product's one disclosure (<details>/<summary>).
    await page.locator('summary[data-slot="disclosure-trigger"]', { hasText: "Archived types" }).click();
    await expect(archivedRow).toBeVisible();
    await archivedRow.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Restore" }).click();
    await expect(page.getByText("Work type restored.")).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(typeRows.filter({ hasText: "E2E Review renamed" }).first()).toHaveAttribute("data-archived", "0", {
      timeout: 15_000 * SLOW,
    });
  });
});

test.describe("client agreements tab (owner)", () => {
  test("lists the agreements with their rate and the agreement rate cards", async ({ page }) => {
    await page.goto(`/clients/${seed.clientId}`);
    const tabs = page.locator('nav[data-slot="tab-strip"]');
    await tabs.getByRole("link", { name: "Agreements", exact: true }).click();
    await page.waitForURL(/\/clients\/[^/]+\/agreements$/);
    await expect(tabs.getByRole("link", { name: "Agreements", exact: true })).toHaveAttribute("aria-current", "page");
    // The Overview no longer carries the services card; this tab does.
    const maintenance = page.getByRole("row").filter({ hasText: "Förvaltning" }).first();
    await expect(maintenance).toBeVisible();
    await expect(maintenance.getByTestId("agreement-rate")).toContainText("1,200.00");
    const cards = page.getByTestId("rate-card-row");
    await expect(cards.filter({ hasText: "Förvaltning" }).first()).toBeVisible();
    await expect(page.getByTestId("rate-bill-form")).toBeVisible();
    // Pinned to SERVICE: the scope select is fixed and only this client's agreements are offered.
    await expect(page.locator("#rate-bill-scope")).toBeDisabled();
    await expect(page.locator("#rate-bill-service option")).toHaveCount(3); // placeholder + 2 agreements
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

  test("has neither settings page and sees no rate anywhere on the client", async ({ page }) => {
    await page.goto("/settings/rates");
    await expect(page.getByText("You do not have permission to see rate cards.")).toBeVisible();
    await expect(page.getByTestId("rate-card-row")).toHaveCount(0);
    await page.goto("/settings/time");
    await expect(page.getByText("You do not have permission to see time-tracking settings.")).toBeVisible();
    await expect(page.getByTestId("notice-ack-row")).toHaveCount(0);
    // The employee is assigned to the client: agreements show names, never rates (UI.md rule 14).
    await page.goto(`/clients/${seed.clientId}/agreements`);
    await expect(page.getByRole("row").filter({ hasText: "Förvaltning" }).first()).toBeVisible();
    await expect(page.getByTestId("agreement-rate")).toHaveCount(0);
    await expect(page.getByTestId("rate-card-row")).toHaveCount(0);
    await expect(page.getByText("1,200.00")).toHaveCount(0);
  });
});
