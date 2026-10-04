import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { readShareCode, requireSeed, type E2ESeed } from "./fixtures/tenant";
import { signInVaultManager, totpNow } from "./fixtures/vault-session";

/**
 * SHARE LINKS IN A BROWSER (Phase 3V slice 90; CP4: an emailed code,
 * opened once, within 7 days). The whole path a person takes: the vault
 * manager makes a link from the login's row — the dialog asks for their
 * authenticator code every time — and copies it; somebody signed in
 * NOWHERE opens it, asks for a code, reads it from their mail (the dev
 * outbox), types a wrong one and then the right one, and sees the
 * password once; a reload is the dead link. Back in the vault the link
 * reads "Opened", and a second link revoked there is dead for its holder.
 *
 * The guarantees underneath — view-once under concurrency, the five-check
 * bound, the guard, the TTL, a changed secret — are `share.dbtest.ts`'s;
 * the share route's distance from `withPlatform` is
 * `share-route-boundary.test.ts`'s. This proves the screens reach them.
 *
 * SERIAL, one signed-in context for the vault manager (a sign-in per test
 * would meet the sign-in limiter), and a fresh, cookieless context for
 * every visit to a link. Two links in all — two step-ups, with
 * `vault.spec.ts`'s one — so even a retried run stays inside the member's
 * step-up budget (six in ten minutes).
 */

let seed!: E2ESeed;

const RUN = Date.now().toString(36);
const RECIPIENT = `e2e-share-${RUN}@test.invalid`;
const SECOND = `e2e-share-revoke-${RUN}@test.invalid`;

/** A visitor with no session anywhere — the recipient of a link. */
async function stranger(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    storageState: { cookies: [], origins: [] },
    serviceWorkers: "block",
  });
  return { context, page: await context.newPage() };
}

test.describe.serial("share links — made in the vault, opened once with a mailed code", () => {
  let context!: BrowserContext;
  let page!: Page;
  let link!: string;

  test.beforeAll(async ({ browser }) => {
    seed = requireSeed();
    ({ context, page } = await signInVaultManager(browser, seed));
  });

  test.afterAll(async () => {
    await context?.close();
  });

  const openShareDialog = async () => {
    await page.goto(`/clients/${seed.clientId}/vault`);
    const row = page.getByTestId("vault-item").filter({ hasText: seed.vaultLoginName });
    await row.getByRole("button", { name: `Actions for ${seed.vaultLoginName}` }).click();
    await page.getByRole("menuitem", { name: "Share…" }).click();
    const dialog = page.getByTestId("share-dialog");
    await expect(dialog).toBeVisible();
    return dialog;
  };

  /** Make a link for `email` through the dialog; its path (the URL is absolute). */
  const makeLink = async (email: string) => {
    const dialog = await openShareDialog();
    await dialog.getByLabel("Their email address").fill(email);
    await dialog.getByLabel("Your authenticator code").fill(totpNow(seed.vaultTotpSecret));
    await dialog.getByRole("button", { name: "Create link" }).click();
    const url = dialog.getByTestId("share-url");
    await expect(url).toBeVisible();
    const href = await url.inputValue();
    expect(href).toMatch(/\/portal\/share\/[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    return { dialog, path: new URL(href).pathname };
  };

  test("a manager makes a link: the dialog asks for an authenticator code, and shows the link once", async () => {
    const dialog = await openShareDialog();
    // A refused attempt keeps what was typed (React 19 resets a `<form
    // action>` on every action). A code too short to be one is refused
    // before the step-up, so this spends none of the member's six.
    await dialog.getByLabel("Their email address").fill(RECIPIENT);
    await dialog.getByLabel("Your authenticator code").fill("12345");
    await dialog.getByRole("button", { name: "Create link" }).click();
    await expect(dialog.getByText("Enter the 6-digit code from your authenticator app.")).toBeVisible();
    await expect(dialog.getByLabel("Their email address")).toHaveValue(RECIPIENT);
    await expect(dialog.getByTestId("share-url")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);

    const made = await makeLink(RECIPIENT);
    link = made.path;
    await expect(made.dialog.getByTestId("share-link").filter({ hasText: RECIPIENT })).toHaveAttribute(
      "data-status",
      "waiting",
    );
    // Nothing secret reached the member's page either.
    expect(await page.content()).not.toContain(seed.vaultLoginPassword);
    await made.dialog.getByRole("button", { name: "Done" }).click();
    await expect(made.dialog).toHaveCount(0);
  });

  test("the recipient, signed in nowhere, asks for a code, types it, and sees the password — once", async ({ browser }) => {
    const { context: anon, page: visitor } = await stranger(browser);
    try {
      await visitor.goto(link);
      await expect(visitor.getByText("has shared a login with you")).toBeVisible();
      // Loading the page spent nothing: no code was mailed, and nothing of the login is on it.
      expect(readShareCode(RECIPIENT)).toBeNull();
      await expect(visitor.locator("body")).not.toContainText(seed.vaultLoginName);

      await visitor.getByRole("button", { name: "Email me a code" }).click();
      let code: string | null = null;
      await expect.poll(() => (code = readShareCode(RECIPIENT)), { timeout: 15_000 }).not.toBeNull();

      // A wrong code: told how many tries are left.
      await visitor.getByLabel("Code from the email").fill(code === "000000" ? "111111" : "000000");
      await visitor.getByRole("button", { name: "Show the login" }).click();
      await expect(visitor.getByText("That code is not right. 4 tries left.")).toBeVisible();

      await visitor.getByLabel("Code from the email").fill(code!);
      await visitor.getByRole("button", { name: "Show the login" }).click();
      const shown = visitor.getByTestId("share-shown");
      await expect(shown).toBeVisible();
      await expect(shown).toContainText(seed.vaultLoginName);
      await expect(shown).toContainText("admin@wp.e2e.test");
      // Masked until asked for.
      await expect(shown.getByTestId("share-value")).toHaveCount(0);
      await shown.getByRole("button", { name: "Show", exact: true }).click();
      await expect(shown.getByTestId("share-value")).toHaveText(seed.vaultLoginPassword);

      // Once: the same address again is the dead link, and the value is gone.
      await visitor.reload();
      await expect(visitor.getByText("This link cannot be opened")).toBeVisible();
      await expect(visitor.locator("body")).not.toContainText(seed.vaultLoginPassword);
    } finally {
      await anon.close();
    }
  });

  test("the vault lists it as opened; a second link, revoked there, is dead for whoever holds it", async ({ browser }) => {
    const made = await makeLink(SECOND);
    const links = made.dialog.getByTestId("share-link");
    await expect(links.filter({ hasText: RECIPIENT })).toHaveAttribute("data-status", "viewed");
    const second = links.filter({ hasText: SECOND });
    await expect(second).toHaveAttribute("data-status", "waiting");
    await second.getByRole("button", { name: "Revoke" }).click();
    await expect(page.locator("[data-sonner-toast]", { hasText: "Link revoked." })).toBeVisible();
    await expect(second).toHaveAttribute("data-status", "revoked");
    await made.dialog.getByRole("button", { name: "Done" }).click();

    const { context: anon, page: visitor } = await stranger(browser);
    try {
      await visitor.goto(made.path);
      await expect(visitor.getByText("This link cannot be opened")).toBeVisible();
      expect(readShareCode(SECOND)).toBeNull();
    } finally {
      await anon.close();
    }
  });
});
