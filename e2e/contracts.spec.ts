import { expect, test, type Locator, type Page } from "@playwright/test";

import { STORAGE_STATE, requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * CONTRACTS IN A BROWSER (Phase 4 slice 112; founder decision C84).
 *
 *   - Settings → Contract templates, as the owner: a new template written in
 *     the editor, a fill-in put in from the Insert fill-in menu, Create — it
 *     opens at its own address and is listed.
 *   - /contracts: a contract started from that template for the seeded client,
 *     with the seeded main contact as the signer — the fill-ins in the text
 *     are the client's name and the signer's; a fill-in typed into the text and
 *     saved comes back named under "Still to fill in"; the title changed and
 *     saved survives a reload; Preview PDF answers with a PDF (probed from
 *     inside the page, as a download is — `a93ea1b`); the draft deleted from
 *     its menu.
 *
 * Templates are kept by owners and admins (`contract:manage_templates`,
 * TEMPLATE_VERSION 16): CI seeds the catalogue before this harness, so the
 * owner holds it. Names carry the run's own suffix — templates are
 * workspace-wide and the harness runs specs in parallel.
 */

const seed: E2ESeed = requireSeed();

const toast = (page: Page, text: string | RegExp): Locator => page.locator("[data-sonner-toast]", { hasText: text });

test.describe.serial("contract templates and drafts, as the owner", () => {
  test.use({ storageState: STORAGE_STATE, locale: "en-US" });

  const suffix = Math.random().toString(36).slice(2, 8);
  const templateName = `Web build ${suffix}`;

  test("a template with a fill-in from the menu is created and listed", async ({ page }) => {
    await page.goto("/settings/contracts");
    await expect(page.getByRole("heading", { name: "Contract templates", level: 1 })).toBeVisible();
    await page.getByTestId("new-contract-template").click();
    await expect(page).toHaveURL(/\/settings\/contracts\/new$/);
    await page.getByTestId("template-name").fill(templateName);
    const body = page.getByTestId("template-body");
    await body.click();
    await page.keyboard.type("This contract is between us and ");
    const insert = async (key: string) => {
      await page.getByTestId("insert-fill-in").click();
      await page.getByTestId(`fill-in-${key}`).click();
      // The menu has closed, the token is in, and the caret is back in the
      // text (TipTap focuses a frame later) before the next keystroke.
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(body).toContainText(`{{${key}}}`);
      await expect(body).toBeFocused();
    };
    await insert("client_name");
    await page.keyboard.type(", signed by ");
    await insert("signer_name");
    await page.keyboard.type(".");
    await expect(body).toContainText("This contract is between us and {{client_name}}, signed by {{signer_name}}.");
    await page.getByTestId("template-save").click();
    await expect(toast(page, "Template created.")).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/contracts\/[0-9a-f-]{36}$/);
    await page.goto("/settings/contracts");
    await expect(page.getByTestId("contract-template-row").filter({ hasText: templateName })).toBeVisible();
  });

  test("a contract started from it is filled in, edited, previewed and deleted", async ({ page }) => {
    await page.goto("/contracts");
    await expect(page.getByRole("heading", { name: "Contracts", level: 1 })).toBeVisible();
    const form = page.getByTestId("new-contract");
    // `exact`: "Who signs for the client" also contains "client".
    await form.getByLabel("Client", { exact: true }).selectOption(seed.clientId);
    // The signer list is read once a client is picked: the seeded main contact.
    const signer = form.getByLabel("Who signs for the client");
    await expect(signer.locator("option", { hasText: seed.contactName })).toHaveCount(1);
    await signer.selectOption({ label: seed.contactName });
    await form.getByLabel("Template").selectOption({ label: templateName });
    await page.getByTestId("new-contract-create").click();
    await expect(page).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);

    await expect(page.getByTestId("contract-status")).toHaveText("Draft");
    await expect(page.getByTestId("contract-title")).toHaveValue(templateName);
    const body = page.getByTestId("contract-body");
    await expect(body).toContainText(`This contract is between us and ${seed.clientName}, signed by ${seed.contactName}.`);
    await expect(page.getByTestId("contract-remaining")).toHaveCount(0);

    // A fill-in typed into the text is still to fill in once saved.
    await body.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" Dated {{today}}.");
    await page.getByTestId("contract-title").fill(`${templateName} — draft`);
    await expect(page.getByTestId("contract-unsaved")).toBeVisible();
    await page.getByTestId("contract-save").click();
    await expect(toast(page, "Saved.")).toBeVisible();
    await expect(page.getByTestId("contract-remaining")).toContainText("Today's date");
    await page.reload();
    await expect(page.getByTestId("contract-title")).toHaveValue(`${templateName} — draft`);
    await expect(page.getByTestId("contract-remaining")).toContainText("Today's date");

    // Preview PDF — probed from inside the page, as the browser would fetch it.
    const href = await page.getByTestId("contract-preview").getAttribute("href");
    expect(href).toMatch(/^\/contracts\/[0-9a-f-]{36}\/preview$/);
    const probe = await page.evaluate(async (url) => {
      const r = await fetch(url);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, type: r.headers.get("content-type"), head: String.fromCharCode(...bytes.slice(0, 5)) };
    }, href!);
    expect(probe).toEqual({ status: 200, type: "application/pdf", head: "%PDF-" });

    // Deleted from its menu, after the question.
    await page.getByRole("button", { name: "Contract actions" }).click();
    await page.getByRole("menuitem", { name: "Delete draft" }).click();
    await page.getByRole("button", { name: "Yes" }).click();
    // The toast is raised before the navigation to the list, which can take
    // longer than a toast lives on a cold server: look for it first.
    await expect(toast(page, "Draft deleted.")).toBeVisible();
    await page.waitForURL(/\/contracts$/, { timeout: 15_000 });
  });
});
