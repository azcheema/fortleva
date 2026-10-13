import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { CONTACT_STORAGE_STATE, requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * CLIENT REPORT FILES, through real sessions on both planes (Phase 6 slice
 * 115; founder decision C91).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT: the whole vertical as people use
 * it — the client's Reports tab as the owner reads it (the visibility chip on
 * every row, never absence), the Publish dialog that says who will see it, the
 * toast, Hide on one click — and, on the contact's own session, the portal's
 * Reports entry and page: the published report under its month, the INTERNAL
 * one nowhere, and neither on the Files page.
 *
 * THE FIXTURE'S TWO REPORTS (`seed-cli`): last month's, published, and a draft
 * beside it, INTERNAL — the negative control. The publish-and-hide test puts
 * the draft back as it found it, so the walk and View-as see the seed's state.
 *
 * THE BYTES ARE GATED ON THE R2 ENV, as in `portal-files.spec.ts`: the harness
 * runs the production build, where the local-disk transport refuses by design,
 * so the upload's presign and the download cannot be minted here. Both run
 * with real bytes in `src/documents/reports.dbtest.ts`.
 */

const HAS_R2 = Boolean(process.env["R2_BUCKET"]);
let seed!: E2ESeed;

test.beforeAll(() => {
  seed = requireSeed();
});

const tab = () => `/clients/${seed.clientId}/reports`;
const toast = (page: Page, text: string | RegExp): Locator => page.locator("[data-sonner-toast]", { hasText: text });
const rowOf = (page: Page, name: string) => page.locator('[data-testid="report-row"]', { hasText: name });

async function contactPage(browser: Browser, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });
  const page = await context.newPage();
  await page.goto(path);
  await expect(page.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 });
  return { page, close: () => context.close() };
}

test.describe("a client's Reports tab (owner)", () => {
  test("lists the reports with who can see each — and the Files tab lists neither", async ({ page }) => {
    await page.goto(`/clients/${seed.clientId}`);
    const tabs = page.locator('nav[data-slot="tab-strip"]');
    await tabs.getByRole("link", { name: "Reports", exact: true }).click();
    await page.waitForURL(/\/clients\/[^/]+\/reports$/);
    await expect(tabs.getByRole("link", { name: "Reports", exact: true })).toHaveAttribute("aria-current", "page");

    const published = rowOf(page, seed.reportName);
    await expect(published).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");
    await expect(published.locator('[data-slot="visibility-badge"]')).toHaveText("Client can see");
    await expect(published.getByTestId("report-published")).toHaveText(/\d{4}/);
    const draft = rowOf(page, seed.internalReportName);
    await expect(draft).toHaveAttribute("data-visibility", "INTERNAL");
    await expect(draft.locator('[data-slot="visibility-badge"]')).toHaveText("Private to team");
    await expect(draft.getByTestId("report-published")).toHaveText("");
    // The upload card says a new report starts private.
    await expect(page.getByTestId("add-report")).toContainText("Only your team can see it until you publish it.");

    await page.goto(`/clients/${seed.clientId}/files`);
    await expect(page.locator("main")).not.toContainText(seed.reportName);
    await expect(page.locator("main")).not.toContainText(seed.internalReportName);
  });

  test("Publish asks first and says who will see it; Hide acts at once — and the client's page follows both", async ({ page, browser }) => {
    await page.goto(tab());
    const draft = rowOf(page, seed.internalReportName);
    await draft.getByRole("button", { name: `Actions for ${seed.internalReportName}` }).click();
    // Not published yet: Publish… is offered, Hide is not.
    await expect(page.getByRole("menuitem", { name: "Hide from client" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Publish…" }).click();
    const dialog = page.getByTestId("publish-report-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(seed.clientName);
    await expect(dialog).toContainText("they'll get an email");
    await dialog.getByTestId("publish-report-confirm").click();
    await expect(toast(page, /^Published\./)).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(draft).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");

    const client = await contactPage(browser, "/portal/reports");
    try {
      await expect(client.page.locator('[data-slot="portal-report"]', { hasText: seed.internalReportName })).toBeVisible();
    } finally {
      await client.close();
    }

    // Hide: one click, no question — it takes access away.
    await draft.getByRole("button", { name: `Actions for ${seed.internalReportName}` }).click();
    await page.getByRole("menuitem", { name: "Hide from client" }).click();
    await expect(toast(page, "Hidden. Only your team can see it now.")).toBeVisible();
    await expect(draft).toHaveAttribute("data-visibility", "INTERNAL");

    const again = await contactPage(browser, "/portal/reports");
    try {
      await expect(again.page.locator("[data-portal-surface]")).not.toContainText(seed.internalReportName);
      await expect(again.page.locator('[data-slot="portal-report"]', { hasText: seed.reportName })).toBeVisible();
    } finally {
      await again.close();
    }
  });

  test("a report uploads for a month, private", async ({ page }) => {
    test.skip(!HAS_R2, "the upload's presign needs the R2 env (the production harness refuses the dev transport by design); the same hops run in src/documents/reports.dbtest.ts");
    await page.goto(tab());
    const form = page.getByTestId("add-report");
    const name = `E2E Uploaded report ${Date.now()}`;
    await form.getByTestId("report-name").fill(name);
    await form.locator('input[type="file"]').setInputFiles({ name: "report.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
    await form.getByTestId("add-report-submit").click();
    await expect(toast(page, "Report uploaded.")).toBeVisible();
    const row = rowOf(page, name);
    await expect(row).toHaveAttribute("data-visibility", "INTERNAL");
    await row.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete" }).last().click();
    await expect(toast(page, "Report deleted.")).toBeVisible();
  });
});

test.describe("the client's Reports page (contact)", () => {
  test.use({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });

  test("the nav offers Reports; the page shows the published report under its month — never the draft", async ({ page }) => {
    await page.goto("/portal");
    const surface = page.locator("[data-portal-surface]");
    await expect(surface).toBeVisible({ timeout: 30_000 });
    const nav = surface.locator('[data-slot="portal-nav"]');
    await nav.getByRole("link", { name: "Reports" }).click();
    await page.waitForURL(/\/portal\/reports$/);
    await expect(nav.getByRole("link", { name: "Reports" })).toHaveAttribute("aria-current", "page");

    const report = surface.locator('[data-slot="portal-report"]', { hasText: seed.reportName });
    await expect(report).toBeVisible();
    await expect(report).toContainText("Published");
    await expect(report.getByRole("button", { name: `Download ${seed.reportName}` })).toBeVisible();
    // Under a card named for its month ("September 2026"). The inner locator
    // is queried against each card, so it is rooted at the page, not the surface.
    const card = surface.locator('[data-slot="section-card"]', {
      has: page.locator('[data-slot="portal-report"]', { hasText: seed.reportName }),
    });
    await expect(card).toContainText(/(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}/);
    await expect(surface).not.toContainText(seed.internalReportName);

    // A report is not a file: the Files page does not list it.
    await page.goto("/portal/files");
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await expect(surface).not.toContainText(seed.reportName);
    await expect(surface).not.toContainText(seed.internalReportName);
  });

  test("the download is a real attachment", async ({ page }) => {
    test.skip(!HAS_R2, "the byte round-trip needs the R2 env; the same hops run in src/documents/reports.dbtest.ts");
    await page.goto("/portal/reports");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: `Download ${seed.reportName}` }).click();
    expect((await downloadPromise).suggestedFilename()).toBe(seed.reportName);
  });
});
