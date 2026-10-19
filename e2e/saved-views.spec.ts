import { expect, test, type Locator, type Page } from "@playwright/test";

import { SLOW } from "./fixtures/keys";
import { clearSavedViews, requireSeed, tasksWorkspace, type E2ESeed, type TasksWorkspace } from "./fixtures/tenant";

/**
 * SAVED VIEWS, through a real member session (slice 136; founder decision
 * C113): "Save view" names the filters on the Tasks page or a backlog; the
 * view is listed under Tasks in the left menu and lit while open; changing a
 * filter on an open view changes nothing until "Update view"; the menu's `⋯`
 * renames and deletes. Who may see a view (only its member), the canonical
 * filters and the caps are `saved-views.dbtest.ts`'s.
 *
 * IN THE SECOND WORKSPACE, in fresh projects per run (`tasks-workspace`), and
 * every view removed afterwards (`clear-saved-views`) — never the shared one,
 * whose left menu other specs photograph. The workspace pointer is the
 * SESSION's, so every test switches there and the afterEach switches back.
 */

let seed!: E2ESeed;
let ws!: TasksWorkspace;
const run = Math.random().toString(36).slice(2, 7);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  seed = requireSeed();
  ws = await tasksWorkspace(seed.secondTenantId);
});

test.afterAll(async () => {
  await clearSavedViews(seed.secondTenantId);
});

async function into(page: Page, name: string) {
  await page.goto("/dashboard");
  await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  await page.waitForURL("**/home");
}

test.beforeEach(async ({ page }) => {
  await into(page, seed.secondTenantName);
});

test.afterEach(async ({ page }) => {
  await into(page, seed.tenantName);
});

const WAIT = { timeout: 20_000 * SLOW };
const menu = (page: Page): Locator => page.getByTestId("saved-views-rail");
const menuRow = (page: Page, name: string): Locator => menu(page).getByTestId("saved-view-row").filter({ hasText: name });

/** The view the address names, or null. */
const openViewId = (page: Page): string | null => new URL(page.url()).searchParams.get("view");

async function saveView(page: Page, name: string) {
  const before = openViewId(page);
  await page.getByTestId("saved-view-save").click();
  const dialog = page.getByTestId("save-view-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("save-view-name").fill(name);
  await dialog.getByTestId("save-view-submit").click();
  await expect(dialog).toHaveCount(0, WAIT);
  // A NEW view opens — for "Save as new view" the address named one already.
  await expect.poll(() => openViewId(page), WAIT).toMatch(/^[0-9a-f-]{36}$/);
  await expect.poll(() => openViewId(page), WAIT).not.toBe(before);
  // Focus is on the open view's name, never dropped on the page body.
  await expect(page.getByTestId("saved-view-open")).toBeFocused(WAIT);
}

test("Tasks page: save a view, see it lit in the menu, change a filter, Update view, rename and delete it", async ({ page }) => {
  const name = `Overdue ${run}`;
  await page.goto(`/tasks?project=${ws.projectKey}`);
  await expect(page.getByTestId("tasks-row").first()).toBeVisible(WAIT);
  await page.getByTestId("tasks-filter-overdue").click();
  await expect(page).toHaveURL(/due=overdue/);

  await saveView(page, name);
  await expect(page).toHaveURL(/due=overdue/);
  const link = menuRow(page, name).getByTestId("saved-view-link");
  await expect(link).toBeVisible(WAIT);
  await expect(link).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("saved-view-open")).toContainText(name);
  await expect(page.getByTestId("saved-view-update")).toHaveCount(0);

  // A changed filter changes nothing until Update view (C113 (d)).
  await page.getByTestId("tasks-filter-week").click();
  await expect(page).toHaveURL(/due=week/);
  await expect(page).toHaveURL(/view=/);
  const update = page.getByTestId("saved-view-update");
  await expect(update).toBeVisible(WAIT);
  await expect(link).toHaveAttribute("href", /due=overdue/);
  await update.click();
  await expect(update).toHaveCount(0, WAIT);
  await expect(link).toHaveAttribute("href", /due=week/, WAIT);

  // From anywhere, the menu opens it with its filters.
  await page.goto("/home");
  await menuRow(page, name).getByTestId("saved-view-link").click();
  await expect(page).toHaveURL(/\/tasks\?.*due=week.*view=/, WAIT);
  await expect(page.getByTestId("tasks-filter-week")).toHaveAttribute("aria-pressed", "true");

  // Rename from the menu.
  const renamed = `Due this week ${run}`;
  await menuRow(page, name).hover();
  await menuRow(page, name).getByTestId("saved-view-menu").click();
  await page.getByTestId("saved-view-rename").click();
  const renameDialog = page.getByTestId("rename-view-dialog");
  await expect(renameDialog).toBeVisible();
  await renameDialog.getByTestId("rename-view-name").fill(renamed);
  await renameDialog.getByTestId("rename-view-submit").click();
  await expect(renameDialog).toHaveCount(0, WAIT);
  await expect(menuRow(page, renamed)).toBeVisible(WAIT);
  await expect(menuRow(page, name)).toHaveCount(0);

  // Delete it — the open view's name leaves the address; the filters stay.
  await menuRow(page, renamed).hover();
  await menuRow(page, renamed).getByTestId("saved-view-menu").click();
  await page.getByTestId("saved-view-delete").click();
  const deleteDialog = page.getByTestId("delete-view-dialog");
  await expect(deleteDialog).toContainText(renamed);
  await deleteDialog.getByTestId("delete-view-submit").click();
  await expect(menuRow(page, renamed)).toHaveCount(0, WAIT);
  await expect(page).not.toHaveURL(/view=/, WAIT);
  await expect(page).toHaveURL(/due=week/);
  // Focus is not dropped on the page body: it lands on the rail's Tasks entry
  // (the list it hung under is gone with its last view).
  await expect(page.locator('aside a[href="/tasks"]')).toBeFocused(WAIT);
});

test("a backlog: save its filters as a view of that project, and Save as new view keeps the first", async ({ page }) => {
  const name = `Open work ${run}`;
  await page.goto(`/projects/${ws.projectKey}/backlog`);
  await expect(page.getByTestId("work-filter-bar")).toBeVisible(WAIT);
  await page.getByTestId("work-filter-hide-done").click();
  await expect(page).toHaveURL(/hideDone=true/);

  await saveView(page, name);
  const row = menuRow(page, name);
  await expect(row).toBeVisible(WAIT);
  await expect(row).toContainText(ws.projectKey);
  await expect(row.getByTestId("saved-view-link")).toHaveAttribute("href", new RegExp(`/projects/${ws.projectKey}/backlog\\?hideDone=true&view=`));

  // Another filter: the open view is unchanged; Save as new view names a second.
  await page.getByTestId("work-filter-group").click();
  await page.getByTestId("work-group-priority").click();
  await expect(page.getByTestId("saved-view-update")).toBeVisible(WAIT);
  const second = `By priority ${run}`;
  await saveView(page, second);
  await expect(menuRow(page, second).getByTestId("saved-view-link")).toHaveAttribute("aria-current", "page", WAIT);
  await expect(row.getByTestId("saved-view-link")).toHaveAttribute("href", /hideDone=true&view=/);
  await expect(row.getByTestId("saved-view-link")).not.toHaveAttribute("aria-current", "page");
});
