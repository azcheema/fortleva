import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { auditPage } from "./audit";
import { VIEWPORTS } from "./fixtures/stops";
import {
  CONTACT_STORAGE_STATE,
  STORAGE_STATE,
  readyInvoicing,
  requireSeed,
  resetInvoiceDetails,
  setInvoiceSeries,
  type E2ESeed,
} from "./fixtures/tenant";

/**
 * SENDING AN INVOICE, AND THE CLIENT'S SIDE OF IT, IN A BROWSER (Phase 4 slice
 * 109; founder decision C79).
 *
 *   - A draft's Pay now link: a lookalike of Stripe refused in a sentence, a
 *     Stripe link kept; the issue dialog then shows the link in full and —
 *     this member has no authenticator — asks for one instead of issuing
 *     (C79 (g)); the link removed, the invoice issues as before.
 *   - Send…: the client card's billing email filled in and changed; with a
 *     bucket it emails the PDF (the dev outbox records the attachment's name,
 *     never its bytes); without one (this harness, by default) the send
 *     refuses with the PDF sentence and the dialog stays;
 *     Mark as sent, below the form, says it opens the portal — and does.
 *   - The client's main contact (Astrid): the portal's nav now offers
 *     Invoices; the invoice, To pay, with the bank details and the number to
 *     quote; its PDF (refused in a sentence without a bucket).
 *   - Mark as paid… with the team's note → Paid, in the portal too; Mark as
 *     unpaid → back to Sent.
 *
 * The rules underneath — the database's gate and belt, the send's record, the
 * payment's note on its own row, the budget, the pay link withheld once
 * anything is credited, each address its own outcome — are
 * `src/modules/invoicing/send.dbtest.ts`'s. Issuing WITH a pay link needs a
 * member with an authenticator: the dbtests drive it; the browser proves the
 * dialog asks.
 *
 * Runs after `invoice-issue.spec.ts` and before `invoices.spec.ts`
 * (alphabetical, one worker): it makes the workspace ready itself and resets
 * the company details afterwards, as the issue spec does. The invoice it sends
 * stays — it can never be deleted — so later portal specs see an Invoices
 * entry in Astrid's nav; nothing counts the entries.
 */

const seed: E2ESeed = requireSeed();
const HAS_R2 = Boolean(process.env["R2_BUCKET"]);

const toast = (page: Page, text: string | RegExp): Locator => page.locator("[data-sonner-toast]", { hasText: text });

/** Open an InlineEdit by its label, type, and commit with Enter; waits for the action's answer. */
async function editInline(page: Page, scope: Locator, label: string, value: string): Promise<void> {
  await scope.getByRole("button", { name: new RegExp(`^Edit ${label}, currently`) }).click();
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  if (value) await page.keyboard.type(value);
  await page.keyboard.press("Enter");
  await answered;
}

