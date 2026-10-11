import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { CONTACT_STORAGE_STATE, STORAGE_STATE, clearContractNotices, plantUploadedContract, requireSeed, type E2ESeed } from "./fixtures/tenant";

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

/** The harness has no bucket unless CI gives it one: a PDF is then "not made yet". */
const HAS_R2 = Boolean(process.env["R2_BUCKET"]);

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

  // Slice 112b (C84 (b)–(d), C85): a blank draft written, its signer picked and
  // saved, then signed for and sent — the sender's typed name is the
  // agency's signature; withdrawn; and a new version opened from it.
  test("a contract is signed for and sent, withdrawn, and opened again as version 2", async ({ page }) => {
    await page.goto("/contracts");
    const form = page.getByTestId("new-contract");
    await form.getByLabel("Client", { exact: true }).selectOption(seed.clientId);
    const signer = form.getByLabel("Who signs for the client");
    await expect(signer.locator("option", { hasText: seed.contactName })).toHaveCount(1);
    await signer.selectOption({ label: seed.contactName });
    await form.getByLabel("Template").selectOption({ label: "Blank contract" });
    await form.getByLabel("Title").fill(`Retainer ${suffix}`);
    await page.getByTestId("new-contract-create").click();
    await expect(page).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);

    // Not ready until it has text and is saved: the page says what is missing.
    await expect(page.getByTestId("contract-not-ready")).toBeVisible();
    const body = page.getByTestId("contract-body");
    await body.click();
    await page.keyboard.type("Monthly support, 10 hours.");
    await page.getByTestId("contract-save").click();
    await expect(toast(page, "Saved.")).toBeVisible();
    await expect(page.getByTestId("contract-unsaved")).toHaveCount(0);

    await page.getByTestId("contract-send-open").click();
    const dialog = page.getByTestId("contract-send-dialog");
    await expect(dialog).toContainText(seed.contactName);
    await dialog.getByTestId("contract-send-name").fill("Erik Owner");
    await dialog.getByTestId("contract-send-confirm").click();
    // No bucket in the harness: the send stands, its PDF follows later.
    await expect(toast(page, HAS_R2 ? "Signed and sent." : "Signed and sent. Its PDF couldn't be made yet — it will be shortly.")).toBeVisible();

    await expect(page.getByTestId("contract-status")).toHaveText("Waiting for signature");
    // The send dialog's trigger is gone with the draft editor: the sent view's
    // heading has focus, never <body> (slice 112b's hand-off, asserted in 112b2).
    await expect(page.locator("#contract-signatures")).toBeFocused();
    await expect(page.getByTestId("signature-agency")).toContainText("Erik Owner");
    await expect(page.getByTestId("signature-client")).toHaveAttribute("data-status", "PENDING");
    await expect(page.getByTestId("contract-fingerprint")).toContainText(/[0-9a-f]{64}/);

    // Withdrawn, after the question.
    await page.getByRole("button", { name: "Contract actions" }).click();
    await page.getByRole("menuitem", { name: "Withdraw" }).click();
    await page.getByRole("button", { name: "Yes" }).click();
    await expect(toast(page, "Withdrawn.")).toBeVisible();
    await expect(page.getByTestId("contract-status")).toHaveText("Withdrawn");

    // A new version: a draft, version 2, that names the one it replaces.
    await page.getByRole("button", { name: "Contract actions" }).click();
    await page.getByRole("menuitem", { name: "New version" }).click();
    await expect(page.getByTestId("contract-status")).toHaveText("Draft");
    await expect(page.getByTestId("contract-versions")).toContainText("Replaces version 1");
    await expect(page.getByTestId("contract-title")).toHaveValue(`Retainer ${suffix}`);
  });
});

