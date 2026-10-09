import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";

import { STORAGE_STATE, requireSeed, resetInvoiceDetails, type E2ESeed } from "./fixtures/tenant";
import { signInVaultOwner, totpNow } from "./fixtures/vault-session";

/**
 * INVOICES IN A BROWSER (Phase 4 slice 107; founder decision C75).
 *
 *   - Settings → Invoicing, as the owner with NO authenticator: both
 *     protected cards say to set one up and offer no form; the default terms
 *     save inline.
 *   - As the owner WITH one (C75 (h)–(j)): the company card and the payment
 *     card each open one form holding every value and the authenticator code;
 *     a mistyped number is refused in a sentence BEFORE the code is checked,
 *     and the form keeps everything typed; the payment card is saved with the
 *     code and the page says who changed it. (A WRONG code is not driven here:
 *     the TOTP owner's code budget is shared with later specs — see below —
 *     and the check is the one step-up helper every ✦ act uses.) Put back to
 *     blank through the fixture CLI.
 *   - A draft: made from a client, lines added from their description alone,
 *     quantity, price and rate edited in place, the totals as the lines make
 *     them (VAT per rate), a line moved (focus follows its menu) and removed
 *     (focus to the add field), the VAT treatment's question answered No then
 *     Yes, and deleted from its menu.
 */

const seed: E2ESeed = requireSeed();

const toast = (page: Page, text: string | RegExp): Locator => page.locator("[data-sonner-toast]", { hasText: text });

const rx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Open an InlineEdit by its label, type, and commit with Enter; waits for the action's answer. */
async function editInline(page: Page, scope: Locator, label: string, value: string): Promise<void> {
  await scope.getByRole("button", { name: new RegExp(`^Edit ${rx(label)}, currently`) }).click();
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  // Select and DELETE: typing "" over a selection changes nothing, and an
  // unchanged value posts nothing (AutoForm compares with its focus snapshot).
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  if (value !== "") await page.keyboard.type(value);
  await page.keyboard.press("Enter");
  await answered;
}

test.describe("Settings → Invoicing, as an owner with no authenticator", () => {
  test.use({ storageState: STORAGE_STATE, locale: "en-US" });

  test("the protected cards ask for an authenticator first; the default terms save inline", async ({ page }) => {
    await page.goto("/settings/invoicing");
    await expect(page.getByRole("heading", { name: "Invoicing", level: 1 })).toBeVisible();
    await expect(page.getByTestId("invoice-missing")).toBeVisible();
    for (const card of ["invoice-company", "invoice-payment"]) {
      await expect(page.getByTestId(`${card}-needs-factor`)).toBeVisible();
      await expect(page.getByTestId(card).getByRole("button", { name: /^Change / })).toHaveCount(0);
    }
    const terms = page.getByRole("button", { name: /^Edit Days to pay, currently/ });
    await editInline(page, page.locator("main"), "Days to pay", "21");
    await page.reload();
    await expect(page.getByRole("button", { name: "Edit Days to pay, currently 21" })).toBeVisible();
    await editInline(page, page.locator("main"), "Days to pay", "");
    await expect(terms).toBeVisible();
  });
});

/*
 * ONE CODE SPENT, ON PURPOSE. The TOTP owner's step-ups are six per ten
 * minutes (`auth.step_up`, an in-process floor the harness keeps), shared with
 * `portal-logins.spec.ts` and `vault-owner.spec.ts` later in the run. So the
 * typo refusals here cost nothing (the fields are checked before the code),
 * only the payment save types a code, and the details are put back through
 * the fixture CLI — the platform role, never a second code.
 */
