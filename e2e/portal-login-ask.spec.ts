import { expect, test } from "@playwright/test";

import { CONTACT_STORAGE_STATE, clearLoginAsks, clearPortalSubmissions, requireSeed } from "./fixtures/tenant";
import { signInVaultOwner } from "./fixtures/vault-session";

/**
 * THE AGENCY ASKS A CLIENT FOR A NAMED LOGIN, in a browser (Phase 3V slice
 * 98; founder decision C66). The vertical the dbtest cannot drive: a vault
 * owner's "Ask for a login…" on the client's Vault tab, the asked contact's
 * portal — a COUNT on the home, never the names (View-as renders that page
 * under a member session), the names on "Send us a login" — answering one
 * ask by sending it and the other with "We don't have this", and the team's
 * tab showing how each ended.
 *
 * The guarantees underneath — the guard, who may ask whom and where, the
 * bounds, who is told, the races — are `src/modules/vault/asks.dbtest.ts`'s.
 *
 * Handed back in `afterAll`, never a `finally`: the vault tabs, the portal
 * home and the walks sort after this file.
 */

const seed = requireSeed();

test.use({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });

test.describe.serial("the agency asks a client for a login (C66)", () => {
  const stamp = Date.now();
  const wanted = `E2E hosting panel ${stamp}`;
  const missing = `E2E old registrar ${stamp}`;
  const secret = `e2e-asked-for-${stamp}`;

  test.afterAll(async () => {
    await clearLoginAsks(seed.tenantId, seed.contactEmail);
    await clearPortalSubmissions(seed.tenantId, seed.contactEmail);
  });

  test("the team asks one person from the client's Vault tab — twice", async ({ browser }) => {
    const { context, page } = await signInVaultOwner(browser, seed);
    try {
      await page.goto(`/clients/${seed.clientId}/vault`);
      const open = page.getByTestId("ask-for-login");
      await expect(open).toBeVisible({ timeout: 30_000 });
      for (const [name, note] of [
        [wanted, "For the PHP upgrade"],
        [missing, ""],
      ] as const) {
        await open.click();
        const dialog = page.getByTestId("ask-for-login-dialog");
        await expect(dialog).toBeVisible();
        // The one person with portal access is preselected — the main contact
        // (the SELECTED option, not any option — the code review's nit).
        await expect(dialog.locator("#ask-contact option:checked")).toContainText(seed.contactName);
        await dialog.locator("#ask-name").fill(name);
        if (note) await dialog.locator("#ask-note").fill(note);
        await dialog.getByRole("button", { name: "Ask", exact: true }).click();
        await expect(page.locator("[data-sonner-toast]", { hasText: "Asked." }).first()).toBeVisible({ timeout: 30_000 });
        await expect(dialog).toHaveCount(0);
        await expect(page.getByTestId("login-ask").filter({ hasText: name })).toHaveAttribute("data-state", "open", {
          timeout: 30_000,
        });
      }
    } finally {
      await context.close();
    }
  });

  test("the person asked: a count at home, never the names — the names on the send page", async ({ page }) => {
    await page.goto("/portal");
    const item = page.locator('[data-slot="portal-action-item"][data-kind="login-ask"]');
    await expect(item).toContainText("Your agency asked you for 2 logins", { timeout: 30_000 });
    await expect(page.locator("body")).not.toContainText(wanted);
    await expect(page.locator("body")).not.toContainText(missing);
    await item.getByRole("link", { name: "Open" }).click();
    await expect(page).toHaveURL(/\/portal\/send-login$/);
    await expect(page.locator('[data-slot="login-ask"]').filter({ hasText: wanted })).toBeVisible();
    await expect(page.locator('[data-slot="login-ask"]').filter({ hasText: missing })).toBeVisible();
  });

  test("sends one: the form starts from the ask, and it lands where the ask said", async ({ page }) => {
    await page.goto("/portal/send-login");
    await page.locator('[data-slot="login-ask"]').filter({ hasText: wanted }).getByRole("link", { name: "Answer" }).click();
    await expect(page).toHaveURL(/\/portal\/send-login\?ask=/);
    await expect(page.getByText(`Your agency asked for: ${wanted}`)).toBeVisible();
    await expect(page.locator('[data-slot="ask-note"]')).toContainText("For the PHP upgrade");
    const form = page.getByTestId("send-login-form");
    await expect(form.locator("#sl-name")).toHaveValue(wanted);
    // No project picker: the ask says where it lands.
    await expect(form.locator("#sl-project")).toHaveCount(0);
    await form.locator("#sl-secret-password").fill(secret);
    await form.getByRole("button", { name: "Send to your agency" }).click();
    await expect(page).toHaveURL(/\/portal\/send-login\?sent=1$/, { timeout: 30_000 });
    await expect(page.locator('[data-slot="login-ask"]').filter({ hasText: wanted })).toHaveCount(0);
    await expect(page.locator('[data-slot="sent-login"]').filter({ hasText: wanted })).toBeVisible();
    expect(await page.content()).not.toContain(secret);
  });

  test("declines the other with a note; its old link then says it is no longer open", async ({ page }) => {
    await page.goto("/portal/send-login");
    await page.locator('[data-slot="login-ask"]').filter({ hasText: missing }).getByRole("link", { name: "Answer" }).click();
    await expect(page).toHaveURL(/\/portal\/send-login\?ask=/);
    const askUrl = page.url();
    const decline = page.getByTestId("decline-ask-form");
    await decline.locator("#decline-note").fill("Ask our IT person, Sam");
    await decline.getByRole("button", { name: "We don't have this" }).click();
    await expect(page).toHaveURL(/\/portal\/send-login\?declined=1$/, { timeout: 30_000 });
    await expect(page.getByRole("status").filter({ hasText: "Your agency has been told." })).toBeVisible();
    await page.goto(askUrl);
    await expect(page.getByRole("status").filter({ hasText: "This request is no longer open." })).toBeVisible();
    await expect(page.getByTestId("decline-ask-form")).toHaveCount(0);
    // Nothing left to answer: the home has no such row.
    await page.goto("/portal");
    await expect(page.locator('[data-slot="portal-action-item"][data-kind="login-ask"]')).toHaveCount(0);
  });

  test("the team sees how each ended — the login it became, and the client's note", async ({ browser }) => {
    const { context, page } = await signInVaultOwner(browser, seed);
    try {
      await page.goto(`/clients/${seed.clientId}/vault`);
      const sent = page.getByTestId("login-ask").filter({ hasText: wanted });
      await expect(sent).toHaveAttribute("data-state", "sent", { timeout: 30_000 });
      await expect(sent.getByRole("link", { name: "Show the login" })).toBeVisible();
      const declined = page.getByTestId("login-ask").filter({ hasText: missing });
      await expect(declined).toHaveAttribute("data-state", "declined");
      await expect(declined).toContainText("Ask our IT person, Sam");
      // The login sent in answer is in the client's vault, marked as sent by the client.
      await expect(page.getByTestId("vault-item").filter({ hasText: wanted }).getByTestId("sent-by-client")).toContainText(
        "Sent by",
      );
    } finally {
      await context.close();
    }
  });
});
