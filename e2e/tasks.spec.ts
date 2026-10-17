import { expect, test, type Locator, type Page } from "@playwright/test";

import { actionAnswered } from "./fixtures/actions";
import { SLOW, picker, rail, searchField } from "./fixtures/keys";
import { requireSeed, tasksWorkspace, type E2ESeed, type TasksWorkspace } from "./fixtures/tenant";

/**
 * EVERY TASK IN ONE LIST, AND ALL PROJECTS ON ONE TIMELINE, through a real
 * member session (slice 130; founder decision C107).
 *
 * WHAT THIS PROVES THAT THE DBTESTS CANNOT: the Tasks page lists a project's
 * open tasks soonest first; each quick toggle and picker narrows it through
 * the URL, Overdue and Due this week replacing each other as Mine and Nobody
 * do; Group by draws a heading per project and per person; a row opens the
 * task BESIDE the list, a change made there reaches the list, and closing it
 * keeps the filters and puts focus back on the row. The Projects page's
 * Timeline switch draws a dated project's bar and milestone and lists an
 * undated one underneath; Later and Today move the window. Who sees what is
 * `all-tasks.dbtest.ts`'s and `lineup.dbtest.ts`'s.
 *
 * IN THE SECOND WORKSPACE, in fresh projects per run (`tasks-workspace`),
 * never the shared one. The workspace pointer is the SESSION's, so every test
 * switches there and the afterEach switches back.
 */

let seed!: E2ESeed;
let ws!: TasksWorkspace;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  seed = requireSeed();
  ws = await tasksWorkspace(seed.secondTenantId);
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

const row = (page: Page, title: string): Locator => page.getByTestId("tasks-row").filter({ hasText: title });
const WAIT = { timeout: 20_000 * SLOW };

test("lists the open tasks soonest first; the toggles, the pickers and Group by narrow and arrange it", async ({ page }) => {
  await page.goto(`/tasks?project=${ws.projectKey}`);
  await expect(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  await expect(row(page, ws.overdue.title)).toBeVisible(WAIT);
  const titles = await page.getByTestId("tasks-row").allTextContents();
  const at = (title: string) => titles.findIndex((t) => t.includes(title));
  expect(at(ws.overdue.title)).toBeLessThan(at(ws.mine.title));
  expect(at(ws.mine.title)).toBeLessThan(at(ws.later.title));
  await expect(row(page, ws.elsewhere.title)).toHaveCount(0);
  // The overdue task says so — in words as well as in colour.
  await expect(row(page, ws.overdue.title).getByTestId("tasks-row-due")).toContainText("(overdue)");
  await expect(row(page, ws.mine.title).getByTestId("tasks-row-due")).not.toContainText("(overdue)");

  // Overdue, then Due this week in its place, then neither.
  const overdue = page.getByTestId("tasks-filter-overdue");
  const week = page.getByTestId("tasks-filter-week");
  await overdue.click();
  await expect(page).toHaveURL(/due=overdue/);
  await expect(overdue).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, ws.mine.title)).toHaveCount(0, WAIT);
  await expect(row(page, ws.overdue.title)).toBeVisible();
  await week.click();
  await expect(page).toHaveURL(/due=week/);
  await expect(overdue).toHaveAttribute("aria-pressed", "false");
  await expect(row(page, ws.mine.title)).toBeVisible(WAIT);
  await expect(row(page, ws.later.title)).toHaveCount(0);
  await week.click();
  await expect(page).not.toHaveURL(/due=/);
  await expect(row(page, ws.later.title)).toBeVisible(WAIT);

  // Mine, then Nobody in its place — the person picker says the same.
  await page.getByTestId("tasks-filter-mine").click();
  await expect(page).toHaveURL(/person=me/);
  await expect(row(page, ws.overdue.title)).toHaveCount(0, WAIT);
  await expect(row(page, ws.mine.title)).toBeVisible();
  await page.getByTestId("tasks-filter-nobody").click();
  await expect(page).toHaveURL(/person=none/);
  await expect(page.getByTestId("tasks-filter-mine")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("tasks-person-filter")).toHaveValue("none");
  await expect(row(page, ws.overdue.title)).toBeVisible(WAIT);
  await expect(row(page, ws.mine.title)).toHaveCount(0);

  // The project picker keeps the other filters.
  await page.getByTestId("tasks-project-filter").selectOption(ws.otherKey);
  await expect(page).toHaveURL(new RegExp(`project=${ws.otherKey}`));
  await expect(page).toHaveURL(/person=none/);
  await expect(row(page, ws.elsewhere.title)).toBeVisible(WAIT);
  await expect(row(page, ws.overdue.title)).toHaveCount(0);

  // Group by project: a heading per project, each holding its own tasks.
  await page.goto("/tasks?group=project");
  const groupOf = (name: string) => page.getByTestId("tasks-group").filter({ has: page.locator("h2", { hasText: name }) });
  await expect(groupOf(ws.projectName).getByTestId("tasks-row")).toHaveCount(3, WAIT);
  await expect(groupOf(ws.projectName)).not.toContainText(ws.elsewhere.title);
  // Group by person: Nobody first.
  await page.getByTestId("tasks-group").first().waitFor();
  await page.getByTestId("tasks-group-by").selectOption("person");
  await expect(page).toHaveURL(/group=person/);
  await expect(page.getByTestId("tasks-group").first()).toHaveAttribute("data-group", "none", WAIT);
});

