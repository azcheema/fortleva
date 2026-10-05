import { expect, test } from "@playwright/test";

import { CONTACT_STORAGE_STATE, readShareCode, requireSeed } from "./fixtures/tenant";

/**
 * THE LOGINS AN AGENCY SHOWS ITS CLIENT, IN A BROWSER (Phase 3V slice 91;
 * founder decisions C52 (d) and (k), C59). The path a client's main
 * contact takes: the portal's nav offers "Logins"; the page is a door —
 * their portal password (a wrong one first), then a six-digit code read
 * from their mail (the dev outbox); behind it the login the seed showed
 * them, its name and username as text and its password masked until the
 * eye is pressed; a reload stays open in this session.
 *
 * The guarantees underneath — the database's gate and switch, main
 * contacts only, the five-check bound, the session binding, the budget,
 * the audit row to the contact, switching off for good — are
 * `src/modules/vault/portal-logins.dbtest.ts`'s. This proves the screens
 * reach them. The seed switched client logins on and showed the WordPress
 * login (`e2e/fixtures/seed-cli.ts`); nothing here switches them off.
 *
 * SERIAL, in Astrid's own portal session. The door's password check spends
 * the portal's per-IP sign-in budget and her own hourly count of checks
 * (ten), so the spec checks twice — once wrong, once right.
 */

const seed = requireSeed();

test.use({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });

