import { readFileSync } from "node:fs";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { auditPage } from "./audit";
import { VIEWPORTS } from "./fixtures/stops";
import { STORAGE_STATE, readyInvoicing, requireSeed, resetInvoiceDetails, setInvoiceSeries, type E2ESeed } from "./fixtures/tenant";

/**
 * ISSUING AN INVOICE IN A BROWSER (Phase 4 slice 108; founder decision C76).
 *
 *   - The workspace made ready through the fixture CLI (company details, a
 *     real encrypted Bankgiro, the client's address) — no authenticator code
 *     spent; the numbering's ✦ save is the dbtests' (`issue.dbtest.ts`), and
 *     the series is set through the CLI here too.
 *   - A draft's Issue invoice… first lists what is missing — the first
 *     invoice number — with a link to Settings and no confirm.
 *   - With the series set: the dialog names the number, the dates and the
 *     total; confirming issues it — the toast names the number, the page
 *     becomes the issued invoice (read-only, from its frozen record), and —
 *     with a bucket — Download PDF downloads `faktura-<n>.pdf` (the client is
 *     Swedish); without one (this harness, by default) the issue says its PDF
 *     waits and Download refuses with a sentence.
 *   - Settings → Invoicing then shows the NEXT number, fixed.
 *
 * Runs before `invoices.spec.ts` (one worker, alphabetical), which resets the
 * company details afterwards; the issued invoice stays — it can never be
 * deleted — and nothing later counts invoices.
 */

const seed: E2ESeed = requireSeed();

/**
 * The PDF's bytes need a bucket: the harness runs the production build, where
 * the local-disk transport refuses (`attachments.spec.ts`'s gate, the same
 * env). Without R2 the spec drives the honest failure instead; the drawing
 * itself is the unit suite's (`print.test.ts`) and the storing the dbtests'
 * (`issue.dbtest.ts`, a local-disk transport in a temp dir).
 */
const HAS_R2 = Boolean(process.env["R2_BUCKET"]);

const toast = (page: Page, text: string | RegExp): Locator => page.locator("[data-sonner-toast]", { hasText: text });

/** Open an InlineEdit by its label, type, and commit with Enter; waits for the action's answer (`invoices.spec.ts`'s). */
async function editInline(page: Page, scope: Locator, label: string, value: string): Promise<void> {
  await scope.getByRole("button", { name: new RegExp(`^Edit ${label}, currently`) }).click();
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
  await answered;
}