/** Astrid's own portal, in a context of her own (`invoice-send.spec.ts`'s helper). */
async function asAstrid(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

/**
 * Slice 112b2 (C84, C85): the client's side. A blank contract written and sent
 * to Astrid by the owner, who types their name — then, in Astrid's own portal,
 * the home's card counts it, she reads it, ticks "I have read and accept",
 * types her name and signs; the owner's page says Signed, and their inbox says
 * a client signed. A second one she declines with a reason, which the owner's
 * page reads back. The harness has no file storage unless CI gives it one, so
 * the signed copy is "being prepared" there.
 */
test.describe.serial("a contract signed or declined in the client's portal", () => {
  test.use({ storageState: STORAGE_STATE, locale: "en-US" });

  const suffix = Math.random().toString(36).slice(2, 8);

  // The owner's inbox gets the sender's notices; `inbox.spec.ts` counts its
  // one standing row, so they go (the login asks' precedent).
  test.afterAll(async () => {
    await clearContractNotices(seed.tenantId);
  });

  /** A blank contract for the seeded client, signed for and sent by the owner — its id. */
  async function sendOne(page: Page, title: string): Promise<string> {
    await page.goto("/contracts");
    const form = page.getByTestId("new-contract");
    await form.getByLabel("Client", { exact: true }).selectOption(seed.clientId);
    const signer = form.getByLabel("Who signs for the client");
    await expect(signer.locator("option", { hasText: seed.contactName })).toHaveCount(1);
    await signer.selectOption({ label: seed.contactName });
    await form.getByLabel("Template").selectOption({ label: "Blank contract" });
    await form.getByLabel("Title").fill(title);
    await page.getByTestId("new-contract-create").click();
    await expect(page).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);
    await page.getByTestId("contract-body").click();
    await page.keyboard.type("Design and build of the new website.");
    await page.getByTestId("contract-save").click();
    await expect(toast(page, "Saved.")).toBeVisible();
    await expect(page.getByTestId("contract-unsaved")).toHaveCount(0);
    await page.getByTestId("contract-send-open").click();
    const dialog = page.getByTestId("contract-send-dialog");
    await dialog.getByTestId("contract-send-name").fill("Erik Owner");
    await dialog.getByTestId("contract-send-confirm").click();
    await expect(page.getByTestId("contract-status")).toHaveText("Waiting for signature");
    return new URL(page.url()).pathname.split("/").pop()!;
  }

  test("Astrid signs in her portal; the owner's page says Signed and their inbox says so", async ({ page, browser }) => {
    const title = `Website ${suffix}`;
    const id = await sendOne(page, title);

    const astrid = await asAstrid(browser);
    try {
      const client = astrid.page;
      await client.goto("/portal");
      const surface = client.locator("[data-portal-surface]");
      await expect(surface).toBeVisible({ timeout: 30_000 });
      // The home counts what waits for her signature, and the nav offers Contracts.
      await expect(client.locator('[data-slot="portal-action-item"][data-kind="contract"]')).toContainText("waiting for your signature");
      await surface.locator('[data-slot="portal-nav"]').getByRole("link", { name: "Contracts" }).click();
      await expect(client).toHaveURL(/\/portal\/contracts$/);
      const row = client.getByTestId("portal-contract-row").filter({ hasText: title });
      await expect(row.getByTestId("portal-contract-state")).toHaveText("Waiting for your signature");
      await row.getByRole("link", { name: title }).click();
      await expect(client).toHaveURL(new RegExp(`/portal/contracts/${id}$`));

      await expect(client.getByTestId("portal-contract-body")).toContainText("Design and build of the new website.");
      await expect(client.getByTestId("portal-signature-agency")).toContainText("Erik Owner");
      await expect(client.getByTestId("portal-contract-fingerprint")).toContainText(/[0-9a-f]{64}/);
      // Nothing to press until the box is ticked and the name typed.
      const sign = client.getByTestId("portal-contract-sign-confirm");
      await expect(sign).toBeDisabled();
      await client.getByTestId("portal-contract-accept").check();
      await client.getByTestId("portal-contract-name").fill(seed.contactName);
      await sign.click();

      await expect(client.getByTestId("portal-contract-outcome")).toContainText("Signed by both sides");
      // The card that held focus is gone: the outcome line has it, never <body>
      // (a hand-off the React Compiler once broke — AGENTS.md's standing trap).
      await expect(client.getByTestId("portal-contract-outcome")).toBeFocused();
      await expect(client.getByTestId("portal-contract-state")).toHaveText("Signed");
      await expect(client.getByTestId("portal-signature-client")).toContainText(`Signed as “${seed.contactName}”`);
      await expect(client.getByTestId("portal-contract-sign")).toHaveCount(0);
      if (!HAS_R2) await expect(client.getByTestId("portal-contract-preparing")).toContainText("being prepared");
    } finally {
      await astrid.close();
    }

    await page.reload();
    await expect(page.getByTestId("contract-status")).toHaveText("Signed");
    await expect(page.getByTestId("signature-client")).toHaveAttribute("data-status", "SIGNED");
    await page.goto("/inbox");
    await expect(page.getByText("A client signed a contract").first()).toBeVisible({ timeout: 30_000 });
  });

  test("Astrid declines another with a reason; the owner's page reads it back", async ({ page, browser }) => {
    const id = await sendOne(page, `Retainer ${suffix}`);
    const astrid = await asAstrid(browser);
    try {
      const client = astrid.page;
      await client.goto(`/portal/contracts/${id}`);
      await expect(client.getByTestId("portal-contract-sign")).toBeVisible({ timeout: 30_000 });
      await client.getByTestId("portal-contract-decline-open").click();
      const dialog = client.getByTestId("portal-contract-decline-dialog");
      await dialog.getByTestId("portal-contract-reason").fill("Not this quarter, sorry.");
      await dialog.getByTestId("portal-contract-decline-confirm").click();
      await expect(dialog).toHaveCount(0);
      await expect(client.getByTestId("portal-contract-outcome")).toContainText("This contract was declined");
      await expect(client.getByTestId("portal-contract-outcome")).toBeFocused();
      await expect(client.getByTestId("portal-contract-decline-reason")).toHaveText("Not this quarter, sorry.");
    } finally {
      await astrid.close();
    }
    await page.reload();
    await expect(page.getByTestId("contract-status")).toHaveText("Declined");
    await expect(page.getByTestId("sent-contract")).toContainText("Not this quarter, sorry.");
  });
});

