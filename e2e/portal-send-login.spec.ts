import { expect, test } from "@playwright/test";

import {
  CONTACT_STORAGE_STATE,
  STORAGE_STATE,
  clearPortalSubmissions,
  readPortalSubmissions,
  requireSeed,
} from "./fixtures/tenant";
import { signInVaultOwner } from "./fixtures/vault-session";

/**
 * A CLIENT HANDS A LOGIN OVER, in a browser (Phase 3V slice 96; founder
 * decision C64). The whole vertical the dbtest cannot drive: a contact
 * cookie, `requirePortalContext()`, the server action, the broker's two
 * transactions — and then the database read back for what the portal never
 * shows: the login is INTERNAL, has no member author, and its audit row
 * names the CONTACT though a system transaction wrote it. The team then
 * sees it in the client's vault, marked as sent by the client.
 *
 * The guarantees underneath — the guard, the budget, who is told, the
 * frozen name — are `src/modules/vault/submission.dbtest.ts`'s.
 *
 * Handed back in `afterAll`, never a `finally` (`portal-requests.spec.ts`
 * says why): the vault tab, the inbox, the visual walk and the Swedish
 * width walk all sort after this file.
 */

const seed = requireSeed();

test.use({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });

test.describe.serial("a client hands a login over (C64)", () => {
  const name = `E2E handed over ${Date.now()}`;
  const secret = `e2e-handed-over-${Date.now()}`;

  test.afterAll(async () => {
    await clearPortalSubmissions(seed.tenantId, seed.contactEmail);
  });

  test("the home offers it; a refusal keeps what was typed; the send lands for the team only", async ({ page }) => {
    await page.goto("/portal");
    // Drawn only when the page would take a login — so its presence also
    // says the switch is on (the default) and the contact holds the verb.
    const cta = page.getByRole("link", { name: "Send us a login" });
    await expect(cta).toBeVisible({ timeout: 30_000 });
    await cta.click();
    await expect(page).toHaveURL(/\/portal\/send-login$/);
    await expect(page.getByRole("heading", { name: "Send us a login" })).toBeVisible();

    const form = page.getByTestId("send-login-form");
    // For the seeded portal project, not the company in general — and an
    // API key, not the default type, so both selects can be seen to hold.
    await form.locator("#sl-project").selectOption(seed.projectId);
    await form.locator("#sl-type").selectOption("API_KEY");
    await form.locator("#sl-name").fill(name);
    await form.locator("#sl-username").fill("acme-admin");
    // No password yet: told plainly, and nothing typed is lost — the SELECT
    // included. A `<form action>` would have reset it to its first option
    // while state kept the pick, and the resend would have posted the
    // company (the code review's medium): measured here, in a browser.
    await form.getByRole("button", { name: "Send to your agency" }).click();
    await expect(form).toContainText("Enter the password or key you want to send.");
    await expect(form.locator("#sl-project")).toHaveValue(seed.projectId);
    await expect(form.locator("#sl-type")).toHaveValue("API_KEY");
    await expect(form.locator("#sl-name")).toHaveValue(name);
    await expect(form.locator("#sl-username")).toHaveValue("acme-admin");

    await form.locator("#sl-url").fill("panel.example.test");
    await form.locator("#sl-secret-apiKey").fill(secret);
    await form.getByRole("button", { name: "Send to your agency" }).click();

    await expect(page).toHaveURL(/\/portal\/send-login\?sent=1$/, { timeout: 30_000 });
    await expect(page.getByRole("status").filter({ hasText: "Sent." })).toBeVisible();
    // Their own list: the name as they sent it — and the form is empty again.
    await expect(page.locator('[data-slot="sent-login"]').filter({ hasText: name })).toBeVisible();
    await expect(page.locator("#sl-name")).toHaveValue("");
    // The secret is not on the page in any form.
    expect(await page.content()).not.toContain(secret);

    // ── What the portal never shows, read from the database ──────────
    const rows = await readPortalSubmissions(seed.tenantId, seed.contactEmail);
    const mine = rows.find((r) => r.submittedName === name);
    expect(mine, "the login is in the database").toBeDefined();
    expect(mine!.name).toBe(name);
    expect(mine!.type).toBe("API_KEY");
    expect(mine!.visibility).toBe("INTERNAL");
    expect(mine!.clientId).toBe(seed.clientId);
    // …on the project picked before the refusal.
    expect(mine!.projectId).toBe(seed.projectId);
    // A scheme-less address is read as https.
    expect(mine!.url).toBe("https://panel.example.test");
    // Nobody at the agency did this — and the audit row says the CONTACT did,
    // though a system transaction wrote it.
    expect(mine!.createdByMemberId).toBeNull();
    expect(mine!.auditActorType).toBe("CONTACT");
    expect(mine!.auditActorId).toBe(mine!.submittedByContactId);
  });

  test("the team sees it in the client's vault, marked as sent by the client", async ({ browser }) => {
    const { context, page } = await signInVaultOwner(browser, seed);
    try {
      await page.goto(`/clients/${seed.clientId}/vault`);
      await expect(page.getByTestId("vault-list")).toBeVisible({ timeout: 30_000 });
      const row = page.getByTestId("vault-item").filter({ hasText: name });
      await expect(row.getByTestId("sent-by-client")).toContainText("Sent by");
    } finally {
      await context.close();
    }
  });

  test("sent before the page's script runs, nothing typed reaches a URL", async ({ browser }) => {
    // The form keeps its server action (the fix-pass review's medium): with
    // no script, the browser posts it — never a GET carrying the secret in
    // the query string, into history and an access log.
    const noScript = await browser.newContext({
      storageState: CONTACT_STORAGE_STATE,
      locale: "en-US",
      javaScriptEnabled: false,
    });
    try {
      const page = await noScript.newPage();
      const asked: string[] = [];
      page.on("request", (r) => asked.push(r.url()));
      await page.goto("/portal/send-login");
      const form = page.getByTestId("send-login-form");
      await expect(form).toBeVisible({ timeout: 30_000 });
      const quiet = `no-script-${Date.now()}`;
      await form.locator("#sl-name").fill(`${name} (no script)`);
      await form.locator("#sl-secret-password").fill(quiet);
      await form.getByRole("button", { name: "Send to your agency" }).click();
      await page.waitForLoadState("load");
      // It SENT — a client with no script can hand a login over too — so the
      // check below is not passing on a click that did nothing.
      await expect(page).toHaveURL(/\/portal\/send-login\?sent=1$/, { timeout: 30_000 });
      for (const url of [...asked, page.url()]) {
        expect(url).not.toContain("secret.");
        expect(url).not.toContain(quiet);
      }
    } finally {
      await noScript.close();
    }
  });

  test("a member's session cannot reach the form", async ({ browser }) => {
    const member = await browser.newContext({ storageState: STORAGE_STATE, locale: "en-US" });
    try {
      const page = await member.newPage();
      await page.goto("/portal/send-login");
      await expect(page).toHaveURL(/\/portal\/login/);
      await expect(page.getByTestId("send-login-form")).toHaveCount(0);
    } finally {
      await member.close();
    }
  });
});