/** Astrid's own portal, in a context of her own. */
async function asAstrid(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

test.describe.serial("sending an invoice, and the client's portal", () => {
  test.use({ storageState: STORAGE_STATE, locale: "en-US" });

  let invoiceUrl = "";
  let number = "";

  test.beforeAll(async () => {
    await readyInvoicing(seed.tenantId, seed.clientId);
    await setInvoiceSeries(seed.tenantId, 10001);
  });
  // `invoices.spec.ts` (next, alphabetically) expects the workspace's details unset.
  test.afterAll(async () => {
    await resetInvoiceDetails(seed.tenantId);
  });

  test("a Pay now link: a lookalike refused, Stripe kept; issuing it asks for an authenticator", async ({ page }) => {
    await page.goto("/invoices");
    const create = page.getByTestId("new-invoice");
    await create.getByLabel("Client").selectOption({ label: seed.clientName });
    await create.getByRole("button", { name: "Create draft" }).click();
    await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    invoiceUrl = page.url();
    // A new draft starts in the client's last invoice's currency: SEK, said.
    const details = page.getByTestId("draft-details");
    const newLine = page.getByLabel("New line");
    await newLine.fill("Support, October");
    await newLine.press("Enter");
    await expect(toast(page, "Line added.")).toBeVisible();
    const line = page.getByTestId("invoice-line").filter({ has: page.getByRole("button", { name: /currently Support, October$/ }) });
    await editInline(page, line, "Price", "800");
    await expect(page.getByTestId("invoice-total")).toContainText("1,000.00");

    const payLink = page.getByTestId("pay-link");
    await editInline(page, payLink, "Pay now link", "https://buy.stripe.com.evil.example/x");
    await expect(toast(page, "A Pay now link must be a Stripe payment link")).toBeVisible();
    await editInline(page, payLink, "Pay now link", "https://buy.stripe.com/test_e2e");
    await expect(payLink).toContainText("https://buy.stripe.com/test_e2e");
    await expect(details).toBeVisible();

    await page.getByTestId("issue-open").click();
    const dialog = page.getByTestId("issue-dialog");
    await expect(dialog.getByTestId("issue-pay-link")).toContainText("https://buy.stripe.com/test_e2e");
    await expect(dialog.getByTestId("issue-needs-factor")).toBeVisible();
    await expect(dialog.getByTestId("issue-confirm")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);

    // Without the link, it issues as it always did.
    await editInline(page, payLink, "Pay now link", "");
    await page.getByTestId("issue-open").click();
    await expect(dialog.getByTestId("issue-pay-link")).toHaveCount(0);
    await dialog.getByTestId("issue-confirm").click();
    // With a bucket "issued."; without one the issue stands and says its PDF waits.
    await expect(toast(page, /Invoice \d+ (issued\.|is issued\.)/)).toBeVisible();
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText(/^Invoice \d+$/);
    number = (await heading.textContent())!.replace("Invoice ", "");
    await expect(page.getByTestId("invoice-status")).toHaveText("Issued");
    await expect(page.getByTestId("invoice-deliveries-none")).toBeVisible();
  });

  test("Send… emails it with its PDF — or, with no file storage, says the PDF isn't there; Mark as sent opens the portal", async ({ page }) => {
    await page.goto(invoiceUrl);
    await page.getByTestId("send-open").click();
    const dialog = page.getByTestId("send-dialog");
    await expect(dialog.getByRole("heading", { name: `Send invoice ${number}` })).toBeVisible();
    await expect(dialog).toContainText("Once it has been sent, the client's main contacts can also see it in their portal.");
    // The client card's billing email is filled in — and changeable (C79 (e)).
    await expect(dialog.getByTestId("send-to")).toHaveValue(/^billing-.+@test\.invalid$/);
    await dialog.getByTestId("send-to").fill("accounts-e2e@test.invalid");
    await dialog.getByTestId("send-confirm").click();
    if (HAS_R2) {
      await expect(toast(page, `Invoice ${number} was emailed to accounts-e2e@test.invalid.`)).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId("invoice-status")).toHaveText("Sent");
      await expect(page.getByTestId("invoice-delivery")).toContainText("Emailed to accounts-e2e@test.invalid");
      return;
    }
    await expect(toast(page, "The invoice's PDF couldn't be made just now.")).toBeVisible();
    // Refused: the dialog stays, with what was typed.
    await expect(dialog.getByTestId("send-to")).toHaveValue("accounts-e2e@test.invalid");
    await expect(dialog.getByTestId("mark-sent")).toContainText("the client's main contacts will then see it in their portal");
    await dialog.getByTestId("mark-sent-confirm").click();
    await expect(toast(page, "Marked as sent.")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("invoice-status")).toHaveText("Sent");
    await expect(page.getByTestId("invoice-delivery")).toHaveAttribute("data-method", "MARKED");
    // Sent: "Send again…", and Mark as sent is gone.
    await page.getByTestId("send-open").click();
    await expect(page.getByTestId("send-dialog").getByTestId("mark-sent")).toHaveCount(0);
    await page.getByTestId("send-dialog").getByRole("button", { name: "Cancel" }).click();

    // …and it holds together on a phone.
    await page.setViewportSize(VIEWPORTS.mobile);
    const audit = await page.evaluate(auditPage);
    expect(audit.h1.count).toBe(1);
    expect(audit.rawKeys).toEqual([]);
    expect(audit.invisibleText).toEqual([]);
    expect(audit.overflow.offenders).toEqual([]);
  });

  test("the client's main contact finds it in the portal: To pay, the bank details, the number to quote", async ({ browser }) => {
    const astrid = await asAstrid(browser);
    try {
      const { page } = astrid;
      await page.goto("/portal");
      const surface = page.locator("[data-portal-surface]");
      await expect(surface).toBeVisible({ timeout: 30_000 });
      const nav = surface.locator('[data-slot="portal-nav"]');
      await nav.getByRole("link", { name: "Invoices" }).click();
      await expect(page).toHaveURL(/\/portal\/invoices$/);
      await expect(nav.getByRole("link", { name: "Invoices" })).toHaveAttribute("aria-current", "page");
      const row = page.getByTestId("portal-invoice-row").filter({ hasText: `Invoice ${number}` });
      await expect(row).toHaveAttribute("data-state", "TO_PAY");
      await expect(row.getByTestId("portal-invoice-amount")).toContainText("1,000.00");
      await row.getByRole("link", { name: `Invoice ${number}` }).click();
      await expect(page.getByRole("heading", { name: `Invoice ${number}`, level: 1 })).toBeVisible();
      await expect(page.getByTestId("portal-invoice-state")).toHaveText("To pay");
      await expect(page.getByTestId("portal-pay-now")).toHaveCount(0);
      await expect(page.getByTestId("portal-pay-bank")).toContainText("Bankgiro");
      await expect(page.getByTestId("portal-pay-bank")).toContainText(`Quote invoice number ${number} with your payment.`);
      if (!HAS_R2) {
        // No PDF in this harness: the download comes back with a sentence, never a raw error.
        await page.getByTestId("portal-invoice-download").click();
        await expect(page.getByTestId("portal-invoice-error")).toBeVisible();
      }
      await page.setViewportSize(VIEWPORTS.mobile);
      const audit = await page.evaluate(auditPage);
      expect(audit.rawKeys).toEqual([]);
      expect(audit.overflow.offenders).toEqual([]);
    } finally {
      await astrid.close();
    }
  });

  test("Mark as paid… with the team's note → Paid, in the portal too; Mark as unpaid undoes it", async ({ page, browser }) => {
    await page.goto(invoiceUrl);
    await page.getByTestId("paid-open").click();
    const dialog = page.getByTestId("paid-dialog");
    await expect(dialog.getByRole("heading", { name: `Mark invoice ${number} as paid` })).toBeVisible();
    await expect(dialog.getByTestId("paid-on")).not.toHaveValue("");
    await dialog.getByTestId("paid-note").fill("Bank ref 4711");
    await dialog.getByTestId("paid-confirm").click();
    await expect(toast(page, "Marked as paid.")).toBeVisible();
    await expect(page.getByTestId("invoice-status")).toHaveText("Paid");
    await expect(page.getByTestId("invoice-payment-note")).toHaveText("Bank ref 4711");

    const astrid = await asAstrid(browser);
    try {
      await astrid.page.goto(`/portal/invoices/${new URL(invoiceUrl).pathname.split("/").pop()}`);
      await expect(astrid.page.getByTestId("portal-invoice-state")).toHaveText("Paid");
      // The team's note is the team's.
      expect(await astrid.page.content()).not.toContain("Bank ref 4711");
      await expect(astrid.page.getByTestId("portal-pay-bank")).toHaveCount(0);
    } finally {
      await astrid.close();
    }

    await page.getByRole("button", { name: "Payment actions" }).click();
    await page.getByRole("menuitem", { name: "Mark as unpaid" }).click();
    await page.getByRole("button", { name: "Yes" }).click();
    await expect(toast(page, "Marked as unpaid.")).toBeVisible();
    await expect(page.getByTestId("invoice-status")).toHaveText("Sent");
    await expect(page.getByTestId("invoice-paid")).toHaveCount(0);
  });
});
