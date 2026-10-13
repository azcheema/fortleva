import { expect, test } from "@playwright/test";

import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * /reports — THE PROJECT HEALTH TABLE in a browser (Phase 6 slice 116;
 * founder decision C92). The owner reaches it from the rail; the seeded
 * project, whose newest post is At risk (or Off track, if `updates.spec.ts`
 * stopped before archiving its second post), sits above the seed's active
 * project that has none — most worrying first (C92 (c)); "Show finished"
 * appends the completed project and the client filter narrows to one
 * client; the employee has no rail entry and the page is the forbidden
 * state. The ordering rule itself is `portfolio.dbtest.ts`'s and
 * `portfolio-order.test.ts`'s. Everything happens inside the throwaway e2e
 * tenant (fixtures/tenant.ts) and is removed by teardown.
 */

let seed!: E2ESeed;

test.beforeAll(() => {
  seed = requireSeed();
});

const rowKeys = async (page: import("@playwright/test").Page): Promise<string[]> =>
  page.getByTestId("portfolio-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-project") ?? ""));

test.describe("project health (owner)", () => {
  test("the rail leads to the table: the worrying project first, finished ones on request, one client at a time", async ({ page }) => {
    await page.goto("/home");
    await page.getByRole("navigation").getByRole("link", { name: "Reports", exact: true }).first().click();
    await page.waitForURL("**/reports");
    await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();

    const table = page.getByTestId("portfolio-table");
    await expect(table).toBeVisible();
    const seeded = table.locator(`[data-project="${seed.projectKey}"]`);
    await expect(seeded.locator('[data-slot="health-chip"]')).toHaveAttribute("data-value", /^(AT_RISK|OFF_TRACK)$/);
    const keys = await rowKeys(page);
    expect(keys).toContain(seed.activeProjectKey);
    // Both projects are the seeded client's and the seeded one also sorts
    // first by NAME, so this holds with or without the ranking: it pins the
    // page, not the rule. The rule is `portfolio.dbtest.ts`'s (a late project
    // named to sort last, lifted by its rank) and `portfolio-order.test.ts`'s.
    expect(keys.indexOf(seed.projectKey)).toBeLessThan(keys.indexOf(seed.activeProjectKey));
    // Running projects only, until asked.
    expect(keys).not.toContain(seed.completedProjectKey);

    await page.getByTestId("portfolio-finished").click();
    await page.waitForURL("**/reports?finished=1");
    await expect(table.locator(`[data-project="${seed.completedProjectKey}"]`)).toBeVisible();
    const withFinished = await rowKeys(page);
    // Appended after every running project.
    expect(withFinished.at(-1)).toBe(seed.completedProjectKey);

    // Two clients now: the filter narrows to the completed project's.
    await page.locator("#portfolio-filter").selectOption(seed.longClientId);
    await page.waitForURL(`**/reports?client=${seed.longClientId}&finished=1`);
    await expect.poll(() => rowKeys(page)).toEqual([seed.completedProjectKey]);

    await page.getByTestId("portfolio-finished").click();
    await page.waitForURL(`**/reports?client=${seed.longClientId}`);
    // That client has no RUNNING project, so the filter names a client the
    // list does not span — read as every client (`/invoices`' rule), never
    // as an empty table that looks like a workspace with no projects.
    await expect.poll(() => rowKeys(page)).toContain(seed.projectKey);
  });
});

test.describe("project health (employee)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill(seed.employeeEmail);
    await page.locator("#password").fill(seed.employeePassword);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("**/home", { timeout: 30_000 });
  });

  test("has no Reports entry and the page is the forbidden state", async ({ page }) => {
    await expect(page.getByRole("navigation").getByRole("link", { name: "Projects", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("navigation").getByRole("link", { name: "Reports", exact: true })).toHaveCount(0);
    await page.goto("/reports");
    await expect(page.getByText("You don't have access to reports.")).toBeVisible();
    await expect(page.getByTestId("portfolio-table")).toHaveCount(0);
  });
});
