import { expect, test, type Locator, type Page } from "@playwright/test";

import { SLOW } from "./fixtures/keys";
import { clearTemplates, requireSeed, templateSource, type E2ESeed } from "./fixtures/tenant";

/**
 * PROJECT TEMPLATES, through a real owner session (slice 124, founder
 * decision C100).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT: "Save as template" on a
 * project's Overview opens a dialog that says what comes along and saves;
 * saving again under the same name says it replaces; Settings → Templates
 * lists it, renames it and deletes it; and the New project form offers it,
 * shows a Start date once it is chosen, makes the project with its tasks,
 * and puts the Start date away again after the form resets.
 *
 * IN THE SECOND WORKSPACE, never the shared one: the shared workspace's one
 * seeded template is the visual walk's photograph. `template-source` makes a
 * fresh project there per run (an Epic with a Task under it, a Backlog task,
 * one milestone), and `clear-templates` in the afterAll — a hook still runs
 * after a failure — leaves no template behind for another run's form.
 */

let seed!: E2ESeed;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  seed = requireSeed();
});

test.afterAll(async () => {
  await clearTemplates(seed.secondTenantId);
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
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A template's row, by the EXACT name its inline edit wears — never `hasText` (stages.spec.ts's lesson). */
const templateRow = (page: Page, name: string): Locator =>
  page
    .getByTestId("template-row")
    .filter({ has: page.getByRole("button", { name: new RegExp(`^Edit Name, currently ${escapeRegExp(name)}$`) }) });

/** The dialog, opened until it shows — the button is live only after hydration. */
async function openSaveDialog(page: Page) {
  await expect(async () => {
    if (!(await page.getByTestId("save-template-dialog").isVisible())) {
      await page.getByTestId("save-template-open").click({ timeout: 2_000 });
    }
    await expect(page.getByTestId("save-template-dialog")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test("a project saved as a template is renamed in Settings, starts a new project with its tasks, and is deleted", async ({ page }) => {
  const run = Math.random().toString(36).slice(2, 7);
  const name = `Launch ${run}`;
  const renamed = `Launch plan ${run}`;
  const source = await templateSource(seed.secondTenantId);

  // Save it from the Overview: the dialog says what comes along.
  await page.goto(`/projects/${source.projectKey}`);
  await openSaveDialog(page);
  await expect(page.getByTestId("save-template-summary")).toContainText("3 tasks, 1 milestone and the board’s stages.", {
    timeout: 15_000 * SLOW,
  });
  await page.getByTestId("save-template-name").fill(name);
  await expect(page.getByTestId("save-template-submit")).toHaveText("Save template");
  await page.getByTestId("save-template-submit").click();
  await expect(toast(page, `Template “${name}” saved.`)).toBeVisible({ timeout: 15_000 * SLOW });
  await expect(page.getByTestId("save-template-dialog")).toHaveCount(0);

  // The same name again, whatever its case: the dialog says it replaces.
  await openSaveDialog(page);
  await expect(page.getByTestId("save-template-summary")).toBeVisible({ timeout: 15_000 * SLOW });
  await page.getByTestId("save-template-name").fill(name.toUpperCase());
  await expect(page.getByTestId("save-template-replaces")).toContainText(`A template called “${name}” already exists.`);
  await expect(page.getByTestId("save-template-submit")).toHaveText("Replace template");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("save-template-dialog")).toHaveCount(0);

  // Settings → Templates: listed with its count, renamed.
  await page.goto("/settings/templates");
  // The Tasks cell — the second column — never a substring of the row (a date has digits too).
  await expect(templateRow(page, name).locator("td").nth(1)).toHaveText("3");
  await expect(async () => {
    await templateRow(page, name).getByRole("button", { name: /^Edit Name, currently/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("input:focus")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.locator("input:focus").fill(renamed);
  await page.keyboard.press("Enter");
  await expect(templateRow(page, renamed).getByText("Saved")).toBeVisible({ timeout: 15_000 * SLOW });

  // New project from it: the Start date shows once the template is chosen.
  const key = `TN${run.toUpperCase()}`;
  await page.goto("/projects");
  await page.locator("#p-client").selectOption({ label: "E2E Import Client" });
  await page.locator("#p-key").fill(key);
  await page.locator("#p-name").fill(`From a template ${run}`);
  const picker = page.getByTestId("project-template");
  // A change before hydration is lost on React's side: choose again until the field answers.
  await expect(async () => {
    await picker.selectOption("");
    await picker.selectOption({ label: `${renamed} (3 tasks)` });
    await expect(page.getByTestId("project-start-date")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId("project-start-date")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(toast(page, `Created ${key} with 3 tasks and 1 milestone`)).toBeVisible({ timeout: 30_000 * SLOW });
  // The form reset: no template, so no Start date.
  await expect(page.getByTestId("project-start-date")).toHaveCount(0);
  await expect(picker).toHaveValue("");

  await page.goto(`/projects/${key}/board`);
  await expect(page.getByText("Design the start page", { exact: true }).first()).toBeVisible({ timeout: 15_000 * SLOW });
  await expect(page.getByText("Write the privacy page", { exact: true }).first()).toBeVisible();

  // Delete asks first.
  await page.goto("/settings/templates");
  await expect(async () => {
    if (!(await page.getByRole("menuitem", { name: "Delete" }).isVisible())) {
      await templateRow(page, renamed).getByRole("button", { name: /^Actions for/ }).click({ timeout: 2_000 });
    }
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await templateRow(page, renamed).getByRole("button", { name: "Yes" }).click();
  await expect(toast(page, "Template deleted.")).toBeVisible({ timeout: 15_000 * SLOW });
  await expect(templateRow(page, renamed)).toHaveCount(0);
});
