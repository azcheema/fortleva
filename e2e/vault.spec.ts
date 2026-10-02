import { createHmac } from "node:crypto";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { ageVaultFactor, requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * THE CLIENT'S VAULT TAB IN A BROWSER (Phase 3V slice 85, founder decision
 * C52): the door, the masked list, hold and tap to show, a copy that
 * clears itself, the one-time code, and add / change / delete.
 *
 * As the fixture's VAULT MANAGER — the one member with an enrolled
 * authenticator (`E2ESeed.vaultEmail`). Signing in with a code stamps a
 * fresh factor, which is what opens the vault; the codes are computed here
 * from the fixture's secret, the way Better Auth computes them (HMAC-SHA1
 * keyed by the secret's UTF-8 text, 30-second steps, six digits).
 *
 * The services' guarantees — the door on every verb, the budget, the
 * audit rows, the scope — are `vault.dbtest.ts`'s; the edge's refusals
 * are `respond.test.ts`'s; the clipboard's timing is
 * `clipboard-guard.test.ts`'s. This proves the screen reaches them.
 *
 * SERIAL, one signed-in context for the vault manager: a sign-in per test
 * would run into Better Auth's sign-in limiter, and the last test ages the
 * factor on purpose.
 */

let seed!: E2ESeed;

const totpNow = (secret: string): string => {
  const step = Buffer.alloc(8);
  step.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac("sha1", Buffer.from(secret, "utf8")).update(step).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
};

