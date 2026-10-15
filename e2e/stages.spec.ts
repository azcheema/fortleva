import { expect, test, type Locator, type Page } from "@playwright/test";

import { SLOW } from "./fixtures/keys";
import { importWorkspace, requireSeed, resetStagePreset, type E2ESeed } from "./fixtures/tenant";

/**
 * THE WORKSPACE'S OWN STAGES AND LABELS, through a real owner session
 * (slice 123, founder decision C99).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT: the board's "Edit stages" leads
 * to the project's Stages page; a rename there is the column's name on the
 * board; a stage is added and removed from the table and its menu; the
 * workspace default on Settings → Stages is what a NEW project's board
 * starts with, and Restore puts the original back; and a label on Settings
 * → Labels is made with a colour that shows as a dot, renamed, merged and
 * deleted.
 *
 * IN THE SECOND WORKSPACE, never the shared one: the shared board, its
 * stages and its labels are other specs' fixtures and the visual walk's
 * photographs. `import-workspace` makes a fresh project there per run. The
 * workspace default is put back by `reset-stage-preset` in the afterAll — a
 * hook still runs after a failure — because `import.spec.ts`'s fresh
 * projects in this workspace copy it and match statuses onto stages by name.
 */

let seed!: E2ESeed;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  seed = requireSeed();
});