/**
 * Slice 112c (C84 (f), C86): a contract SIGNED ELSEWHERE. The harness has no
 * file storage, so the upload's byte path is the dbtest's
 * (`contract-uploads.dbtest.ts`); here one is planted in-process through the
 * real service, then: found on the client's Contracts tab, its end date
 * edited; NOT in Astrid's portal until shown (C86 (a)); shown, her portal
 * lists it and its page says it was signed outside Fortleva; hidden, gone
 * again; deleted (C86 (b)), gone from the list.
 */
test.describe.serial("a contract signed elsewhere, put in and shown to the client", () => {
  test.use({ storageState: STORAGE_STATE, locale: "en-US" });

  const title = `Paper contract ${Math.random().toString(36).slice(2, 8)}`;
  let id = "";

  test.beforeAll(async () => {
    id = await plantUploadedContract(seed.tenantId, seed.clientId, seed.memberId, title);
  });

  test("edited on the client's tab, shown to Astrid and hidden again, then deleted", async ({ page, browser }) => {
    await page.goto(`/clients/${seed.clientId}/contracts`);
    const row = page.getByTestId("contract-row").filter({ hasText: title });
    await expect(row).toHaveAttribute("data-origin", "UPLOADED");
    await row.getByRole("link", { name: title }).click();
    await expect(page).toHaveURL(new RegExp(`/contracts/${id}$`));
    await expect(page.getByTestId("contract-signed-elsewhere")).toBeVisible();
    await expect(page.getByTestId("uploaded-shown-state")).toContainText("Not shown");

    // Its end date, edited and saved.
    await page.getByTestId("uploaded-endsOn").fill("2028-05-31");
    await page.getByTestId("uploaded-save").click();
    await expect(toast(page, "Saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("uploaded-endsOn")).toHaveValue("2028-05-31");

    const astrid = await asAstrid(browser);
    try {
      // Not shown: her portal has nothing of it.
      expect((await astrid.page.goto(`/portal/contracts/${id}`))?.status()).toBe(404);

      // Shown — the server's answer drawn, never an optimistic flip.
      await page.getByTestId("uploaded-shown").click();
      await expect(toast(page, "Shown to the client.")).toBeVisible();
      await expect(page.getByTestId("uploaded-shown-state")).toContainText("Shown:");

      await astrid.page.goto("/portal/contracts");
      const listed = astrid.page.getByTestId("portal-contract-row").filter({ hasText: title });
      await expect(listed.getByTestId("portal-contract-state")).toHaveText("Signed");
      await listed.getByRole("link", { name: title }).click();
      await expect(astrid.page.getByTestId("portal-contract-outcome")).toContainText("Signed outside Fortleva");
      await expect(astrid.page.getByTestId("portal-contract-download-signed")).toBeVisible();
      await expect(astrid.page.getByTestId("portal-contract-body")).toHaveCount(0);
      await expect(astrid.page.getByTestId("portal-contract-signatures")).toHaveCount(0);

      // Hidden again: gone from her portal.
      await page.getByTestId("uploaded-shown").click();
      await expect(toast(page, "Hidden from the client.")).toBeVisible();
      expect((await astrid.page.goto(`/portal/contracts/${id}`))?.status()).toBe(404);
    } finally {
      await astrid.close();
    }

    // Deleted, after the question.
    await page.getByRole("button", { name: "Contract actions" }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await page.getByRole("button", { name: "Yes" }).click();
    await expect(page).toHaveURL(/\/contracts$/);
    await expect(page.getByTestId("contract-row").filter({ hasText: title })).toHaveCount(0);
  });
});
