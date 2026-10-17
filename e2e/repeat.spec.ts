import { expect, test, type Locator, type Page } from "@playwright/test";

import { picker, rail } from "./fixtures/keys";
import { importWorkspace, repeatDue, requireSeed, runRepeats, type E2ESeed } from "./fixtures/tenant";

/**
 * REPEATING TASKS, through a real member session (slice 127; founder decision
 * C103).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT: the task panel's Repeat row sets a
 * rhythm and grows a Next copy row with its note; once the day has come
 * (planted — `repeat-due`) and the copier has run for this workspace
 * (`run-repeats`, never the jobs route), the copy is on the backlog under the
 * same title; the older task's row links to the newest, and the newest holds
 * the setting and can stop it. What a copy carries, who gets it, the
 * refusals and the database's belts are `repeat.dbtest.ts`'s.
 *
 * IN THE SECOND WORKSPACE, in a fresh project per run (`import-workspace`),
 * never the shared one: its backlog is other specs' counts and the visual
 * walk's photographs. The workspace pointer is the SESSION's, so the test
 * switches there and the afterEach switches back.
 */

let seed!: E2ESeed;
let project!: { projectKey: string; projectName: string };

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  seed = requireSeed();
  project = await importWorkspace(seed.secondTenantId);
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

/** The rail's live regions — one per island, silent until something changed. */
const said = (page: Page, text: string | RegExp): Locator => rail(page).locator('[role="status"]', { hasText: text });

const rows = (page: Page, title: string): Locator => page.locator('[data-slot="table-row"]', { hasText: title });

/** A task made through the backlog's create row; resolves to its number once the server's row is on screen. */
async function createTask(page: Page, title: string): Promise<number> {
  await page.locator("#new-task").getByRole("button").click();
  const input = page.locator("#new-task input");
  await input.fill(title);
  await input.press("Enter");
  const row = rows(page, title);
  await expect(row).toContainText(new RegExp(`${project.projectKey}-[1-9]`), { timeout: 20_000 });
  await input.press("Escape");
  const text = (await row.textContent()) ?? "";
  const match = new RegExp(`${project.projectKey}-(\\d+)`).exec(text);
  expect(match, "the row shows its key").toBeTruthy();
  return Number(match![1]);
}

async function peek(page: Page, number: number) {
  await page.goto(`/projects/${project.projectKey}/backlog?item=${project.projectKey}-${number}`);
  await expect(page.getByTestId("item-peek")).toBeVisible({ timeout: 20_000 });
}

