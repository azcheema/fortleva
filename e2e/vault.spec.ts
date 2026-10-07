import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { SLOW } from "./fixtures/keys";
import { ageVaultFactor, flagLogin, requireSeed, type E2ESeed } from "./fixtures/tenant";
import { signInVaultManager, totpNow } from "./fixtures/vault-session";

/**
 * THE VAULT IN A BROWSER (Phase 3V slices 85–86, founder decision C52):
 * the client's tab — the door, the masked list, hold and tap to show, a
 * copy that clears itself, the one-time code, and add / change / delete —
 * then the tenant's `/vault` (our own first, the client filter, `G V`) and
 * a project's tab, which share its rows, form and door.
 *
 * As the fixture's VAULT MANAGER — the one member with an enrolled
 * authenticator (`E2ESeed.vaultEmail`). Signing in with a code stamps a
 * fresh factor, which is what opens the vault; the codes are computed from
 * the fixture's secret the way Better Auth computes them
 * (`fixtures/vault-session.ts`, shared with the share-link spec).
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

test.describe.serial("the vault — a client's tab, /vault and a project's tab — as a manager with an authenticator", () => {
  let context!: BrowserContext;
  let page!: Page;

  test.beforeAll(async ({ browser }) => {
    seed = requireSeed();
    ({ context, page } = await signInVaultManager(browser, seed));
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
    // Slice 91: the seed shows this login to the client — the row says so,
    // and a manager (no `credential:change_visibility`) gets no verb for it.
    await expect(row.getByTestId("client-can-see")).toHaveText("Client can see");
    await expect(rowOf(seed.vaultApiKeyName).getByTestId("client-can-see")).toHaveCount(0);
    await row.getByRole("button", { name: `Actions for ${seed.vaultLoginName}` }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Share…" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /client/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
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

  test("seal a login (slice 92): it says so, and neither shares nor deletes — only an owner unseals", async () => {
    // Its own login: a manager cannot delete a sealed one afterwards (C60
    // (b)) and the fixture has no owner with an authenticator, so this row
    // stays in the e2e tenant — named so it is never mistaken for a seed row.
    const name = `E2E sealed ${Date.now()}`;
    const form = page.getByTestId("add-credential");
    await form.locator("#vc-name").fill(name);
    await form.locator("#vc-secret-password").fill(`sealed-${Date.now()}`);
    await form.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(`Added ${name}`)).toBeVisible();
    const row = rowOf(name);
    await expect(row.getByTestId("sealed")).toHaveCount(0);

    await row.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Seal…" }).click();
    const dialog = page.getByTestId("seal-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Only an owner can unseal it or delete it.");
    await dialog.getByRole("button", { name: "Seal", exact: true }).click();
    await expect(page.getByText("Sealed. Only an owner can unseal it.")).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(row.getByTestId("sealed")).toHaveText("Sealed");

    // The team keeps using it: the eye and Change secret… are still there.
    await expect(
      row.locator('[data-slot="secret-field"][data-field="password"]').getByRole("button", { name: "Show Password" }),
    ).toBeVisible();
    await row.getByRole("button", { name: `Actions for ${name}` }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Change secret…" })).toBeVisible();
    // Never shared (C60 (a)); deleted and unsealed by an owner only (C60 (b)).
    await expect(menu.getByRole("menuitem", { name: "Share…" })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Unseal" })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Seal…" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  // ── Slice 86: /vault and the project's Vault tab ─────────────────────
  const group = (key: string) => page.locator(`[data-testid="vault-group"][data-group="${key}"]`);
  const filter = () => page.getByTestId("vault-filter").locator("select");

  test("G V opens /vault: our own first, then each client's under its name; the filter narrows it", async () => {
    await page.goto("/home");
    await expect(page.getByRole("link", { name: "Vault", exact: true }).first()).toBeVisible();
    // Retried: a key pressed before the shell's one listener has hydrated
    // is lost, and nothing on the page says when that is. Each attempt
    // waits long enough for /vault (the door, the index, the list) to
    // commit: a press during a pending navigation would cancel it.
    await expect(async () => {
      await page.keyboard.press("g");
      await page.keyboard.press("v");
      await page.waitForURL(/\/vault$/, { timeout: 8_000 * SLOW });
    }).toPass({ timeout: 30_000 * SLOW });
    const groups = page.getByTestId("vault-group");
    await expect(groups.first()).toHaveAttribute("data-group", "agency");
    await expect(groups.first()).toContainText(seed.vaultAgencyLoginName);
    await expect(group("agency").getByTestId("vault-item").filter({ hasText: seed.vaultLoginName })).toHaveCount(0);
    const theirs = group(seed.clientId);
    await expect(theirs.getByRole("link", { name: seed.clientName, exact: true })).toHaveAttribute(
      "href",
      `/clients/${seed.clientId}/vault`,
    );
    await expect(theirs.getByTestId("vault-item").filter({ hasText: seed.vaultLoginName })).toBeVisible();
    // A project's login wears the project's key.
    await expect(theirs.getByTestId("vault-item").filter({ hasText: seed.vaultApiKeyName })).toContainText(seed.projectKey);
    expect(await page.content()).not.toContain(seed.vaultLoginPassword);

    await filter().selectOption(seed.clientId);
    await page.waitForURL(new RegExp(`/vault\\?client=${seed.clientId}$`));
    await expect(group("agency")).toHaveCount(0);
    await expect(theirs.getByTestId("vault-item").filter({ hasText: seed.vaultLoginName })).toBeVisible();
    await filter().selectOption("agency");
    await page.waitForURL(/\/vault\?client=agency$/);
    await expect(group(seed.clientId)).toHaveCount(0);
    await expect(group("agency")).toContainText(seed.vaultAgencyLoginName);
    await expect(filter()).toHaveValue("agency");
  });

  test("logins marked to change (slice 94): /vault says how many and lists them; changing a secret clears its mark", async () => {
    const stamp = Date.now();
    const names = [`E2E change soon A ${stamp}`, `E2E change soon B ${stamp}`] as const;
    await page.goto(vault());
    const form = page.getByTestId("add-credential");
    for (const name of names) {
      await form.locator("#vc-name").fill(name);
      await form.locator("#vc-secret-password").fill(`first-${stamp}`);
      await form.getByRole("button", { name: "Add" }).click();
      await expect(page.getByText(`Added ${name}`)).toBeVisible();
      // Removing a member is what marks a login (`offboarding.dbtest.ts`); the
      // fixture's members must stay, so the mark is set straight on the row.
      expect(await flagLogin(seed.tenantId, name)).toBe(1);
    }

    await page.goto("/vault");
    const line = page.getByTestId("vault-change-soon");
    await expect(line).toContainText("2 logins need changing");
    await line.getByRole("link", { name: "Show the list" }).click();
    await page.waitForURL(/\/vault\?client=change-soon$/);
    await expect(filter()).toHaveValue("change-soon");
    await expect(page.getByTestId("vault-change-soon")).toHaveCount(0);
    await expect(page.getByTestId("vault-item")).toHaveCount(2);
    for (const name of names) await expect(rowOf(name).getByTestId("needs-rotation")).toHaveText("Change soon");

    const changeSecret = async (name: string) => {
      await rowOf(name).getByRole("button", { name: `Actions for ${name}` }).click();
      await page.getByRole("menuitem", { name: "Change secret…" }).click();
      const dialog = page.getByTestId("change-secret-dialog");
      await dialog.getByLabel("Password").fill(`second-${stamp}`);
      await dialog.getByRole("button", { name: "Change" }).click();
      await expect(dialog).toBeHidden();
    };
    // The first change takes its row OFF this list with the revalidation —
    // the dialog and form with it — and still says it worked (the code
    // review's medium: the toast used to live in an effect of that form).
    await changeSecret(names[0]);
    // Exactly once: nothing else on this page carries the text.
    await expect(page.getByText("Changed. The old value is kept in the history.")).toHaveCount(1);
    await expect(rowOf(names[0])).toHaveCount(0);
    await expect(page.getByTestId("vault-item")).toHaveCount(1);
    await expect(filter()).toHaveValue("change-soon");
    // The last one: with none left the view is all of them again, unmarked.
    await changeSecret(names[1]);
    await expect(filter()).toHaveValue("");
    for (const name of names) {
      await expect(rowOf(name)).toBeVisible();
      await expect(rowOf(name).getByTestId("needs-rotation")).toHaveCount(0);
    }

    for (const name of names) {
      const row = rowOf(name);
      await row.getByRole("button", { name: `Actions for ${name}` }).click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await row.getByRole("button", { name: "Yes" }).click();
      await expect(rowOf(name)).toHaveCount(0);
    }
  });

  test("one of our own logins is added on /vault and deleted there", async () => {
    await page.goto("/vault");
    const name = `E2E own ${Date.now()}`;
    const form = page.getByTestId("add-credential");
    // One place it can go — ours — so nothing to choose, but it is said.
    await expect(form.locator("#vc-where")).toHaveCount(0);
    await expect(form.getByTestId("add-credential-where")).toHaveText("Belongs to: Us — no client");
    await expect(form.locator("#vc-name")).toHaveAccessibleDescription("Belongs to: Us — no client");
    await form.locator("#vc-name").fill(name);
    await form.locator("#vc-secret-password").fill(`own-${Date.now()}`);
    await form.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(`Added ${name}`)).toBeVisible();
    const row = group("agency").getByTestId("vault-item").filter({ hasText: name });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await row.getByRole("button", { name: "Yes" }).click();
    await expect(row).toHaveCount(0);
  });

  test("a project's Vault tab lists that project's logins only; one added there is the project's", async () => {
    await page.goto(`/projects/${seed.projectKey}/vault`);
    await expect(page.locator('[data-slot="tab-strip"]').getByRole("link", { name: "Vault", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByTestId("vault-lock")).toBeVisible();
    await expect(rowOf(seed.vaultApiKeyName)).toBeVisible();
    // The client's own login is the client's, not this project's.
    await expect(rowOf(seed.vaultLoginName)).toHaveCount(0);

    const name = `E2E project login ${Date.now()}`;
    const form = page.getByTestId("add-credential");
    await expect(form.locator("#vc-where")).toHaveCount(0);
    await expect(form.getByTestId("add-credential-where")).toContainText(seed.projectKey);
    await form.locator("#vc-name").fill(name);
    await form.locator("#vc-secret-password").fill(`proj-${Date.now()}`);
    await form.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(`Added ${name}`)).toBeVisible();
    await expect(rowOf(name)).toBeVisible();

    // On the client's tab it is one of the client's, badged with the project.
    await page.goto(vault());
    const row = rowOf(name);
    await expect(row).toContainText(seed.projectKey);
    await row.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await row.getByRole("button", { name: "Yes" }).click();
    await expect(rowOf(name)).toHaveCount(0);
  });

  test("search finds a login while the vault is open (slice 97): ⌘K opens it on its own row; /search says until when", async () => {
    const find = async (name: string) => {
      await page.goto("/home");
      const dialog = page.getByRole("dialog");
      // Retried, as G V is: a key pressed before the shell's one listener
      // has hydrated is lost, and nothing on the page says when that is.
      await expect(async () => {
        await page.keyboard.press("ControlOrMeta+k");
        await expect(dialog).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 20_000 * SLOW });
      await dialog.getByRole("combobox").fill(name);
      const hit = dialog.getByRole("option").filter({ hasText: name });
      await expect(hit.first()).toBeVisible({ timeout: 20_000 * SLOW });
      // The vault is open: logins were searched, so no line says otherwise.
      await expect(page.getByTestId("palette-vault-locked")).toHaveCount(0);
      return hit.first();
    };

    // A client's login: under the client's name, onto /vault's view of
    // that client (it needs only the door — never a 404 for a custom role).
    const clientHit = await find(seed.vaultLoginName);
    await expect(clientHit).toContainText(seed.clientName);
    await clientHit.click();
    await expect(page).toHaveURL(new RegExp(`/vault\\?client=${seed.clientId}#credential-[0-9a-f-]{36}$`));
    const clientRow = page.locator(`#credential-${new URL(page.url()).hash.slice("#credential-".length)}`);
    await expect(clientRow).toHaveAttribute("data-name", seed.vaultLoginName);
    await expect(clientRow).toBeInViewport();
    expect(await page.content()).not.toContain(seed.vaultLoginPassword);

    // One of our own: onto /vault's "our own" view.
    await (await find(seed.vaultAgencyLoginName)).click();
    await expect(page).toHaveURL(/\/vault\?client=agency#credential-[0-9a-f-]{36}$/);
    const ownRow = page.locator(`#credential-${new URL(page.url()).hash.slice("#credential-".length)}`);
    await expect(ownRow).toHaveAttribute("data-name", seed.vaultAgencyLoginName);

    // /search shows the login too — and, with a login on screen, when the
    // vault locks: the page locks itself then, as every vault page does.
    await page.goto(`/search?q=${encodeURIComponent(seed.vaultLoginName)}`);
    await expect(page.locator('[data-testid="search-hit"][data-entity-type="CREDENTIAL_ITEM"]')).toContainText(seed.vaultLoginName);
    await expect(page.getByTestId("vault-lock")).toBeVisible();
    await expect(page.getByTestId("search-vault-locked")).toHaveCount(0);
  });

  test("a stale factor locks the whole vault — the list included — and a code opens it again", async () => {
    // A REAL login's id, read while the vault is still open: the reveal
    // path answers NOT_FOUND for an unknown id before it asks for a factor,
    // so only a real one can show the edge refusing the stale factor.
    await page.goto(vault());
    const realId = await rowOf(seed.vaultLoginName).getAttribute("data-credential-id");
    expect(realId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await ageVaultFactor(seed.tenantId, seed.vaultEmail)).toBeGreaterThan(0);
    // Search stops naming logins, and says why (slice 97, C65 (a)).
    await page.goto(`/search?q=${encodeURIComponent(seed.vaultLoginName)}`);
    await expect(page.getByTestId("search-vault-locked")).toBeVisible();
    await expect(page.locator('[data-testid="search-hit"][data-entity-type="CREDENTIAL_ITEM"]')).toHaveCount(0);
    await expect(page.getByTestId("search-vault-locked").getByRole("link", { name: "Open the vault" })).toHaveAttribute(
      "href",
      "/vault",
    );
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

test("the owner, with no authenticator: ⌘K says logins were not searched, on any query, and never names one (slice 97, C65 (a))", async ({
  page,
}) => {
  seed = requireSeed();
  await page.goto("/home");
  const dialog = page.getByRole("dialog");
  // Retried, as G V is: a key pressed before the shell's one listener has
  // hydrated is lost.
  await expect(async () => {
    await page.keyboard.press("ControlOrMeta+k");
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 * SLOW });
  // A LINE under the list, never a row: it is not a result.
  const line = dialog.getByTestId("palette-vault-locked");

  await dialog.getByRole("combobox").fill(seed.vaultLoginName);
  await expect(line).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(line).toContainText("Logins aren't searched while the vault is locked.");
  await expect(dialog.getByRole("option").filter({ hasText: seed.vaultLoginName })).toHaveCount(0);

  // A query nothing matches gets the same line — it says nothing about what
  // the vault holds — and still says "No results.", and Enter there goes
  // nowhere (the review: as a row, the line was what Enter opened).
  await dialog.getByRole("combobox").fill(`zzqqnothing${Date.now()}`);
  await expect(line).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(dialog.getByText("No results.")).toBeVisible();
  await page.keyboard.press("Enter");
  // `data-state`, not "visible": Radix flips it to `closed` at once, while
  // the content stays visible through its exit animation (the review — a
  // visibility check here could not have failed).
  await expect(dialog).toHaveAttribute("data-state", "open");
  await expect(dialog.getByRole("combobox")).toBeFocused();
  await expect(page).toHaveURL(/\/home$/);

  // The link is the next tab stop, outside cmdk's key handling: a single
  // key there must not act on the page behind the palette (the review: `T`
  // stopped a running timer) — `?` opens no shortcut overlay.
  const link = line.getByRole("link", { name: "Open the vault" });
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  await page.keyboard.press("?");
  // A key's update is a discrete one, committed before the press returns;
  // one more frame so a check here cannot pass before the overlay could open.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  await expect(page.getByRole("dialog", { name: /shortcut/i })).toHaveCount(0);
  await expect(dialog).toHaveAttribute("data-state", "open");

  await link.click();
  await expect(page).toHaveURL(/\/vault$/);
  await expect(page.getByTestId("vault-door")).toHaveAttribute("data-remedy", "enrol");
  await expect(dialog).toHaveCount(0);
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