async function signInVaultManager(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    storageState: { cookies: [], origins: [] },
    serviceWorkers: "block",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await expect(async () => {
    if (/\/home(?:$|[?#])/.test(page.url())) return;
    await page.goto("/login");
    await page.locator("#email").fill(seed.vaultEmail);
    await page.locator("#password").fill(seed.vaultPassword);
    await page.locator('form button[type="submit"]').click();
    await page.locator("#totp").waitFor({ timeout: 15_000 });
    await page.locator("#totp").fill(totpNow(seed.vaultTotpSecret));
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("**/home", { timeout: 15_000 });
  }).toPass({ timeout: 90_000, intervals: [2_000, 4_000, 6_000] });
  return { context, page };
}

test.describe.serial("the client's vault, as a manager with an authenticator", () => {
  let context!: BrowserContext;
  let page!: Page;

  test.beforeAll(async ({ browser }) => {
    seed = requireSeed();
    ({ context, page } = await signInVaultManager(browser));
  });

  test.afterAll(async () => {
    await context?.close();
  });

  const vault = () => `/clients/${seed.clientId}/vault`;
  const rowOf = (name: string) => page.getByTestId("vault-item").filter({ hasText: name });

  test("a fresh factor opens it: every value masked, the lock time shown", async () => {
    await page.goto(vault());
    await expect(page.getByTestId("vault-list")).toBeVisible();
    await expect(page.getByTestId("vault-lock")).toBeVisible();
    await expect(page.getByTestId("vault-door")).toHaveCount(0);
    const row = rowOf(seed.vaultLoginName);
    await expect(row).toContainText("admin@wp.e2e.test");
    await expect(rowOf(seed.vaultApiKeyName)).toBeVisible();
    // Nothing secret reached the page: not in the DOM, not in the RSC payload's text.
    expect(await page.content()).not.toContain(seed.vaultLoginPassword);
    await expect(row.getByTestId("secret-value")).toHaveAttribute("data-shown", "false");
  });

  test("held, the eye shows the password until release; tapped, for a while; the answer is never cached", async () => {
    const field = rowOf(seed.vaultLoginName).locator('[data-slot="secret-field"][data-field="password"]');
    const value = field.getByTestId("secret-value");
    const eye = field.getByRole("button", { name: "Show Password" });

    // HOLD: pointer down, wait for the value, keep holding past the tap threshold, release.
    const box = (await eye.boundingBox())!;
    const answered = page.waitForResponse((r) => r.url().includes("/reveal") && r.request().method() === "POST");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const response = await answered;
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    await expect(value).toHaveText(seed.vaultLoginPassword);
    await page.waitForTimeout(700);
    await page.mouse.up();
    await expect(value).toHaveAttribute("data-shown", "false");
    await expect(value).not.toContainText(seed.vaultLoginPassword);

    // TAP, from the keyboard (a keyboard cannot hold): shown, then hidden by itself.
    await eye.focus();
    await page.keyboard.press("Enter");
    await expect(value).toHaveText(seed.vaultLoginPassword);
    await expect(value).toHaveAttribute("data-shown", "false", { timeout: 15_000 });
  });

  test("copy puts the password on the clipboard, and it clears itself when the member comes back", async () => {
    const field = rowOf(seed.vaultLoginName).locator('[data-slot="secret-field"][data-field="password"]');
    await field.getByRole("button", { name: "Copy Password" }).click();
    await expect(page.getByText("Password copied.", { exact: false })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(seed.vaultLoginPassword);
    // The return to the tab after pasting elsewhere (the 30-second timer is
    // the unit suite's): the window's focus event is what the guard hears.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("");
    // And the copy never showed the value on the page.
    await expect(field.getByTestId("secret-value")).toHaveAttribute("data-shown", "false");
  });

  test("the one-time code is shown on request, with its seconds left", async () => {
    const row = rowOf(seed.vaultLoginName);
    await row.getByRole("button", { name: "Show code" }).click();
    await expect(row.getByTestId("totp-code")).toHaveText(/^\d{3} \d{3}$/);
    await expect(row.locator('[data-slot="totp-field"]')).toContainText(/\d+ s left/);
  });

  test("add a login, change its secret, delete it", async () => {
    const name = `E2E added ${Date.now()}`;
    const first = `first-${Date.now()}`;
    const second = `second-${Date.now()}`;
    const form = page.getByTestId("add-credential");
    await form.locator("#vc-name").fill(name);
    await form.locator("#vc-username").fill("someone@e2e.test");
    await form.locator("#vc-secret-password").fill(first);
    await form.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(`Added ${name}`)).toBeVisible();
    const row = rowOf(name);
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Change secret…" }).click();
    const dialog = page.getByTestId("change-secret-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Password").fill(second);
    await dialog.getByRole("button", { name: "Change" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Changed. The old value is kept in the history.")).toBeVisible();

    const eye = row.locator('[data-slot="secret-field"][data-field="password"]').getByRole("button", { name: "Show Password" });
    await eye.focus();
    await page.keyboard.press("Enter");
    await expect(row.getByTestId("secret-value")).toHaveText(second);
    await page.keyboard.press("Enter"); // a second tap hides it at once

    await row.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await row.getByRole("button", { name: "Yes" }).click();
    await expect(rowOf(name)).toHaveCount(0);
  });

  test("a stale factor locks the whole vault — the list included — and a code opens it again", async () => {
    // A REAL login's id, read while the vault is still open: the reveal
    // path answers NOT_FOUND for an unknown id before it asks for a factor,
    // so only a real one can show the edge refusing the stale factor.
    await page.goto(vault());
    const realId = await rowOf(seed.vaultLoginName).getAttribute("data-credential-id");
    expect(realId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await ageVaultFactor(seed.tenantId, seed.vaultEmail)).toBeGreaterThan(0);
    await page.goto(vault());
    const door = page.getByTestId("vault-door");
    await expect(door).toHaveAttribute("data-remedy", "step_up");
    await expect(page.getByTestId("vault-list")).toHaveCount(0);
    await expect(page.getByText(seed.vaultLoginName)).toHaveCount(0);
    // The reveal route answers the same way the page does.
    const answer = await page.evaluate(async (id) => {
      const r = await fetch(`/api/vault/${id}/totp`, { method: "POST" });
      return { status: r.status, body: (await r.json()) as unknown };
    }, realId);
    expect(answer).toEqual({ status: 401, body: { error: "MFA_REQUIRED", remedy: "step_up" } });

    await door.locator("#step-up-code").fill(totpNow(seed.vaultTotpSecret));
    await door.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByTestId("vault-list")).toBeVisible({ timeout: 15_000 });
    await expect(rowOf(seed.vaultLoginName)).toBeVisible();
  });
});

test("the owner, with no authenticator, finds the door and is sent to set one up", async ({ page }) => {
  seed = requireSeed();
  await page.goto(`/clients/${seed.clientId}/vault`);
  const door = page.getByTestId("vault-door");
  await expect(door).toHaveAttribute("data-remedy", "enrol");
  await expect(page.getByTestId("vault-list")).toHaveCount(0);
  await expect(door.getByRole("link", { name: "Set up an authenticator app" })).toHaveAttribute(
    "href",
    /^\/account\?notice=mfa_required&next=/,
  );
});

test("the reveal edge refuses a request that did not come from the page", async ({ page }) => {
  seed = requireSeed();
  await page.goto(`/clients/${seed.clientId}/vault`);
  // The page's own session, but not a browser fetch: no Sec-Fetch-Site.
  // The cookie is passed by hand — the API client keeps a `Secure` cookie
  // off plain http, and the proxy would then redirect to sign-in, which
  // proves nothing about the route.
  const cookie = (await page.context().cookies())
    .filter((c) => new URL(page.url()).hostname === c.domain.replace(/^\./, ""))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const r = await page.request.post(`/api/vault/00000000-0000-4000-8000-000000000000/reveal`, {
    data: { field: "password" },
    headers: { cookie },
    maxRedirects: 0,
  });
  expect(r.status()).toBe(403);
  expect(await r.json()).toEqual({ error: "CROSS_SITE" });
});
