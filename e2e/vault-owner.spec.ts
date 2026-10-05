import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { requireSeed, type E2ESeed } from "./fixtures/tenant";
import { signInVaultOwner, totpNow } from "./fixtures/vault-session";

/**
 * THE VAULT'S OWNER-ONLY VERBS IN A BROWSER (3V slice 93b — the member-side
 * coverage owed since slices 91 and 92): show a login to the client with
 * an authenticator code and hide it in one click (C59); Settings → Vault,
 * whose switches stand on for an owner and whose sealed-login wait saves
 * (C52 (g)); seal, unseal and an owner's delete of a sealed login (C60).
 *
 * As the fixture's SECOND owner — the one with an enrolled authenticator
 * (`E2ESeed.vaultOwnerEmail`); the first owner has none, and every other
 * spec shares that session. The services' rules are the dbtests'
 * (`portal-logins.dbtest.ts`, `seal.dbtest.ts`, the preferences'); this
 * proves the screens reach them.
 *
 * Each test adds the login it works on and removes it again, so nothing
 * here moves another spec's rows: the client's portal sees a shown login
 * for the few seconds this spec shows one, by a name no other spec looks
 * for. Neither workspace switch is ever turned OFF here — that is for good
 * (C59 (b)), and the share-link and client-login specs rely on both.
 *
 * SERIAL, one signed-in context: a sign-in per test would run into Better
 * Auth's sign-in limiter.
 */

let seed!: E2ESeed;

test.describe.serial("the vault's owner-only verbs, as an owner with an authenticator", () => {
  let context!: BrowserContext;
  let page!: Page;

  test.beforeAll(async ({ browser }) => {
    seed = requireSeed();
    ({ context, page } = await signInVaultOwner(browser, seed));
  });

  test.afterAll(async () => {
    await context?.close();
  });

  const vault = () => `/clients/${seed.clientId}/vault`;
  const rowOf = (name: string) => page.getByTestId("vault-item").filter({ hasText: name });

  /** Add a login on the client's tab; answers its row. */
  const addLogin = async (label: string) => {
    const name = `E2E owner ${label} ${Date.now()}`;
    await page.goto(vault());
    await expect(page.getByTestId("vault-list")).toBeVisible({ timeout: 30_000 });
    const form = page.getByTestId("add-credential");
    await form.locator("#vc-name").fill(name);
    await form.locator("#vc-secret-password").fill(`${label}-${Date.now()}`);
    await form.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(`Added ${name}`)).toBeVisible();
    return { name, row: rowOf(name) };
  };

  const menuOf = async (name: string) => {
    await rowOf(name).getByRole("button", { name: `Actions for ${name}` }).click();
    return page.getByRole("menu");
  };

  test("Show to client… asks the authenticator code every time; Hide from client is one click (C59)", async () => {
    const { name, row } = await addLogin("show");
    await expect(row.getByTestId("client-can-see")).toHaveCount(0);

    const menu = await menuOf(name);
    await menu.getByRole("menuitem", { name: "Show to client…" }).click();
    const dialog = page.getByTestId("show-to-client-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Only the client's main contacts see it");
    // A wrong code is refused in the dialog, and nothing is shown.
    await dialog.getByLabel("Your authenticator code").fill("000000");
    await dialog.getByRole("button", { name: "Show to client" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(row.getByTestId("client-can-see")).toHaveCount(0);
    await dialog.getByLabel("Your authenticator code").fill(totpNow(seed.vaultOwnerTotpSecret));
    await dialog.getByRole("button", { name: "Show to client" }).click();
    await expect(page.getByText("The client can now see this login.")).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(row.getByTestId("client-can-see")).toHaveText("Client can see");

    const again = await menuOf(name);
    await again.getByRole("menuitem", { name: "Hide from client" }).click();
    await expect(page.getByText("The client can no longer see this login.")).toBeVisible();
    await expect(row.getByTestId("client-can-see")).toHaveCount(0);

    const last = await menuOf(name);
    await last.getByRole("menuitem", { name: "Delete" }).click();
    await row.getByRole("button", { name: "Yes" }).click();
    await expect(rowOf(name)).toHaveCount(0);
  });

  test("seal, unseal, and an owner's delete of a sealed login (C60)", async () => {
    const { name, row } = await addLogin("sealed");
    const seal = async () => {
      const menu = await menuOf(name);
      await menu.getByRole("menuitem", { name: "Seal…" }).click();
      const dialog = page.getByTestId("seal-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Seal", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(row.getByTestId("sealed")).toHaveText("Sealed");
    };
    await seal();

    // Unseal: a danger verb, asked first in the row.
    const menu = await menuOf(name);
    await expect(menu.getByRole("menuitem", { name: "Share…" })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Show to client…" })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "Unseal" }).click();
    await row.getByRole("button", { name: "Yes" }).click();
    await expect(page.getByText("Unsealed.")).toBeVisible();
    await expect(row.getByTestId("sealed")).toHaveCount(0);

    // Sealed again — and an owner may delete a sealed login (C60 (b)).
    await seal();
    const again = await menuOf(name);
    await again.getByRole("menuitem", { name: "Delete" }).click();
    await expect(row).toContainText("deleting it ends the seal too");
    await row.getByRole("button", { name: "Yes" }).click();
    await expect(rowOf(name)).toHaveCount(0);
  });

  test("Settings → Vault: both switches stand on and are the owner's to change; the sealed-login wait saves (C52 (g))", async () => {
    await page.goto("/settings/vault");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
    for (const key of ["shareLinks", "clientLogins"]) {
      const control = page.getByTestId(`vault-switch-${key}`).getByRole("switch");
      await expect(control).toBeChecked();
      await expect(control).toBeEnabled();
    }
    const form = page.getByTestId("sealed-wait-form");
    const days = form.locator("#sealed-wait-days");
    // No assertion on where it starts: a retry may find the 8 a failed attempt saved.
    await days.fill("8");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Clients now wait 8 days for an answer.")).toBeVisible();
    // Back to the default, so the client-side spec's asks wait the seeded seven days.
    await days.fill("7");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Clients now wait 7 days for an answer.")).toBeVisible();
  });
});
