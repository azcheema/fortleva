import { expect, test, type Locator, type Page } from "@playwright/test";

import { importWorkspace, requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * THE BIN FOR DELETED TASKS, through a real member session (slice 126;
 * founder decision C102).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT: "Task deleted" carries an Undo
 * that brings the task back onto the backlog and the board; the backlog's
 * foot leads to the project's Deleted tasks page; and Bring back there
 * returns the task. Who may, what comes back, private, and the refusals are
 * `bin.dbtest.ts`'s.
 *
 * IN THE SECOND WORKSPACE, in a fresh project per run (`import-workspace`),
 * never the shared one: its backlog and board are other specs' counts and
 * the visual walk's photographs. The workspace pointer is the SESSION's, so
 * every test switches there and the afterEach switches back.
 */

let seed!: E2ESeed;
let project!: { projectKey: string; projectName: string };

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  seed = requireSeed();
  project = await importWorkspace(seed.secondTenantId);
});

const toast = (page: Page, text: string | RegExp): Locator => page.locator("[data-sonner-toast]", { hasText: text });

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

/** A menu opened until its item shows — the trigger is Radix's, live only after hydration. */
async function openMenu(page: Page, scope: Locator, trigger: string | RegExp, item: string) {
  await expect(async () => {
    if (!(await page.getByRole("menuitem", { name: item }).isVisible())) {
      await scope.getByRole("button", { name: trigger }).click({ timeout: 2_000 });
    }
    await expect(page.getByRole("menuitem", { name: item })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** A task made through the backlog's create row; resolves once the server's row (a numbered key) is on screen. */
async function createTask(page: Page, title: string): Promise<Locator> {
  await page.locator("#new-task").getByRole("button").click();
  const input = page.locator("#new-task input");
  await input.fill(title);
  await input.press("Enter");
  const row = page.locator('[data-slot="table-row"]', { hasText: title });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText(new RegExp(`${project.projectKey}-[1-9]`), { timeout: 20_000 });
  await input.press("Escape");
  return row;
}

/** Delete from the row's menu: the in-place question, then Yes. */
async function deleteRow(page: Page, row: Locator) {
  await openMenu(page, row, /Actions for/, "Delete");
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await row.getByRole("button", { name: "Yes" }).click();
}

test("Undo on “Task deleted” brings the task back, from the backlog and from the board", async ({ page }) => {
  const title = `Undo me ${Date.now()}`;
  await page.goto(`/projects/${project.projectKey}/backlog`);
  const row = await createTask(page, title);

  await deleteRow(page, row);
  const deleted = toast(page, "Task deleted");
  await expect(deleted).toBeVisible();
  await expect(row).toHaveCount(0);
  await deleted.getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Task brought back.")).toBeVisible();
  await expect(page.locator('[data-slot="table-row"]', { hasText: title })).toBeVisible({ timeout: 20_000 });

  // The board shares the toast (one hook).
  await page.goto(`/projects/${project.projectKey}/board`);
  const card = page.locator("[data-board-card]", { hasText: title });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await openMenu(page, card, /Actions for/, "Delete");
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await card.getByRole("button", { name: "Yes" }).click();
  const fromBoard = toast(page, "Task deleted");
  await expect(fromBoard).toBeVisible();
  await expect(card).toHaveCount(0, { timeout: 20_000 });
  await fromBoard.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator("[data-board-card]", { hasText: title })).toBeVisible({ timeout: 20_000 });
});

test("a deleted task is on the project's Deleted tasks page, and Bring back returns it", async ({ page }) => {
  const title = `Bin me ${Date.now()}`;
  await page.goto(`/projects/${project.projectKey}/backlog`);
  const row = await createTask(page, title);
  const key = (await row.textContent())!.match(new RegExp(`${project.projectKey}-\\d+`))![0];

  await deleteRow(page, row);
  await expect(toast(page, "Task deleted")).toBeVisible();
  await expect(row).toHaveCount(0);

  await page.getByTestId("backlog-bin-link").click();
  await page.waitForURL(`**/projects/${project.projectKey}/deleted`);
  await expect(page.getByRole("heading", { name: "Deleted tasks", level: 2 })).toBeVisible();
  const binRow = page.locator(`[data-testid="bin-row"][data-key="${key}"]`);
  await expect(binRow).toContainText(title);

  await openMenu(page, binRow, `Actions for ${key}`, "Bring back");
  await page.getByRole("menuitem", { name: "Bring back" }).click();
  await expect(toast(page, "Task brought back.")).toBeVisible();
  await expect(binRow).toHaveCount(0, { timeout: 20_000 });

  await page.goto(`/projects/${project.projectKey}/backlog`);
  await expect(page.locator('[data-slot="table-row"]', { hasText: title })).toBeVisible({ timeout: 20_000 });
});
