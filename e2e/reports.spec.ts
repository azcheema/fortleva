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

  // ── Phase 7 slice 119 (C95): the monthly report Fortleva makes ───────
  test("the Make a report card: last month, the client's language, the project ticked, the two texts — and the made report's marker", async ({ page }) => {
    await page.goto(tab());
    const form = page.getByTestId("make-report");
    await expect(form).toBeVisible();
    // The month picker starts at LAST month (a made report covers a month
    // that has ended) — in the WORKSPACE's zone (Europe/Stockholm, the seed's),
    // never UTC's: the two differ for two hours on the last day of a month.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit" }).format(new Date());
    const [y, m] = today.split("-").map(Number) as [number, number];
    const last = m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
    await expect(form.getByTestId("report-month")).toHaveValue(String(last.month));
    await expect(form.getByTestId("report-year")).toHaveValue(String(last.year));
    // A client with no country invoices in Swedish (C76 (e)) — the select starts there.
    await expect(form.getByTestId("make-report-locale")).toHaveValue("sv");
    const boxes = form.getByTestId("make-report-projects").locator('input[type="checkbox"]');
    expect(await boxes.count()).toBeGreaterThanOrEqual(1);
    for (const box of await boxes.all()) await expect(box).toBeChecked();
    await expect(form.getByTestId("make-report-summary")).toBeVisible();
    await expect(form.getByTestId("make-report-coming-next")).toBeVisible();
    await expect(form.getByTestId("make-report-shows")).toContainText("No hours, no files.");
    await expect(form).toContainText("Only your team can see it until you publish it.");
    // Nothing ticked, nothing to make.
    for (const box of await boxes.all()) await box.uncheck();
    await expect(form.getByTestId("make-report-submit")).toBeDisabled();

    const madeRow = rowOf(page, seed.madeReportName);
    await expect(madeRow).toHaveAttribute("data-visibility", "INTERNAL");
    await expect(madeRow.getByTestId("report-made")).toHaveText("Made in Fortleva");
    await expect(rowOf(page, seed.reportName).getByTestId("report-made")).toHaveCount(0);
  });

  // The fixture's month holds no finished task and no update (the seed's
  // land in the current month), so this walks the check PATH — the dialog,
  // the toast, the row, the portal page, R5 — not its judgement; the content
  // cases are `src/documents/made-reports.dbtest.ts`'s.
  test("publishing a made report runs the check again and the client's page shows it — and Hide puts it back", async ({ page, browser }) => {
    await page.goto(tab());
    const row = rowOf(page, seed.madeReportName);
    await row.getByRole("button", { name: `Actions for ${seed.madeReportName}` }).click();
    await page.getByRole("menuitem", { name: "Publish…" }).click();
    const dialog = page.getByTestId("publish-report-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("publish-report-confirm").click();
    await expect(toast(page, /^Published\./)).toBeVisible();
    await expect(row).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");

    const client = await contactPage(browser, "/portal/reports");
    try {
      const shown = client.page.locator('[data-slot="portal-report"]', { hasText: seed.madeReportName });
      await expect(shown).toBeVisible();
      // The client's copy says nothing of Fortleva (R5).
      await expect(shown).not.toContainText("Fortleva");
    } finally {
      await client.close();
    }

    await row.getByRole("button", { name: `Actions for ${seed.madeReportName}` }).click();
    await page.getByRole("menuitem", { name: "Hide from client" }).click();
    await expect(toast(page, "Hidden. Only your team can see it now.")).toBeVisible();
    await expect(row).toHaveAttribute("data-visibility", "INTERNAL");
  });

  // ── Phase 7 slice 120 (C96): the report the drafter made by itself ────
  test("a report Fortleva drafted by itself is marked so, and the Make card on its month says making one replaces it", async ({ page }) => {
    await page.goto(tab());
    const drafted = rowOf(page, seed.draftedReportName);
    await expect(drafted).toHaveAttribute("data-visibility", "INTERNAL");
    await expect(drafted.getByTestId("report-made")).toHaveText("Drafted by Fortleva");
    // A person's press says "Made"; the drafter's says "Drafted".
    await expect(rowOf(page, seed.madeReportName).getByTestId("report-made")).toHaveText("Made in Fortleva");

    const form = page.getByTestId("make-report");
    // Last month (the picker's start) holds the made report, not a draft: no sentence.
    await expect(form.getByTestId("make-report-replaces")).toHaveCount(0);
    // The drafted month, picked: the card says making one here replaces the draft.
    const [year, month] = seed.draftedMonth.split("-");
    await form.getByTestId("report-year").selectOption(String(Number(year)));
    await form.getByTestId("report-month").selectOption(String(Number(month)));
    await expect(form.getByTestId("make-report-replaces")).toContainText("Making one here replaces that draft");
  });

  test("Make report draws the PDF and files it private", async ({ page }) => {
    test.skip(!HAS_R2, "the drawing's upload needs the R2 env (the production harness refuses the dev transport by design); the same path runs in src/documents/made-reports.dbtest.ts");
    await page.goto(tab());
    const form = page.getByTestId("make-report");
    await form.getByTestId("make-report-summary").fill(`E2E made ${Date.now()}`);
    await form.getByTestId("make-report-submit").click();
    await expect(toast(page, "Report made.")).toBeVisible();
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