test.describe.serial("logins shown to a client — behind the client's door", () => {
  test("the nav offers Logins; the door asks the password, then a mailed code; the eye shows the password", async ({
    page,
  }) => {
    const password = process.env["E2E_CONTACT_PASSWORD"];
    expect(password, "global setup hands the contact's password to the workers").toBeTruthy();

    await page.goto("/portal");
    const surface = page.locator("[data-portal-surface]");
    await expect(surface).toBeVisible({ timeout: 30_000 });
    const nav = surface.locator('[data-slot="portal-nav"]');
    await nav.getByRole("link", { name: "Logins" }).click();
    await expect(page).toHaveURL(/\/portal\/logins$/);
    await expect(nav.getByRole("link", { name: "Logins" })).toHaveAttribute("aria-current", "page");

    const door = page.getByTestId("logins-door");
    const list = page.getByTestId("portal-logins");
    // A RETRY lands where the first attempt left this session: the code step
    // (a door waiting for its mailed code) or already open. The first attempt
    // walks the whole door.
    await expect(door.or(list)).toBeVisible();
    if ((await door.count()) > 0 && (await door.getAttribute("data-step")) === "password") {
      await expect(list).toHaveCount(0);
      expect(await page.content()).not.toContain(seed.vaultLoginName);

      // A wrong password is refused, and mails nothing.
      await door.getByLabel("Your portal password").fill("not-the-password");
      await door.getByRole("button", { name: "Continue" }).click();
      await expect(door).toContainText("That password is not right.");
      await expect(door).toHaveAttribute("data-step", "password");

      const before = readShareCode(seed.contactEmail);
      await door.getByLabel("Your portal password").fill(password!);
      await door.getByRole("button", { name: "Continue" }).click();
      await expect(door).toHaveAttribute("data-step", "code");
      await expect(door).toContainText("A code is on its way to your email address.");
      // A NEW code reached the outbox.
      await expect(() => {
        const code = readShareCode(seed.contactEmail);
        expect(code).not.toBeNull();
        expect(code).not.toBe(before);
      }).toPass({ timeout: 15_000 });
    }
    if ((await door.count()) > 0) {
      await expect(door).toHaveAttribute("data-step", "code");
      // The code, from the mail Astrid was sent last.
      const code = readShareCode(seed.contactEmail);
      expect(code).not.toBeNull();
      await door.getByLabel("Code from the email").fill(code!);
      await door.getByRole("button", { name: "Open my logins" }).click();
    }

    // Behind the door: the login the agency showed, masked; the lock time.
    await expect(list).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("vault-lock")).toBeVisible();
    const row = list.getByTestId("portal-login").filter({ hasText: seed.vaultLoginName });
    await expect(row).toContainText("admin@wp.e2e.test");
    await expect(list.getByTestId("portal-login").filter({ hasText: seed.vaultApiKeyName })).toHaveCount(0);
    const value = row.getByTestId("secret-value");
    await expect(value).toHaveAttribute("data-shown", "false");
    expect(await page.content()).not.toContain(seed.vaultLoginPassword);

    // The keyboard's tap: Enter shows it for a while.
    await row.getByRole("button", { name: "Show Password" }).press("Enter");
    await expect(value).toHaveAttribute("data-shown", "true");
    await expect(value).toHaveText(seed.vaultLoginPassword);

    // Still open in this session after a reload — and masked again.
    await page.reload();
    await expect(page.getByTestId("portal-logins")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("logins-door")).toHaveCount(0);
    await expect(
      page.getByTestId("portal-login").filter({ hasText: seed.vaultLoginName }).getByTestId("secret-value"),
    ).toHaveAttribute("data-shown", "false");
  });

  /**
   * THE SEALED LOGINS (3V slice 93; C52 (f), C61). The seed sealed one login
   * for Astrid's client: she sees a COUNT and never its name (C61 (a)),
   * asks with a reason and her password, sees the ask waiting with her own
   * words, and withdraws it — which leaves the way to ask again. The
   * guarantees underneath (one live ask, the cool-down, who answers, the
   * guard, the opening behind the door) are `sealed.dbtest.ts`'s; nobody
   * here answers, so the login's name never reaches the portal. One more of
   * her hourly password checks (three in all with the test above).
   */
  test("a sealed login: a count only; she asks with a reason and her password, sees it waiting, and withdraws it", async ({
    page,
  }) => {
    const password = process.env["E2E_CONTACT_PASSWORD"];
    expect(password, "global setup hands the contact's password to the workers").toBeTruthy();
    await page.goto("/portal/logins");
    const section = page.getByTestId("sealed-section");
    await expect(section).toBeVisible({ timeout: 30_000 });
    // C61 (a): how many, never which (another spec may seal one more).
    await expect(page.getByText(/keeps \d+ logins? sealed for you/)).toBeVisible();
    expect(await page.content()).not.toContain(seed.vaultSealedLoginName);

    // A RETRY may find the first attempt's ask still waiting: withdraw it first.
    if ((await section.getAttribute("data-state")) === "waiting") {
      await section.getByRole("button", { name: "Withdraw the request" }).click();
      await section.getByRole("button", { name: "Yes" }).click();
      await expect(section).toHaveAttribute("data-state", "withdrawn", { timeout: 15_000 });
    }

    const form = section.getByTestId("sealed-ask-form");
    await form.getByLabel("Why do you need them?").fill("E2E: our developer left and we need the hosting panel.");
    await form.getByLabel("Your portal password").fill(password!);
    await form.getByRole("button", { name: "Ask to open them" }).click();
    await expect(section).toHaveAttribute("data-state", "waiting", { timeout: 15_000 });
    await expect(section.getByTestId("sealed-reason")).toHaveText("E2E: our developer left and we need the hosting panel.");
    await expect(section).toContainText("Waiting for your agency's answer.");
    await expect(section.getByTestId("sealed-ask-form")).toHaveCount(0);
    expect(await page.content()).not.toContain(seed.vaultSealedLoginName);

    // Withdrawn, asked first in place; the way to ask comes back.
    await section.getByRole("button", { name: "Withdraw the request" }).click();
    await section.getByRole("button", { name: "Yes" }).click();
    await expect(section).toHaveAttribute("data-state", "withdrawn", { timeout: 15_000 });
    await expect(section.getByTestId("sealed-ask-form")).toBeVisible();
  });
});
