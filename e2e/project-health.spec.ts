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
    // The select keeps the parameters already there and adds its own after them.
    await page.waitForURL(`**/reports?finished=1&client=${seed.longClientId}`);
    await expect.poll(() => rowKeys(page)).toEqual([seed.completedProjectKey]);

    await page.getByTestId("portfolio-finished").click();
    await page.waitForURL(`**/reports?client=${seed.longClientId}`);
    // That client has no RUNNING project, so the filter names a client the
    // list does not span — read as every client (`/invoices`' rule), never
    // as an empty table that looks like a workspace with no projects.
    await expect.poll(() => rowKeys(page)).toContain(seed.projectKey);
  });

  // Slice 117 (C93): the team charts under the table. What each view COUNTS
  // is `portfolio.dbtest.ts`'s; this pins the page — every view drawn for an
  // owner, and the period select and "Show finished" keeping each other.
  test("the team charts sit under the table, and the period and Show finished keep each other", async ({ page }) => {
    await page.goto("/reports");
    const charts = page.getByTestId("team-charts");
    await expect(charts).toBeVisible();
    await expect(charts.getByTestId("chart-numbers")).toBeVisible();
    for (const title of ["Open tasks by project", "How long tasks take", "Hours by project", "Budget used"]) {
      await expect(charts.getByRole("heading", { name: title, exact: true })).toBeVisible();
    }
    // Never hours per person (C93 (e)): an hour ranking is on the never-list.
    await expect(charts.getByRole("heading", { name: "Hours by person" })).toHaveCount(0);
    // Six months of columns — or, when no task in them went from In progress
    // to Done (the seed has none), the line that says so instead of an empty plot.
    const columns = await charts.getByTestId("column").count();
    if (columns === 0) {
      await expect(charts.getByText("No task went from In progress to Done in these six months.")).toBeVisible();
    } else {
      expect(columns).toBe(6);
    }

    await page.goto("/reports?finished=1");
    await page.locator("#chart-period").selectOption("last");
    await page.waitForURL("**/reports?finished=1&period=last");
    await expect(page.locator("#chart-period")).toHaveValue("last");
    await expect(charts.getByText("Done last month")).toBeVisible();

    await page.getByTestId("portfolio-finished").click();
    await page.waitForURL("**/reports?period=last");
    await expect(page.locator("#chart-period")).toHaveValue("last");

    // Back to this month: the default is written as no parameter at all.
    await page.locator("#chart-period").selectOption("this");
    await page.waitForURL(/\/reports$/);
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