test("a task set to repeat gets its copy on its day; the older one links to the newest, which holds the setting", async ({ page }) => {
  const title = `Weekly check-in ${Date.now()}`;
  await page.goto(`/projects/${project.projectKey}/backlog`);
  const first = await createTask(page, title);

  // Set it: Every week. The Next copy row and its note appear.
  await peek(page, first);
  await expect(rail(page).getByTestId("item-repeat")).toContainText("Doesn't repeat");
  await expect(async () => {
    if (!(await picker(page).isVisible())) await rail(page).getByTestId("item-repeat").click({ timeout: 2_000 });
    await expect(picker(page).getByTestId("item-repeat-rhythm-WEEKLY")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await picker(page).getByTestId("item-repeat-rhythm-WEEKLY").click();
  await expect(said(page, /^Repeats every week, next copy /)).toHaveCount(1, { timeout: 20_000 });
  await expect(rail(page).getByTestId("item-repeat")).toContainText("Every week");
  await expect(rail(page).getByTestId("item-repeat-next")).toBeVisible();
  await expect(rail(page).getByTestId("item-repeat-note")).toContainText("starts hidden from the client");

  // A reload keeps it — the setting is the server's, not an optimistic slice.
  await peek(page, first);
  await expect(rail(page).getByTestId("item-repeat")).toContainText("Every week");

  // Slice 127b: the backlog row and the board card carry the repeat marker.
  await page.goto(`/projects/${project.projectKey}/backlog`);
  await expect(rows(page, title).getByTestId("repeat-marker")).toHaveCount(1, { timeout: 20_000 });
  await expect(rows(page, title).getByTestId("repeat-marker")).toHaveAttribute("title", "Repeats every week");
  await expect(rows(page, title).getByTestId("repeat-marker")).toContainText("Repeats every week"); // its sr-only words
  await page.goto(`/projects/${project.projectKey}/board`);
  const card = page.getByTestId("board-card").filter({ hasText: title });
  await expect(card.getByRole("img", { name: "Repeats every week" })).toBeVisible({ timeout: 20_000 });

  // Its day comes; the copier runs for this workspace. AT LEAST one copy: a
  // retried run may have left an earlier attempt's series due in this
  // workspace — this test's own copy is counted on its backlog below.
  await repeatDue(seed.secondTenantId, project.projectKey, first);
  const run = await runRepeats(seed.secondTenantId);
  expect(run.made).toBeGreaterThanOrEqual(1);
  expect(run.failed).toBe(0);

  await page.goto(`/projects/${project.projectKey}/backlog`);
  await expect(rows(page, title)).toHaveCount(2, { timeout: 20_000 });

  // The older task links to the newest…
  await peek(page, first);
  const link = rail(page).getByTestId("item-repeat-holder-link");
  await expect(link).toHaveText(new RegExp(`^Repeats from ${project.projectKey}-\\d+$`));
  const newest = Number(/-(\d+)$/.exec((await link.textContent()) ?? "")![1]);
  expect(newest).toBeGreaterThan(first);
  // …which holds the setting.
  await peek(page, newest);
  await expect(rail(page).getByTestId("item-repeat")).toContainText("Every week");
  await expect(rail(page).getByTestId("item-repeat-next")).toBeVisible();
  // The marker moved with it: on the newest row only.
  await page.goto(`/projects/${project.projectKey}/backlog`);
  await expect(rows(page, title).getByTestId("repeat-marker")).toHaveCount(1, { timeout: 20_000 });
  await expect(
    page.locator('[data-slot="table-row"]', { hasText: `${project.projectKey}-${newest}` }).filter({ hasText: title }).getByTestId("repeat-marker"),
  ).toHaveCount(1);

  // The newest deleted: the older task says the series is paused, and can
  // stop it — so a newest copy deleted for good never strands its series.
  await page.goto(`/projects/${project.projectKey}/backlog`);
  const newestRow = page.locator('[data-slot="table-row"]', { hasText: `${project.projectKey}-${newest}` }).filter({ hasText: title });
  await expect(async () => {
    if (!(await page.getByRole("menuitem", { name: "Delete" }).isVisible())) {
      await newestRow.getByRole("button", { name: /Actions for/ }).click({ timeout: 2_000 });
    }
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await newestRow.getByRole("button", { name: "Yes" }).click();
  await expect(rows(page, title)).toHaveCount(1, { timeout: 20_000 });

  await peek(page, first);
  await expect(rail(page).getByTestId("item-repeat-copy")).toContainText(`Paused: ${project.projectKey}-${newest} is deleted`);
  await rail(page).getByTestId("item-repeat-stop-series").click();
  await expect(said(page, "Stopped repeating")).toHaveCount(1, { timeout: 20_000 });
  await expect(rail(page).getByTestId("item-repeat-copy")).toHaveCount(0);

  // Stopped, the older task is a plain task again — after a reload too.
  await peek(page, first);
  await expect(rail(page).getByTestId("item-repeat-copy")).toHaveCount(0);
  await expect(rail(page).getByTestId("item-repeat")).toContainText("Doesn't repeat");
  await expect(rail(page).getByTestId("item-repeat-next")).toHaveCount(0);
  // …and no live row of this title carries the marker. (The older task lost
  // it when the copy was made, above; that Stop itself clears a marker is
  // `repeat.dbtest.ts`'s — the newest here is in the bin.)
  await page.goto(`/projects/${project.projectKey}/backlog`);
  await expect(rows(page, title)).toHaveCount(1, { timeout: 20_000 });
  await expect(rows(page, title).getByTestId("repeat-marker")).toHaveCount(0);
});
