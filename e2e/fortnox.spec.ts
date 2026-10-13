import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { STORAGE_STATE, forgetFortnox, readyInvoicing, requireSeed, resetInvoiceDetails, type E2ESeed } from "./fixtures/tenant";
import { signInVaultOwner, totpNow } from "./fixtures/vault-session";

/**
 * THE FORTNOX CARD IN A BROWSER (Phase 4 slice 114; founder decision C89),
 * against the harness's FAKE Fortnox (`FORTNOX_TRANSPORT=fake`, whose consent
 * screen is our own route and sends the browser straight back):
 *
 *   - as an owner with NO authenticator: what Fortnox needs, and to set one up
 *     first — no Connect to press;
 *   - as the owner WITH one (C89 (d)): Connect asks the code in the card, goes
 *     to the consent screen and comes back through the callback; the card says
 *     Connected, names the company (the workspace's own, by its org. number),
 *     and — just connected — asks Fortnox whether it is ready. The outcome is
 *     read from the owner's OWN attempt row: a made-up attempt id in the URL
 *     paints nothing (the design review's S9).
 *
 * ONE CODE SPENT, ON PURPOSE (`invoices.spec.ts`'s note): the TOTP owner's
 * step-ups are six per ten minutes, shared with later specs — so the
 * disconnect (another code) is the database test's, and the fixture CLI puts
 * the workspace back (`forget-fortnox`, `reset-invoice-details`).
 */

const seed: E2ESeed = requireSeed();

test.describe("the Fortnox card, as an owner with no authenticator", () => {
  test.use({ storageState: STORAGE_STATE, locale: "en-US" });

  test("says what Fortnox needs, and to set up an authenticator first", async ({ page }) => {
    await page.goto("/settings/invoicing");
    const card = page.getByTestId("fortnox-card");
    await expect(card).toContainText("Fortnox needs");
    await expect(card).toContainText("a voucher series F, marked manual");
    await expect(page.getByTestId("fortnox-needs-factor")).toBeVisible();
    await expect(card.getByRole("button", { name: "Connect to Fortnox…" })).toHaveCount(0);
  });
});

test.describe.serial("connecting Fortnox, as the owner with an authenticator (C89 (d))", () => {
  let context!: BrowserContext;
  let page!: Page;

  test.beforeAll(async ({ browser }) => {
    await forgetFortnox(seed.tenantId);
    // The company card's org. number — the one Fortnox's company must have.
    await readyInvoicing(seed.tenantId, seed.clientId);
    ({ context, page } = await signInVaultOwner(browser, seed));
  });
  test.afterAll(async () => {
    await context?.close();
    await forgetFortnox(seed.tenantId);
    await resetInvoiceDetails(seed.tenantId);
  });

  test("Connect with the code, approve at Fortnox, and come back connected — and Fortnox is ready", async () => {
    await page.goto("/settings/invoicing");
    const card = page.getByTestId("fortnox-card");
    await card.getByRole("button", { name: "Connect to Fortnox…" }).click();
    const form = card.getByRole("form", { name: "Connect to Fortnox" });
    const code = form.getByLabel("Your authenticator code");
    await expect(code).toBeFocused();
    await code.fill(totpNow(seed.vaultOwnerTotpSecret));
    await form.getByRole("button", { name: "Go to Fortnox" }).click();

    // The fake's consent screen, the callback, and back to the card.
    await page.waitForURL(/\/settings\/invoicing\?attempt=[0-9a-f-]{36}/);
    await expect(page.getByTestId("fortnox-outcome")).toHaveAttribute("data-outcome", "CONNECTED");
    await expect(page.getByTestId("fortnox-company")).toHaveText("E2E Invoicing AB");
    await expect(page.getByTestId("fortnox-active")).toBeVisible();
    // Just connected, the card asks Fortnox once whether it is ready.
    const check = page.getByTestId("fortnox-check-result");
    await expect(check).toHaveAttribute("data-ok", "true");
    await expect(check).toContainText("Fortnox is ready.");
    await expect(check).toContainText("All 10 accounts exist and are active.");
  });

  test("the outcome is the owner's own: an attempt id in the URL that is not theirs paints nothing", async () => {
    await page.goto("/settings/invoicing?attempt=01900000-0000-7000-8000-000000000000#fortnox");
    await expect(page.getByTestId("fortnox-active")).toBeVisible();
    await expect(page.getByTestId("fortnox-outcome")).toHaveCount(0);
    await expect(page.getByTestId("fortnox-disconnect")).toBeVisible();
    // Asked again by hand.
    await page.getByTestId("fortnox-check").click();
    await expect(page.getByTestId("fortnox-check-result")).toHaveAttribute("data-ok", "true");
  });
});
