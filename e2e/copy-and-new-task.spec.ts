import { expect, test, type Locator, type Page } from "@playwright/test";

import { picker, rail } from "./fixtures/keys";
import { importWorkspace, requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * A FULLER "NEW TASK" AND COPYING A TASK, through a real member session
 * (slice 129; founder decision C106).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT: a project page's New task button
 * opens the shell's dialog with that project chosen; the dialog's Person, Due
 * date and Priority pickers and its description box reach the task the
 * Create task button makes, which closes the dialog; the panel's Copy… opens
 * a dialog that offers what the task has, and the copy opens where the
 * member will edit it — the peek, in the same project; its own page, in
 * another. What a copy carries part by part, the refusals and who is told
 * are `copy.dbtest.ts`'s.
 *
 * IN THE SECOND WORKSPACE, in two fresh projects per run
 * (`import-workspace`), never the shared one: its backlog is other specs'
 * counts and the visual walk's photographs. The workspace pointer is the
 * SESSION's, so each test switches there and the afterEach switches back.
 */

let seed!: E2ESeed;
let one!: { projectKey: string; projectName: string };
let two!: { projectKey: string; projectName: string };

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  seed = requireSeed();
  one = await importWorkspace(seed.secondTenantId);
  two = await importWorkspace(seed.secondTenantId);
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

const toast = (page: Page, text: string | RegExp): Locator => page.locator("[data-sonner-toast]", { hasText: text });
const rows = (page: Page, title: string): Locator => page.locator('[data-slot="table-row"]', { hasText: title });

/** Open a property picker in the dialog and choose one of its rows by test id (retried: the popover can miss a first click while the dialog settles). */
async function choose(page: Page, trigger: string, option: string): Promise<void> {
  const dialog = page.getByTestId("quick-create");
  await expect(async () => {
    if (!(await picker(page).isVisible())) await dialog.getByTestId(trigger).click({ timeout: 2_000 });
    await expect(picker(page).getByTestId(option)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await picker(page).getByTestId(option).click();
  await expect(picker(page)).toHaveCount(0);
}

test("a project page's New task opens the dialog in that project, and the fuller form reaches the task", async ({ page }) => {
  const stamp = Date.now();
  const title = `Fuller form ${stamp}`;
  const second = `Fuller second ${stamp}`;
  const third = `Fuller third ${stamp}`;
  await page.goto(`/projects/${one.projectKey}`);
  await page.getByTestId("project-new-task").click();
  const dialog = page.getByTestId("quick-create");
  const titleField = page.getByTestId("quick-create-title");
  await expect(dialog).toBeVisible();
  // The project came from the route: no picker, the title ready.
  await expect(page.getByTestId("quick-create-projects")).toHaveCount(0);
  await expect(titleField).toBeFocused();
  await expect(dialog).toContainText(one.projectName);

  await titleField.fill(title);
  await page.getByTestId("quick-create-description").fill("Call them first.\n- [ ] send the brief");
  await expect(dialog.getByTestId("quick-create-assignee")).toContainText("Unassigned");
  await choose(page, "quick-create-assignee", "quick-create-assignee-0");
  await choose(page, "quick-create-due", "quick-create-due-token-tomorrow");
  await choose(page, "quick-create-priority", "quick-create-priority-HIGH");
  await expect(dialog.getByTestId("quick-create-assignee")).not.toContainText("Unassigned");
  await expect(dialog.getByTestId("quick-create-due")).not.toContainText("No due date");
  await expect(dialog.getByTestId("quick-create-priority")).toContainText("High");
  // ⌘⇧Enter keeps these three for the next one, and the dialog says so.
  await expect(dialog).toContainText("keeps the person, date and priority for the next one");

  // ⌘⇧Enter: created, the title and description cleared, the picks KEPT.
  await titleField.press("Control+Shift+Enter");
  await expect(toast(page, `${one.projectKey}-`).first()).toBeVisible({ timeout: 20_000 });
  await expect(titleField).toHaveValue("", { timeout: 20_000 });
  await expect(page.getByTestId("quick-create-description")).toHaveValue("");
  await expect(dialog.getByTestId("quick-create-assignee")).not.toContainText("Unassigned");
  await expect(dialog.getByTestId("quick-create-priority")).toContainText("High");

  // Enter: created with them, and the next starts FRESH.
  await titleField.fill(second);
  await titleField.press("Enter");
  await expect(titleField).toHaveValue("", { timeout: 20_000 });
  await expect(dialog.getByTestId("quick-create-assignee")).toContainText("Unassigned");
  await expect(dialog.getByTestId("quick-create-due")).toContainText("No due date");
  await expect(dialog.getByTestId("quick-create-priority")).toContainText("No priority");

  // The button creates it and closes the dialog; focus goes back to the button.
  await titleField.fill(third);
  await dialog.getByTestId("quick-create-submit").click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId("project-new-task")).toBeFocused();
  await page.goto(`/projects/${one.projectKey}/backlog`);
  await expect(rows(page, second)).toHaveCount(1, { timeout: 20_000 });
  await expect(rows(page, third)).toHaveCount(1);

  // The task carries all of it.
  await page.goto(`/projects/${one.projectKey}/backlog`);
  const row = rows(page, title);
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await row.getByRole("link", { name: new RegExp(`${one.projectKey}-\\d+`) }).first().click();
  await expect(page.getByTestId("item-peek")).toBeVisible({ timeout: 20_000 });
  await expect(rail(page).getByTestId("item-priority")).toContainText("High");
  await expect(rail(page).getByTestId("item-assignee")).not.toContainText("Unassigned");
  await expect(rail(page).getByTestId("item-due")).not.toContainText("—");
  await expect(page.getByTestId("description")).toContainText("Call them first.");
  await expect(page.getByTestId("description")).toContainText("send the brief");
});

test("Copy… from the panel: the dialog offers what the task has; a copy here opens in the peek, a copy elsewhere on its own page", async ({ page }) => {
  const title = `Copy source ${Date.now()}`;
  // A task with a description, made through the dialog.
  await page.goto(`/projects/${one.projectKey}/backlog`);
  await page.getByTestId("project-new-task").click();
  await page.getByTestId("quick-create-title").fill(title);
  await page.getByTestId("quick-create-description").fill("The brief.");
  await page.getByTestId("quick-create-submit").click();
  await expect(page.getByTestId("quick-create")).toHaveCount(0, { timeout: 20_000 });
  const row = rows(page, title);
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  const sourceKey = ((await row.getByRole("link", { name: new RegExp(`${one.projectKey}-\\d+`) }).first().textContent()) ?? "").trim();
  expect(sourceKey).toMatch(new RegExp(`^${one.projectKey}-\\d+$`));
  await row.getByRole("link", { name: sourceKey }).first().click();
  await expect(page.getByTestId("item-peek")).toBeVisible({ timeout: 20_000 });

  // Copy here: the dialog offers the description (it has one) and nothing it does not have.
  await page.getByTestId("item-copy").click();
  const dialog = page.getByTestId("copy-task");
  await expect(dialog.getByTestId("copy-task-title")).toHaveValue(title, { timeout: 20_000 });
  await expect(dialog.getByTestId("copy-task-part-description")).toBeChecked();
  await expect(dialog.getByTestId("copy-task-part-subtasks")).toHaveCount(0);
  await expect(dialog.getByTestId("copy-task-part-labels")).toHaveCount(0);
  await expect(dialog).toContainText("The copy starts hidden from the client.");
  const here = `${title} (here)`;
  await dialog.getByTestId("copy-task-title").fill(here);
  await dialog.getByTestId("copy-task-submit").click();
  await expect(toast(page, /^Copied as /).first()).toBeVisible({ timeout: 20_000 });
  // It opens as the peek on the same list, and says where it came from.
  await expect(page).toHaveURL(new RegExp(`/projects/${one.projectKey}/backlog\\?.*item=${one.projectKey}-\\d+`), { timeout: 20_000 });
  await expect(page.getByTestId("item-peek")).toContainText(here, { timeout: 20_000 });
  await expect(page.getByTestId("description")).toContainText("The brief.");
  await expect(page.getByTestId("item-activity")).toContainText(`copied this from ${sourceKey}`);

  // Copy into the other project: it opens on the copy's own page there.
  await page.goto(`/projects/${one.projectKey}/backlog?item=${sourceKey}`);
  await expect(page.getByTestId("item-peek")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("item-copy").click();
  await expect(dialog.getByTestId("copy-task-title")).toHaveValue(title, { timeout: 20_000 });
  await dialog.getByTestId("copy-task-project").selectOption({ label: `${two.projectKey} · ${two.projectName} — E2E Import Client` });
  await dialog.getByTestId("copy-task-submit").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${two.projectKey}/items/\\d+$`), { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible({ timeout: 20_000 });
  // …and the source's history says so without naming another project's key;
  // the copy made here is named by its key.
  await page.goto(`/projects/${one.projectKey}/backlog?item=${sourceKey}`);
  await expect(page.getByTestId("item-activity")).toContainText("made a copy of this in another project", { timeout: 20_000 });
  await expect(page.getByTestId("item-activity")).toContainText(new RegExp(`made a copy of this, ${one.projectKey}-\\d+`));
  await expect(page.getByTestId("item-activity")).not.toContainText(`${two.projectKey}-`);

  // The backlog row's menu offers Copy… too: the title takes focus once the
  // form is there, and Escape hands focus back to the row.
  await page.goto(`/projects/${one.projectKey}/backlog`);
  const sourceRow = rows(page, title).filter({ hasText: sourceKey });
  await expect(async () => {
    if (!(await page.getByRole("menuitem", { name: "Copy…" }).isVisible())) {
      await sourceRow.getByRole("button", { name: /Actions for/ }).click({ timeout: 2_000 });
    }
    await expect(page.getByRole("menuitem", { name: "Copy…" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("menuitem", { name: "Copy…" }).click();
  await expect(dialog.getByTestId("copy-task-title")).toBeFocused({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(sourceRow).toBeFocused();
});
