import { expect, test } from "@playwright/test";

import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * `/search` in a browser (UI.md §3.1; DATA_MODEL.md §6.19).
 *
 * The fixture's project holds tasks with Swedish titles, and the index
 * is fed by the same triggers production uses — nothing here seeds
 * `search_index` directly, so a green run is evidence that the FEED
 * works end to end and not only that the reader does.
 */

let seed!: E2ESeed;
const SLOW = process.env["CI"] ? 3 : 1;

test.beforeAll(() => {
  seed = requireSeed();
});

test.describe("search (owner)", () => {
  test("a query finds the seeded task and its row opens the item peek", async ({ page }) => {
    await page.goto("/search");
    // Nothing typed is its own state — not "no results".
    await expect(page.locator('[data-slot="empty-state"]')).toContainText("Type to search");

    await page.getByRole("searchbox", { name: "Search the workspace" }).fill("Designgranskning");
    // The box debounces before it navigates, so the URL is the signal.
    await expect(page).toHaveURL(/\/search\?q=Designgranskning/, { timeout: 20_000 * SLOW });

    const hit = page.getByTestId("search-hit").filter({ hasText: "Designgranskning" });
    await expect(hit.first()).toBeVisible({ timeout: 20_000 * SLOW });
    await expect(hit.first()).toHaveAttribute("data-entity-type", "WORK_ITEM");

    // The address is built from the LIVE project, so it opens the peek.
    await hit.first().getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/projects/${seed.projectKey}/backlog\\?item=${seed.projectKey}-`));
    await expect(page.getByTestId("item-peek")).toBeVisible({ timeout: 20_000 * SLOW });
  });

  test("a stop word says the query was too vague; a real miss says nothing matched", async ({
    page,
  }) => {
    // These are different answers and the page must not conflate them:
    // one says the query said nothing, the other says the workspace
    // holds nothing.
    await page.goto("/search?q=och");
    await expect(page.locator('[data-slot="empty-state"]')).toContainText(
      "needs a word to go on",
    );

    await page.goto("/search?q=zzzqqqnothingmatchesthis");
    await expect(page.locator('[data-slot="empty-state"]')).toContainText("Nothing matched");
  });

  test("G S reaches it", async ({ page }) => {
    // The go-to comes from the nav registry, so it is covered by the
    // same mechanism the palette and the ? overlay derive their rows
    // from.
    await page.goto("/home");
    await page.keyboard.press("g");
    await page.keyboard.press("s");
    await expect(page).toHaveURL(/\/search$/, { timeout: 20_000 * SLOW });
  });
});

test.describe("search (employee)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill(seed.employeeEmail);
    await page.locator("#password").fill(seed.employeePassword);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("**/home", { timeout: 30_000 });
  });

  test("sees the project they are on and nothing from a client they are not", async ({ page }) => {
    // The employee holds one client assignment. The scope filter in the
    // query is the only thing enforcing this — RLS on search_index
    // carries no member term at all.
    await page.goto(`/search?q=Designgranskning`);
    await expect(page.getByTestId("search-hit").first()).toBeVisible({ timeout: 20_000 * SLOW });

    // The fixture's OTHER client is out of scope. One distinctive word
    // rather than the whole name: the name carries an `&` and a run
    // suffix, and what is being tested is the scope filter, not the
    // parser. "Langnamn" unaccented also exercises the unaccent
    // dictionary on the way through.
    await page.goto("/search?q=Langnamn");
    await expect(page.locator('[data-slot="empty-state"]')).toContainText("Nothing matched");
    // The positive control for this lives in the describe below, under
    // the OWNER's session: without it, "no results for the employee"
    // reads identically whether the scope filter works or the term
    // simply matches nobody.
  });
});

test.describe("search scope, from the other side", () => {
  test("the owner DOES find the client the employee cannot — the control for the test above", async ({
    page,
  }) => {
    // Same term, same index, different member. "Langnamn" also confirms
    // the unaccent dictionary: the stored name is "Långnamn".
    await page.goto("/search?q=Langnamn");
    const hit = page.getByTestId("search-hit").filter({ hasText: "Långnamn" });
    await expect(hit.first()).toBeVisible({ timeout: 20_000 * SLOW });
    await expect(hit.first()).toHaveAttribute("data-entity-type", "CLIENT");
  });
});