test.describe.serial("the protected cards, as the owner with an authenticator (C75 (h)–(j))", () => {
  let context!: BrowserContext;
  let page!: Page;

  test.beforeAll(async ({ browser }) => {
    await resetInvoiceDetails(seed.tenantId);
    ({ context, page } = await signInVaultOwner(browser, seed));
  });
  test.afterAll(async () => {
    await context?.close();
    await resetInvoiceDetails(seed.tenantId);
  });

  /** Open a card's form ("Change …"). */
  async function openForm(cardId: string, change: string, formName: string): Promise<Locator> {
    await page.goto("/settings/invoicing");
    await page.getByTestId(cardId).getByRole("button", { name: change }).click();
    const form = page.getByTestId(cardId).getByRole("form", { name: formName });
    await expect(form).toBeVisible();
    return form;
  }

  const code = () => totpNow(seed.vaultOwnerTotpSecret);

  test("the company card: a typo is refused before the code, and the form keeps what was typed", async () => {
    const form = await openForm("invoice-company", "Change company details…", "Company details");
    await form.getByLabel("Legal name").fill("E2E Invoicing AB");
    await form.getByLabel("Organisation number").fill("556012-5791");
    await form.getByLabel("Your authenticator code").fill("123456");
    await form.getByRole("button", { name: "Save company details" }).click();
    await expect(toast(page, "That isn't a valid Swedish organisation number")).toBeVisible();
    await expect(form.getByLabel("Legal name")).toHaveValue("E2E Invoicing AB");
    await expect(form.getByLabel("Organisation number")).toHaveValue("556012-5791");
    // Refused before the code was checked: the code stays as typed.
    await expect(form.getByLabel("Your authenticator code")).toHaveValue("123456");
    // Cancel puts focus back on the card's verb, and nothing changed.
    await form.getByRole("button", { name: "Cancel" }).click();
    const change = page.getByTestId("invoice-company").getByRole("button", { name: "Change company details…" });
    await expect(change).toBeFocused();
    await expect(page.getByTestId("invoice-company").locator('[data-field="legalName"]')).toHaveText("Not set");
  });

  test("the payment card: saved with the code typed in the form, and the page says who", async () => {
    const form = await openForm("invoice-payment", "Change payment details…", "Payment details");
    await form.getByLabel("Bankgiro").fill("5050-1056");
    await form.getByLabel("Your authenticator code").fill("123456");
    await form.getByRole("button", { name: "Save payment details" }).click();
    await expect(toast(page, "That isn't a valid Bankgiro number")).toBeVisible();
    await expect(form.getByLabel("Bankgiro")).toHaveValue("5050-1056");
    await expect(form.getByLabel("Your authenticator code")).toHaveValue("123456");

    await form.getByLabel("Bankgiro").fill("5050-1055");
    await form.getByLabel("Note on every invoice").fill("Late payment interest per the Interest Act.");
    await form.getByLabel("Your authenticator code").fill(code());
    await form.getByRole("button", { name: "Save payment details" }).click();
    await expect(toast(page, "Payment details saved.")).toBeVisible();
    const card = page.getByTestId("invoice-payment");
    await expect(card.locator('[data-field="bankgiro"]')).toHaveText("5050-1055");
    await expect(card.locator('[data-field="footerNote"]')).toHaveText("Late payment interest per the Interest Act.");
    await expect(page.getByTestId("invoice-payment-changed")).toContainText("Last changed by E2E Vault Owner");
  });
});

