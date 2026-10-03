import { expect, test, type Page } from "@playwright/test";

import { isActionPost } from "./fixtures/actions";
import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * A CLIENT'S ASSETS TAB IN A BROWSER (Phase 3V slice 87): the registry the
 * fixture seeded (a domain due in 20 days, the project's hosting that
 * renews by itself, a licence that lapsed three days ago), the "coming up"
 * strip that names what needs renewing, and the whole life of one asset —
 * added inline, edited read-first, retired, brought back, deleted.
 *
 * As the OWNER, with no authenticator: assets are not behind the vault's
 * door, which is part of what this proves. The services' guarantees — the
 * gates, the scope, the trail, the database's refusals — are
 * `assets.dbtest.ts`'s; this proves the screen reaches them. Everything
 * happens inside the throwaway e2e tenant and is removed by teardown.
 */

let seed!: E2ESeed;

test.beforeAll(() => {
  seed = requireSeed();
});

const tab = () => `/clients/${seed.clientId}/assets`;
const rowOf = (page: Page, name: string) => page.locator(`[data-testid="asset-item"][data-name="${name}"]`);

test.describe("a client's Assets tab (owner)", () => {
  test("lists the registry with its renewal cues, and the strip names what is coming up, soonest first", async ({ page }) => {
    await page.goto(`/clients/${seed.clientId}`);
    const tabs = page.locator('nav[data-slot="tab-strip"]');
    await tabs.getByRole("link", { name: "Assets", exact: true }).click();
    await page.waitForURL(/\/clients\/[^/]+\/assets$/);
    await expect(tabs.getByRole("link", { name: "Assets", exact: true })).toHaveAttribute("aria-current", "page");

    // Open at once — no door, no step-up.
    await expect(page.getByTestId("asset-list")).toBeVisible();
    const strip = page.getByTestId("assets-coming");
    await expect(strip.getByRole("listitem")).toHaveCount(2);
    // The lapsed licence first, then the domain; the hosting (200 days) is not in it.
    await expect(strip.getByRole("listitem").nth(0)).toContainText("E2E Elementor Pro");
    await expect(strip.getByRole("listitem").nth(0)).toContainText("expired");
    await expect(strip.getByRole("listitem").nth(1)).toContainText("e2e-acme.se");
    await expect(strip).not.toContainText("E2E website hosting");

    await expect(rowOf(page, "e2e-acme.se").getByTestId("asset-cue")).toHaveText(/^Expires in (19|20|21) days$/);
    await expect(rowOf(page, "E2E Elementor Pro").getByTestId("asset-cue")).toHaveText("Expired");
    await expect(rowOf(page, "E2E website hosting").getByTestId("asset-cue")).toHaveCount(0);
    // A project's asset wears the project's key; the facts of its type are listed.
    const hosting = rowOf(page, "E2E website hosting");
    await expect(hosting.getByText(seed.projectKey, { exact: true })).toBeVisible();
    await expect(hosting.getByRole("button", { name: /^Edit Plan, currently CX22$/ })).toBeVisible();
    await expect(rowOf(page, "e2e-acme.se").getByRole("button", { name: /^Edit Nameservers, currently ns1\.loopia\.se, ns2\.loopia\.se$/ })).toBeVisible();
  });

  test("add a domain inline, edit it read-first, retire it, bring it back and delete it", async ({ page }) => {
    await page.goto(tab());
    const name = `e2e-new-${Date.now()}.se`;
    const form = page.getByTestId("add-asset");
    await form.locator("#as-type").selectOption("DOMAIN");
    await form.locator("#as-name").fill(name);
    await form.locator("#as-provider").fill("Loopia");
    const due = new Date(Date.now() + 100 * 86_400_000).toISOString().slice(0, 10);
    await form.locator("#as-expires").fill(due);
    await form.locator("#as-cost").fill("99");
    await form.locator("#as-field-nameservers").fill("ns1.example.se, ns2.example.se");
    await form.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(`Added ${name}`)).toBeVisible();
    const row = rowOf(page, name);
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: /^Edit Renewal cost, currently / })).toContainText("99");
    // 100 days out: no cue, and nothing new in the strip.
    await expect(row.getByTestId("asset-cue")).toHaveCount(0);

    // Read-first: the provider is a button until pressed; Enter saves.
    await row.getByRole("button", { name: "Edit Provider, currently Loopia" }).click();
    const answered = page.waitForResponse((res) => isActionPost(res.request()));
    await page.keyboard.type("One.com");
    await page.keyboard.press("Enter");
    await answered;
    await page.reload();
    await expect(rowOf(page, name).getByRole("button", { name: "Edit Provider, currently One.com" })).toBeVisible();

    // A REFUSED value is said out loud and the row goes back to what is
    // saved — so the refused text can never ride along on the row's next
    // save (the reviews' M1: the row posts every field on every save).
    await rowOf(page, name).getByRole("button", { name: /^Edit Renewal cost, currently / }).click();
    const refused = page.waitForResponse((res) => isActionPost(res.request()));
    await page.keyboard.type("abc");
    await page.keyboard.press("Enter");
    await refused;
    await expect(page.getByText("Invalid input.").first()).toBeVisible();
    await expect(rowOf(page, name).getByRole("button", { name: "Edit Renewal cost, currently 99.00" })).toBeVisible();
    // The NEXT edit of the row — another field — saves: the row is not poisoned.
    await rowOf(page, name).getByRole("button", { name: "Edit Provider, currently One.com" }).click();
    const next = page.waitForResponse((res) => isActionPost(res.request()));
    await page.keyboard.type("Hetzner");
    await page.keyboard.press("Enter");
    await next;
    await page.reload();
    await expect(rowOf(page, name).getByRole("button", { name: "Edit Provider, currently Hetzner" })).toBeVisible();
    await expect(rowOf(page, name).getByRole("button", { name: "Edit Renewal cost, currently 99.00" })).toBeVisible();

    // Retire acts on one click (it is not dangerous); the record stays.
    await rowOf(page, name).getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Retire" }).click();
    await expect(page.getByText("Retired", { exact: true }).first()).toBeVisible();
    await expect(rowOf(page, name).getByText("Retired", { exact: true })).toBeVisible();
    await rowOf(page, name).getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Put back in use" }).click();
    await expect(rowOf(page, name).getByText("Retired", { exact: true })).toHaveCount(0);

    // Delete asks first.
    await rowOf(page, name).getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await rowOf(page, name).getByRole("button", { name: "Yes" }).click();
    await expect(rowOf(page, name)).toHaveCount(0);
  });

  test("a refused add says so and keeps everything typed; corrected, it adds", async ({ page }) => {
    await page.goto(tab());
    const name = `e2e-refused-${Date.now()}.se`;
    const form = page.getByTestId("add-asset");
    await form.locator("#as-type").selectOption("LICENSE");
    await form.locator("#as-name").fill(name);
    await form.locator("#as-provider").fill("Elementor");
    await form.locator("#as-field-seats").fill("5");
    await form.locator("#as-url").fill("https://admin:hunter2@example.se");
    await form.getByRole("button", { name: "Add" }).click();
    await expect(form.getByRole("alert")).toBeVisible();
    await expect(rowOf(page, name)).toHaveCount(0);
    // Nothing emptied under the member (the code review's M2): not the
    // type, not its own field, not the rest.
    await expect(form.locator("#as-type")).toHaveValue("LICENSE");
    await expect(form.locator("#as-name")).toHaveValue(name);
    await expect(form.locator("#as-provider")).toHaveValue("Elementor");
    await expect(form.locator("#as-field-seats")).toHaveValue("5");

    await form.locator("#as-url").fill("https://example.se");
    await form.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(`Added ${name}`)).toBeVisible();
    await expect(rowOf(page, name).getByRole("button", { name: "Edit Seats, currently 5" })).toBeVisible();
    // …and the form starts over, its type back on the first.
    await expect(form.locator("#as-name")).toHaveValue("");
    await expect(form.locator("#as-type")).toHaveValue("DOMAIN");

    await rowOf(page, name).getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await rowOf(page, name).getByRole("button", { name: "Yes" }).click();
    await expect(rowOf(page, name)).toHaveCount(0);
  });
});