test("a task opens beside the list; a change made there reaches it; closing keeps the filters and the place", async ({ page }) => {
  await page.goto(`/tasks?project=${ws.projectKey}&person=none`);
  const peek = page.getByTestId("item-peek");

  // Opened and closed with nothing changed: focus comes back to its row.
  await row(page, ws.overdue.title).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`item=${ws.projectKey}-${ws.overdue.number}`));
  await expect(page).toHaveURL(/person=none/);
  await expect(peek).toBeVisible(WAIT);
  await expect(peek).toContainText(ws.overdue.title);
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0, WAIT);
  await expect(page).not.toHaveURL(/item=/);
  await expect(page).toHaveURL(/person=none/);
  await expect(row(page, ws.overdue.title).getByRole("link")).toBeFocused(WAIT);

  // Assigned from the panel: the task is nobody's no more, and leaves the list.
  await row(page, ws.later.title).getByRole("link").click();
  await expect(peek).toBeVisible(WAIT);
  await expect(peek).toContainText(ws.later.title);
  await rail(page).getByTestId("item-assignee").click();
  await expect(searchField(page)).toBeFocused();
  await page.keyboard.type("Owner");
  await expect(picker(page).getByRole("option", { name: /E2E Owner/ })).toHaveAttribute("aria-selected", "true");
  const assigned = actionAnswered(page, { contains: "memberId" });
  await page.keyboard.press("Enter");
  await assigned;
  await expect(rail(page).getByTestId("item-assignee").locator("[data-value]")).toHaveText("E2E Owner", WAIT);
  // The picker must be GONE before the Escape meant for the panel: a popover
  // still playing its exit is the top layer and takes the key (CI run
  // 39063804125 — both attempts; the keymap spec's ladder waits the same way).
  await expect(picker(page)).toHaveCount(0, WAIT);
  await expect(rail(page).getByTestId("item-assignee")).toBeFocused(WAIT);
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0, WAIT);
  await expect(page).toHaveURL(/person=none/);
  await expect(row(page, ws.later.title)).toHaveCount(0, WAIT);
  await expect(row(page, ws.overdue.title)).toBeVisible();
  // Its row is gone, so focus goes to the list's own region — never <body>.
  await expect(page.getByTestId("tasks-region")).toBeFocused(WAIT);
});

test("the Projects page's Timeline draws a dated project's bar and milestone, and lists an undated one", async ({ page }) => {
  // A FRESH load of the timeline leaves focus alone — the New project form
  // below it took focus and scrolled the chart away (the review's MEDIUM).
  await page.goto("/projects?view=timeline");
  const lineupRow = page.locator(`[data-testid="lineup-row"][data-project-key="${ws.projectKey}"]`);
  await expect(lineupRow).toBeVisible(WAIT);
  await expect(page.locator("#p-key")).toHaveCount(1);
  await expect(page.locator("#p-key")).not.toBeFocused();

  // The switch, from the list.
  await page.goto("/projects");
  await page.getByTestId("projects-view-timeline").click();
  await expect(page).toHaveURL(/view=timeline/);
  await expect(lineupRow).toBeVisible(WAIT);
  await expect(lineupRow.getByTestId("lineup-bar")).toHaveCount(1);
  await expect(lineupRow.getByTestId("lineup-milestone")).toHaveCount(1);
  await expect(lineupRow.getByRole("link")).toHaveAttribute("href", `/projects/${ws.projectKey}`);
  await expect(page.getByTestId("lineup-undated").locator(`[data-project-key="${ws.otherKey}"]`)).toContainText(
    "No start or launch date",
  );

  // Later moves the window and keeps the row; Today brings it back.
  await page.getByTestId("lineup-later").click();
  await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}/);
  await expect(lineupRow).toBeVisible(WAIT);
  await page.getByTestId("lineup-today").click();
  await expect(page).not.toHaveURL(/from=/);
  await expect(lineupRow.getByTestId("lineup-bar")).toHaveCount(1, WAIT);

  // And back to the list.
  await page.getByTestId("projects-view-list").click();
  await expect(page).not.toHaveURL(/view=/);
});
