import { expect, test, type Page } from "@playwright/test";

import { requireSeed, STORAGE_STATE, type E2ESeed } from "./fixtures/tenant";

/**
 * CP1's safety-critical half — the member-plane scoping boundary,
 * pinned in a browser.
 *
 * The DB suite already proves `scopeWhere`/`assertInScope` row-by-row
 * (clients.dbtest, scope.dbtest); what it structurally cannot see is
 * the surface a person meets: that an employee's LIST quietly holds
 * only their clients, and that a pasted URL to anything else renders
 * the in-shell 404 — the same screen a genuinely missing id gets, so
 * out-of-scope and does-not-exist are indistinguishable (UI.md §7.3,
 * "404, never 403").
 *
 * The fixture employee holds the Employee template role (no
 * client:view_all) and exactly one assignment — the main client. The
 * long-name client and its completed project are the forbidden
 * targets: real rows, in the same throwaway tenant, that this member
 * must not be able to tell apart from nothing.
 */

let seed!: E2ESeed;

test.beforeAll(() => {
  seed = requireSeed();
});

/**
 * The in-shell 404, asserted on what a person (or a scraper) can
 * observe. The HTTP status is deliberately NOT pinned: the app streams,
 * so the shell's 200 header is already sent when `notFound()` throws in
 * the page — the boundary is the rendered screen, not the status line.
 * `leak` is the string that must appear nowhere in the document: the
 * denial must not carry the very data it denies.
 */
async function expectNotFound(page: Page, path: string, leak?: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(
    page.getByText("There is nothing at this address, or you do not have access to it."),
  ).toBeVisible();
  if (leak) await expect(page.getByText(leak)).toHaveCount(0);
}

test.describe("as the employee", () => {
  // This block authenticates as the EMPLOYEE: start from no session at
  // all instead of the owner storage state every other spec shares.
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill(seed.employeeEmail);
    await page.locator("#password").fill(seed.employeePassword);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("**/home", { timeout: 30_000 });
  });

  test("sees the assigned client only, and everything else is a 404", async ({ page }) => {
    // Control first: the assigned client is fully reachable, so the
    // denials below are scoping, not a broken build.
    await page.goto(`/clients/${seed.clientId}`);
    await expect(page.getByRole("heading", { name: seed.clientName })).toBeVisible();

    // The client LIST is filtered in SQL: the other clients' names
    // never reach the browser at all.
    await page.goto("/clients");
    await expect(page.getByText(seed.clientName).first()).toBeVisible();
    await expect(page.getByText(seed.longClientName)).toHaveCount(0);

    // The project list: the client assignment lifts every project of
    // the assigned client, and nothing else.
    await page.goto("/projects");
    await expect(page.getByText(seed.projectKey, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(seed.completedProjectKey, { exact: true })).toHaveCount(0);

    // The boundary itself: a pasted URL to an unassigned client, its
    // project, and its files — each the identical in-shell 404, and
    // none of them carrying the forbidden client's name anywhere.
    await expectNotFound(page, `/clients/${seed.longClientId}`, seed.longClientName);
    await expectNotFound(page, `/projects/${seed.completedProjectKey}`, seed.longClientName);
    await expectNotFound(page, `/clients/${seed.longClientId}/files`, seed.longClientName);

    // Indistinguishability: an id that exists in no tenant renders the
    // exact same screen as the one that exists out of scope.
    await expectNotFound(page, "/clients/00000000-0000-7000-8000-000000000000");
  });
});

test.describe("as the owner", () => {
  test.use({ storageState: STORAGE_STATE });

  test("reaches the client the employee cannot", async ({ page }) => {
    // Same build, same rows, opposite outcome — proving the 404s above
    // come from the actor, not the route.
    const response = await page.goto(`/clients/${seed.longClientId}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: seed.longClientName })).toBeVisible();
  });
});