test.describe("a draft invoice", () => {
  test.use({ storageState: STORAGE_STATE, locale: "en-US" });

  test("made for a client, lines added and edited in place, totals from the lines, deleted from its menu", async ({ page }) => {
    await page.goto("/invoices");
    await expect(page.getByRole("heading", { name: "Invoices", level: 1 })).toBeVisible();
    const create = page.getByTestId("new-invoice");
    await create.getByLabel("Client").selectOption({ label: seed.clientName });
    await create.getByRole("button", { name: "Create draft" }).click();
    await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Draft invoice", level: 1 })).toBeVisible();
    await expect(page.getByTestId("bill-to")).toContainText(seed.clientName);

    // Title-only: a description and Enter; focus stays for the next one.
    const newLine = page.getByLabel("New line");
    await newLine.fill("Design work");
    await newLine.press("Enter");
    await expect(toast(page, "Line added.")).toBeVisible();
    await expect(newLine).toBeFocused();
    const line = page.getByTestId("invoice-line").filter({ has: page.getByRole("button", { name: /currently Design work$/ }) });
    await expect(line).toHaveCount(1);

    await editInline(page, line, "Qty", "2");
    await editInline(page, line, "Price", "1000");
    await expect(line.getByTestId("invoice-line-amount")).toHaveText("2,000.00");
    await expect(page.getByTestId("invoice-subtotal")).toContainText("2,000.00");
    await expect(page.getByTestId("invoice-vat-group")).toContainText("500.00");
    await expect(page.getByTestId("invoice-total")).toContainText("2,500.00");

    // A second line at the reduced rate, moved up: focus follows its menu.
    await newLine.fill("Books");
    await newLine.press("Enter");
    await expect(toast(page, "Line added.")).toBeVisible();
    const books = page.getByTestId("invoice-line").filter({ has: page.getByRole("button", { name: /currently Books$/ }) });
    await editInline(page, books, "Price", "100");
    await books.getByRole("button", { name: /^Edit VAT, currently/ }).click();
    const rated = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
    await books.getByLabel("VAT", { exact: true }).selectOption({ label: "12 %" });
    await rated;
    await expect(page.getByTestId("invoice-vat-group")).toHaveCount(2);
    // MOVE DOWN, on purpose: React moves the moved row's own node only going
    // down, which is when focus would fall to the page without the fix (going
    // up, the neighbour's node moves and the trigger never detaches — the
    // narrow re-check's low).
    await line.getByRole("button", { name: /^Actions for Design work/ }).click();
    await page.getByRole("menuitem", { name: "Move down" }).click();
    await expect(toast(page, "Line moved.")).toBeVisible();
    await expect(page.getByTestId("invoice-line").first()).toContainText("Books");
    await expect(page.getByRole("button", { name: /^Actions for Design work/ })).toBeFocused();

    // The VAT treatment: leaving Swedish VAT would take Books off 12 %, so it
    // ASKS. "No" keeps the treatment and puts focus back on the select.
    const details = page.getByTestId("draft-details");
    const vatTrigger = details.getByRole("button", { name: /^Edit VAT, currently/ });
    await vatTrigger.click();
    await details.getByLabel("VAT", { exact: true }).selectOption({ label: "Outside the scope of Swedish VAT" });
    const question = page.getByTestId("vat-question");
    await expect(question).toContainText("1 line at 12 or 6 % will change to 0 %.");
    await question.getByRole("button", { name: "No" }).click();
    await expect(question).toHaveCount(0);
    await expect(details.getByRole("button", { name: "Edit VAT, currently Swedish VAT" })).toBeFocused();
    // "Yes" changes it — and the select shows the NEW treatment, never the old one in between.
    await vatTrigger.click();
    await details.getByLabel("VAT", { exact: true }).selectOption({ label: "Outside the scope of Swedish VAT" });
    const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
    await question.getByRole("button", { name: "Yes" }).click();
    await answered;
    await expect(toast(page, "VAT changed: 2 lines have a new rate.")).toBeVisible();
    await expect(details.getByRole("button", { name: "Edit VAT, currently Outside the scope of Swedish VAT" })).toBeVisible();
    await expect(page.getByTestId("invoice-total")).toContainText("2,100.00");

    // Removing a line hands focus to the add field, never to the page.
    await books.getByRole("button", { name: "Actions for Books" }).click();
    await page.getByRole("menuitem", { name: "Remove line" }).click();
    await books.getByRole("button", { name: "Yes" }).click();
    await expect(toast(page, "Line removed.")).toBeVisible();
    await expect(books).toHaveCount(0);
    await expect(newLine).toBeFocused();
    await expect(page.getByTestId("invoice-total")).toContainText("2,000.00");

    // On the list, as a draft with its total.
    const id = new URL(page.url()).pathname.split("/").pop()!;
    await page.goto("/invoices");
    const row = page.locator(`[data-testid="invoice-row"][data-invoice-id="${id}"]`);
    await expect(row).toHaveAttribute("data-status", "DRAFT");
    await expect(row.getByTestId("invoice-row-total")).toContainText("2,000.00");

    // Deleted from its menu, after the question.
    await row.getByRole("link").click();
    await page.getByRole("button", { name: "Draft invoice actions" }).click();
    await page.getByRole("menuitem", { name: "Delete draft" }).click();
    await page.getByRole("button", { name: "Yes" }).click();
    // The toast is raised before the navigation to the list, which can take
    // longer than a toast lives on a cold server: look for it first.
    await expect(toast(page, "Draft deleted.")).toBeVisible();
    await page.waitForURL(/\/invoices$/, { timeout: 15_000 });
    await expect(page.locator(`[data-testid="invoice-row"][data-invoice-id="${id}"]`)).toHaveCount(0);
  });
});