test.describe.serial("issuing an invoice", () => {
  test.use({ storageState: STORAGE_STATE, locale: "en-US" });

  let draftUrl = "";
  let first = 0;

  test.beforeAll(async () => {
    await readyInvoicing(seed.tenantId, seed.clientId);
  });
  // `invoices.spec.ts` (next, alphabetically) expects the workspace's details
  // unset — its first test looks for the "before you can issue" caution.
  test.afterAll(async () => {
    await resetInvoiceDetails(seed.tenantId);
  });

  test("a draft says what issuing still needs: the first invoice number", async ({ page }) => {
    await page.goto("/invoices");
    const create = page.getByTestId("new-invoice");
    await create.getByLabel("Client").selectOption({ label: seed.clientName });
    await create.getByRole("button", { name: "Create draft" }).click();
    await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    draftUrl = page.url();
    const newLine = page.getByLabel("New line");
    await newLine.fill("Consulting, September");
    await newLine.press("Enter");
    await expect(toast(page, "Line added.")).toBeVisible();
    const line = page.getByTestId("invoice-line").filter({ has: page.getByRole("button", { name: /currently Consulting, September$/ }) });
    await editInline(page, line, "Price", "1000");
    await expect(page.getByTestId("invoice-total")).toContainText("1,250.00");

    await page.getByTestId("issue-open").click();
    const dialog = page.getByTestId("issue-dialog");
    const heading = dialog.getByRole("heading");
    await expect(heading).toBeVisible();
    // A RETRY (CI retries a failed serial group once, from this test) finds the
    // series a first attempt already set — it can never be unset — so the
    // dialog then names a number instead of the blocker. Assert the state FOUND,
    // or a flake in a later test could never go green on its retry.
    const firstAttempt = (await heading.textContent()) === "Issue this invoice?";
    if (firstAttempt) {
      await expect(dialog.getByTestId("issue-blocker-seller")).toHaveText("Settings → Invoicing still needs a first invoice number.");
      await expect(dialog.getByRole("link", { name: "Open Settings → Invoicing" })).toHaveAttribute("href", "/settings/invoicing");
      await expect(dialog.getByTestId("issue-confirm")).toHaveCount(0);
    } else {
      await expect(heading).toHaveText(/^Issue invoice \d+\?$/);
    }
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    // Focus goes back to the button that opened it (a Radix trigger).
    await expect(page.getByTestId("issue-open")).toBeFocused();

    // Settings: the first number, not set yet (first attempt) — or already fixed (a retry).
    await page.goto("/settings/invoicing");
    if (firstAttempt) {
      await expect(page.getByTestId("invoice-numbering")).toContainText("Not set");
      await expect(page.getByTestId("invoice-missing")).toContainText("a first invoice number");
    } else {
      await expect(page.getByTestId("invoice-numbering")).toBeVisible();
    }
  });

  test("issued: the number, the dates, the total — then read-only, with its PDF", async ({ page }) => {
    first = await setInvoiceSeries(seed.tenantId, 10001);
    await page.goto(draftUrl);
    await page.getByTestId("issue-open").click();
    const dialog = page.getByTestId("issue-dialog");
    await expect(dialog.getByRole("heading", { name: `Issue invoice ${first}?` })).toBeVisible();
    await expect(dialog).toContainText("Once issued it can't be changed or deleted.");
    await expect(dialog.getByTestId("issue-no-period")).toBeVisible();
    await expect(dialog).toContainText("Written in Swedish.");
    await expect(dialog.getByTestId("issue-total")).toContainText("1,250.00");
    await dialog.getByTestId("issue-confirm").click();
    // With a bucket the PDF is made at once; the harness's production build has
    // none (local disk is dev-only), so the issue stands and SAYS its PDF waits
    // — a caution, never a revert-looking error.
    await expect(
      toast(page, HAS_R2 ? `Invoice ${first} issued.` : `Invoice ${first} is issued. Its PDF couldn't be made yet.`),
    ).toBeVisible();

    await expect(page.getByRole("heading", { name: `Invoice ${first}`, level: 1 })).toBeVisible();
    await expect(page.getByTestId("invoice-status")).toHaveText("Issued");
    await expect(page.getByTestId("bill-to")).toContainText("Kundvägen 2");
    await expect(page.getByTestId("bill-to")).toContainText("As it was when the invoice was issued.");
    // Nothing on it is editable any more.
    await expect(page.getByLabel("New line")).toHaveCount(0);
    await expect(page.getByTestId("issue-open")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Draft invoice actions" })).toHaveCount(0);

    if (HAS_R2) {
      const downloading = page.waitForEvent("download");
      await page.getByTestId("invoice-download").click();
      const download = await downloading;
      expect(download.suggestedFilename()).toBe(`faktura-${first}.pdf`);
      const path = await download.path();
      expect(readFileSync(path).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } else {
      await expect(page.getByTestId("invoice-pdf-missing")).toBeVisible();
      await page.getByTestId("invoice-download").click();
      await expect(toast(page, "The invoice's PDF couldn't be made just now.")).toBeVisible();
      // The button is back for another try, the page unchanged.
      await expect(page.getByTestId("invoice-download")).toBeEnabled();
    }

    // On the list, with its number.
    await page.goto("/invoices");
    const id = new URL(draftUrl).pathname.split("/").pop()!;
    const row = page.locator(`[data-testid="invoice-row"][data-invoice-id="${id}"]`);
    await expect(row).toHaveAttribute("data-status", "ISSUED");
    await expect(row).toContainText(String(first));

    // Settings: the next number, fixed.
    await page.goto("/settings/invoicing");
    await expect(page.getByTestId("invoice-next-number")).toHaveText(String(first + 1));
    await expect(page.getByTestId("invoice-numbering")).toContainText("Fixed now that an invoice has been issued.");
  });

  test("the issued invoice holds together on a phone (the visual walk's audit, on this page)", async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto(draftUrl);
    await expect(page.getByRole("heading", { name: `Invoice ${first}`, level: 1 })).toBeVisible();
    const audit = await page.evaluate(auditPage);
    expect(audit.h1.count).toBe(1);
    expect(audit.rawKeys).toEqual([]);
    expect(audit.invisibleText).toEqual([]);
    expect(audit.overflow.offenders).toEqual([]);
    expect(audit.overflow.scrollWidth).toBeLessThanOrEqual(audit.overflow.clientWidth);
    expect(audit.craft.unpinnedRowActions).toEqual([]);
    expect(audit.craft.badInlineEdits).toEqual([]);
  });
});
