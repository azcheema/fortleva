import { expect, test } from "@playwright/test";

import { clearRenewalDrafts, plantRenewalDraft, requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * RENEWALS THAT DRAFT AN INVOICE, IN A BROWSER (Phase 4 slice 113b; founder
 * decision C88): an agreement renewing within 14 days gets its invoice drafted
 * by the tenant's renewal run (planted through `seed-cli` — the job's
 * per-tenant body, never the job), and the draft is MARKED on Invoices,
 * EXPLAINED on its page and NAMED in the inbox of the people who may issue
 * it; the agreement's "Invoice each renewal" switch turns off and stays off.
 *
 * As the OWNER. The draft lives on the seed's long-named client, and
 * `afterAll` removes it, its agreement and the notices — `inbox.spec.ts`
 * counts the owner's inbox and the visual walk photographs Invoices. The
 * guarantees — the database's one system path, who is told, the periods —
 * are `renewal-invoices.dbtest.ts`'s; this proves the screen reaches them.
 */

let seed!: E2ESeed;
let planted!: { invoiceId: string; serviceId: string };

test.beforeAll(async () => {
  seed = requireSeed();
  planted = await plantRenewalDraft(seed.tenantId, seed.longClientId);
});

test.afterAll(async () => {
  if (seed) await clearRenewalDrafts(seed.tenantId);
});

test.describe("renewal invoices (owner)", () => {
  test("a renewal draft is marked on Invoices, explained on its page and named in the inbox", async ({ page }) => {
    await page.goto("/invoices");
    const row = page.locator(`[data-testid="invoice-row"][data-invoice-id="${planted.invoiceId}"]`);
    await expect(row.getByTestId("invoice-row-renewal")).toHaveText("Renewal");
    await row.getByRole("link").first().click();
    await page.waitForURL(`**/invoices/${planted.invoiceId}`);
    await expect(page.getByTestId("invoice-renewal-note")).toContainText("Fortleva made this draft");
    // One line: the agreement and the days it bills, as the PDF writes a period.
    await expect(page.getByText(/E2E renewal hosting, \d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}/).first()).toBeVisible();

    await page.goto("/inbox");
    await expect(page.getByText("A renewal invoice is ready to check").first()).toBeVisible();
  });

  test("an agreement's “Invoice each renewal” turns off — drawn from the server — and stays off", async ({ page }) => {
    await page.goto(`/clients/${seed.longClientId}/agreements`);
    const row = page.locator(`[data-testid="agreement-item"][data-agreement-id="${planted.serviceId}"]`);
    const toggle = row.getByTestId("agreement-invoicing-switch");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(page.getByText("Its renewals won't be invoiced")).toBeVisible();
    await page.reload();
    const after = page.locator(`[data-testid="agreement-item"][data-agreement-id="${planted.serviceId}"]`);
    await expect(after.getByTestId("agreement-invoicing-switch")).toHaveAttribute("aria-checked", "false");
    await expect(after.getByTestId("agreement-invoicing-state")).toHaveText("Off: no invoice is drafted for its renewals.");
  });
});
