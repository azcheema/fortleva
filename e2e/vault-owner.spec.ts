import { readFile } from "node:fs/promises";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { readReplyAddressMailLink, requireSeed, type E2ESeed } from "./fixtures/tenant";
import { signInVaultOwner, totpNow } from "./fixtures/vault-session";

/**
 * THE VAULT'S OWNER-ONLY VERBS IN A BROWSER (3V slice 93b — the member-side
 * coverage owed since slices 91 and 92): show a login to the client with
 * an authenticator code and hide it in one click (C59); Settings → Vault,
 * whose switches stand on for an owner and whose sealed-login wait saves
 * (C52 (g)); seal, unseal and an owner's delete of a sealed login (C60);
 * and (slice 95) the export — the code every time, the saved CSV, the
 * exports page (C63).
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

  test("Export… asks the code every time, saves one CSV in Bitwarden's layout, never cached, and lists the export (C63)", async () => {
    const { name, row } = await addLogin("export");
    await page.goto("/vault");
    await page.getByTestId("vault-export-open").click();
    const dialog = page.getByTestId("vault-export-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("The passwords are in plain text");
    await dialog.getByLabel("What to export").selectOption(seed.clientId);
    // No wrong-code round here: the show test above proves the same step-up
    // door refuses one, and this owner's codes share one budget (six in ten
    // minutes) with that test and `portal-logins.spec.ts`'s approval.
    await dialog.getByLabel("Your authenticator code").fill(totpNow(seed.vaultOwnerTotpSecret));
    const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
    const saved = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    const [file, response] = await Promise.all([saved, answered]);
    // The file travels in the action's answer: never kept by a browser or a proxy.
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(file.suggestedFilename()).toMatch(/^fortleva-logins-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = await readFile((await file.path())!, "utf8");
    expect(text.startsWith("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\r\n")).toBe(true);
    // `includes`, never `toContain`: a failing `toContain` prints the whole
    // file — every secret in it — into the public CI log.
    expect(text.includes(name)).toBe(true);
    expect(text.includes(seed.clientName)).toBe(true);
    await expect(page.getByText(/exported\. Import the file, then delete it\./)).toBeVisible();
    await expect(dialog).toBeHidden();

    // Where every holder's notice lands: who exported what, and when.
    await page.goto("/vault/exports");
    const latest = page.getByTestId("vault-export-row").first();
    await expect(latest).toBeVisible({ timeout: 30_000 });
    await expect(latest).toContainText("E2E Vault Owner");
    await expect(latest).toContainText(seed.clientName);

    await page.goto(vault());
    const menu = await menuOf(name);
    await menu.getByRole("menuitem", { name: "Delete" }).click();
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

  /**
   * THE WORKSPACE'S REPLY ADDRESS (Phase 5 slice 100; C68 (c), (f), (i), (k)),
   * end to end — here because asking for one takes a FRESH second factor
   * (C68 (k)), which only this spec's owner has. The owner asks on
   * /settings/preferences; the link goes to THAT address (read out of the dev
   * outbox — its secret exists nowhere else); somebody holding that mailbox,
   * with no Fortleva session at all, opens it, reads which workspace asked,
   * and confirms; the link is then spent; the owner sees the address in
   * force, and stopping it sends replies to the owner's own address again.
   * Whatever happens, it ends with no address set or waiting: the e2e
   * tenant's mail must not keep a reply address for later specs.
   */
  test("the reply address: asked with the code, confirmed from a session-less browser, spent, shown, and stopped", async ({
    browser,
  }) => {
    const address = `replies-${Date.now()}@test.invalid`;
    const card = page.getByTestId("reply-address");
    const ask = async () => {
      await page.goto("/settings/preferences");
      await card.getByLabel("New address for replies").fill(address);
      await card.getByRole("button", { name: "Send confirmation link" }).click();
    };
    try {
      await ask();
      // The factor from the sign-in may have aged past its window by now:
      // then the action sends the owner to the step-up page first.
      const where = await Promise.race([
        page.waitForURL("**/account/step-up**", { timeout: 15_000 }).then(() => "step-up" as const),
        page.getByText(`We emailed a confirmation link to ${address}.`).waitFor({ timeout: 15_000 }).then(() => "sent" as const),
      ]);
      if (where === "step-up") {
        await page.locator("#step-up-code").fill(totpNow(seed.vaultOwnerTotpSecret));
        await page.getByRole("button", { name: "Verify" }).click();
        await page.waitForURL("**/settings/preferences**", { timeout: 15_000 });
        await ask();
        await expect(page.getByText(`We emailed a confirmation link to ${address}.`)).toBeVisible();
      }
      await expect(card.getByTestId("reply-address-pending")).toContainText(address);
      // Nothing changed yet: replies still go to the owner.
      await expect(card.getByTestId("reply-address-now")).toContainText("the owner's address");

      let link: string | null = null;
      await expect.poll(() => (link = readReplyAddressMailLink(address)), { timeout: 10_000 }).not.toBeNull();

      const outsider = await browser.newContext({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block" });
      try {
        const mailbox = await outsider.newPage();
        await mailbox.goto(link!);
        await expect(mailbox.getByRole("heading", { name: "Confirm this reply address" })).toBeVisible();
        await expect(mailbox.getByText(address)).toBeVisible();
        await mailbox.getByRole("button", { name: "Confirm" }).click();
        await expect(mailbox.getByRole("heading", { name: "Address confirmed" })).toBeVisible();
        // Spent: the same link opens nothing now.
        await mailbox.goto(link!);
        await expect(mailbox.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
      } finally {
        await outsider.close();
      }

      await page.reload();
      await expect(card.getByTestId("reply-address-now")).toContainText(address);
      await expect(card.getByTestId("reply-address-now")).toContainText("confirmed on");
      await expect(card.getByTestId("reply-address-pending")).toHaveCount(0);

      await card.getByRole("button", { name: "Stop using this address" }).click();
      const confirm = page.getByTestId("reply-address-remove-confirm");
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "Stop using it" }).click();
      await expect(page.getByText("Replies now go to the owner's address.")).toBeVisible();
      await expect(card.getByTestId("reply-address-now")).toContainText("the owner's address");
    } finally {
      // Back to no address, whatever failed above (the code review's low) —
      // each click waited out, and a cleanup failure never replaces the
      // test's own error (the fix-pass review's low).
      try {
        await page.goto("/settings/preferences");
        const cancel = card.getByRole("button", { name: "Cancel request" });
        if (await cancel.isVisible()) {
          await cancel.click();
          await expect(card.getByTestId("reply-address-pending")).toHaveCount(0);
        }
        const stop = card.getByRole("button", { name: "Stop using this address" });
        if (await stop.isVisible()) {
          await stop.click();
          await page.getByTestId("reply-address-remove-confirm").getByRole("button", { name: "Stop using it" }).click();
          await expect(card.getByTestId("reply-address-now")).toContainText("the owner's address");
        }
      } catch (cleanup) {
        console.warn("reply-address cleanup did not finish:", cleanup);
      }
    }
  });
});