test.afterAll(async () => {
  await resetStagePreset(seed.secondTenantId);
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
const stageRow = (page: Page, name: string): Locator => page.getByTestId("stage-row").filter({ hasText: name }).first();

/**
 * Rename through the inline edit: focus the trigger ("Edit Name, currently
 * …" — `common.inlineEdit.trigger` around the column's label), Enter opens,
 * type, Enter commits. The open control is the FOCUSED input: while editing,
 * the value lives in the control and not in the row's text, so a row found
 * by its text no longer matches (`settings.spec.ts` says the same).
 */
async function rename(page: Page, row: Locator, to: string) {
  await expect(async () => {
    await row.getByRole("button", { name: /^Edit Name, currently/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("input:focus")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.locator("input:focus").fill(to);
  await page.keyboard.press("Enter");
}

/** A row's menu, opened until its item shows — the trigger is Radix's, live only after hydration. */
async function openMenu(page: Page, row: Locator, item: string) {
  await expect(async () => {
    if (!(await page.getByRole("menuitem", { name: item }).isVisible())) {
      await row.getByRole("button", { name: /^Actions for/ }).click({ timeout: 2_000 });
    }
    await expect(page.getByRole("menuitem", { name: item })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test("a project's own stages: renamed on its Stages page, the board shows it; a stage is added and removed", async ({ page }) => {
  const project = await importWorkspace(seed.secondTenantId);
  await page.goto(`/projects/${project.projectKey}/board`);
  await page.getByTestId("board-edit-stages").click();
  await page.waitForURL(`**/projects/${project.projectKey}/stages`);

  await rename(page, stageRow(page, "In review"), "Client check");
  await expect(stageRow(page, "Client check").getByText("Saved")).toBeVisible({ timeout: 15_000 * SLOW });

  // Add one in the In progress kind: it lands at the end of that kind.
  await page.getByTestId("stage-name").fill("QA");
  await page.getByTestId("stage-kind").selectOption("IN_PROGRESS");
  await page.getByTestId("stage-submit").click();
  // The add form answers in its own line (`FormMessage`), not a toast.
  await expect(page.getByTestId("add-stage-form").getByText("Stage added.")).toBeVisible({ timeout: 15_000 * SLOW });
  const names = page.getByTestId("stage-row").locator("td:first-child");
  await expect(names.nth(4)).toContainText("QA");

  // Remove it: empty, so the menu asks and acts.
  await openMenu(page, stageRow(page, "QA"), "Remove");
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await stageRow(page, "QA").getByRole("button", { name: "Yes" }).click();
  await expect(toast(page, "Stage removed.")).toBeVisible({ timeout: 15_000 * SLOW });
  await expect(page.getByTestId("stage-row").filter({ hasText: "QA" })).toHaveCount(0);

  // The last Done stage cannot go: its menu says why instead.
  await openMenu(page, stageRow(page, "Done"), "Remove");
  await expect(page.getByRole("menuitem", { name: "Remove" })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");

  // The board's column is the new name.
  await page.goto(`/projects/${project.projectKey}/board`);
  await expect(page.getByText("Client check", { exact: true }).first()).toBeVisible({ timeout: 15_000 * SLOW });
});

test("the workspace default is what a NEW project starts with, and Restore brings the original back", async ({ page }) => {
  await page.goto("/settings/stages");
  await rename(page, stageRow(page, "Backlog"), "Ideas");
  await expect(stageRow(page, "Ideas").getByText("Saved")).toBeVisible({ timeout: 15_000 * SLOW });

  const fresh = await importWorkspace(seed.secondTenantId);
  await page.goto(`/projects/${fresh.projectKey}/stages`);
  await expect(stageRow(page, "Ideas")).toBeVisible({ timeout: 15_000 * SLOW });

  await page.goto("/settings/stages");
  await expect(async () => {
    if (!(await page.getByRole("menuitem", { name: "Restore the original stages" }).isVisible())) {
      await page.getByRole("button", { name: "More for the default stages" }).click({ timeout: 2_000 });
    }
    await expect(page.getByRole("menuitem", { name: "Restore the original stages" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("menuitem", { name: "Restore the original stages" }).click();
  await page.getByRole("button", { name: "Yes" }).click();
  await expect(toast(page, "The original stages are back.")).toBeVisible({ timeout: 15_000 * SLOW });
  await expect(stageRow(page, "Backlog")).toBeVisible();
  await expect(page.getByTestId("stage-row").filter({ hasText: "Ideas" })).toHaveCount(0);
});

test("a label is made with a colour, renamed, merged into another and deleted", async ({ page }) => {
  const run = Math.random().toString(36).slice(2, 7);
  const first = `Brand ${run}`;
  const second = `Brand copy ${run}`;
  const labelRow = (name: string) => page.getByTestId("label-row").filter({ hasText: name }).first();

  await page.goto("/settings/labels");
  for (const [name, color] of [
    [first, "teal"],
    [second, ""],
  ] as const) {
    await page.getByTestId("label-name").fill(name);
    await page.getByTestId("label-color").selectOption(color);
    await page.getByTestId("label-submit").click();
    await expect(page.getByTestId("label-form").getByText(`Label “${name}” added.`)).toBeVisible({ timeout: 15_000 * SLOW });
  }
  await expect(labelRow(first)).toHaveAttribute("data-color", "teal");
  await expect(labelRow(first).locator('[data-slot="label-dot"]')).toBeVisible();
  await expect(labelRow(second).locator('[data-slot="label-dot"]')).toHaveCount(0);

  const renamed = `Brand work ${run}`;
  await rename(page, labelRow(first), renamed);
  await expect(labelRow(renamed).getByText("Saved")).toBeVisible({ timeout: 15_000 * SLOW });

  // Merge the copy into the renamed one: the copy is gone.
  await openMenu(page, labelRow(second), "Merge into…");
  await page.getByRole("menuitem", { name: "Merge into…" }).click();
  await page.getByTestId("merge-label-into").selectOption({ label: renamed });
  await page.getByTestId("merge-label-confirm").click();
  await expect(toast(page, /now wear|now wears/)).toBeVisible({ timeout: 15_000 * SLOW });
  await expect(page.getByTestId("label-row").filter({ hasText: second })).toHaveCount(0);

  // Delete asks first.
  await openMenu(page, labelRow(renamed), "Delete");
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await labelRow(renamed).getByRole("button", { name: "Yes" }).click();
  await expect(toast(page, "Label deleted.")).toBeVisible({ timeout: 15_000 * SLOW });
  await expect(page.getByTestId("label-row").filter({ hasText: renamed })).toHaveCount(0);
});
