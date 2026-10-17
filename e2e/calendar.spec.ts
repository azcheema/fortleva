import { expect, test, type Locator, type Page } from "@playwright/test";

import { calendarWorkspace, requireSeed, type CalendarWorkspace, type E2ESeed } from "./fixtures/tenant";

/**
 * THE CALENDAR OF TASKS, through a real member session (slice 128; founder
 * decision C105).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT: the page draws a project's tasks
 * on their days in the week and month views; "Move…" moves one to another
 * day, and so does a mouse drag, each surviving a reload; a repeating task's
 * coming copy is drawn faint on its due day; the project filter and "Only
 * mine" narrow the page. Who sees what, and what the read leaves out, are
 * `calendar.dbtest.ts`'s.
 *
 * IN THE SECOND WORKSPACE, in a fresh project per run (`calendar-workspace`),
 * never the shared one. The workspace pointer is the SESSION's, so every test
 * switches there and the afterEach switches back.
 */

let seed!: E2ESeed;
let ws!: CalendarWorkspace;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  seed = requireSeed();
  ws = await calendarWorkspace(seed.secondTenantId);
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

const plus = (iso: string, days: number): string =>
  new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days)).toISOString().slice(0, 10);

const grid = (page: Page): Locator => page.getByTestId("calendar-grid");
const day = (page: Page, iso: string): Locator => grid(page).locator(`[data-testid="calendar-day"][data-date="${iso}"]`);
const entry = (page: Page, title: string): Locator => grid(page).getByTestId("calendar-entry").filter({ hasText: title });

test("draws the tasks on their days; Move… and a drag each move one, and a repeat's next copy shows faint", async ({ page }) => {
  const week = `/calendar?view=week&project=${ws.projectKey}`;
  await page.goto(week);
  await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();
  await expect(day(page, ws.today).getByTestId("calendar-entry").filter({ hasText: ws.first.title })).toBeVisible({ timeout: 20_000 });

  // "Move…" — the keyboard and touch twin: to tomorrow. Focus comes back to
  // the moved task's own "Move…" button (the code review's M2).
  const tomorrow = plus(ws.today, 1);
  await entry(page, ws.first.title).getByTestId("calendar-move").click();
  await page.getByTestId(`calendar-move-choice-${tomorrow}`).click();
  await expect(page.locator('[role="status"]', { hasText: `Moved ${ws.projectKey}-${ws.first.number}` })).toHaveCount(1, {
    timeout: 20_000,
  });
  // Tomorrow may be in NEXT week (on a Sunday — the code review's M1): look at its week.
  if ((await day(page, tomorrow).count()) > 0) {
    await expect(entry(page, ws.first.title).getByTestId("calendar-move")).toBeFocused();
  }
  await page.goto(`/calendar?view=week&date=${tomorrow}&project=${ws.projectKey}`);
  await expect(day(page, tomorrow).getByTestId("calendar-entry").filter({ hasText: ws.first.title })).toBeVisible({ timeout: 20_000 });

  // A MOUSE DRAG, from the task's TITLE (the code review's HIGH: a link drags
  // itself unless told not to), onto ANOTHER day of its week — never its own,
  // or the assertion would pass whatever the drag did.
  const second = plus(ws.today, 2);
  await page.goto(`/calendar?view=week&date=${second}&project=${ws.projectKey}`);
  const days = await grid(page).getByTestId("calendar-day").evaluateAll((els) => els.map((e) => e.getAttribute("data-date")!));
  const target = days.find((d) => d !== second)!;
  await entry(page, ws.second.title).getByRole("link").dragTo(day(page, target));
  await expect(day(page, target).getByTestId("calendar-entry").filter({ hasText: ws.second.title })).toBeVisible({ timeout: 20_000 });
  await expect(day(page, second).getByTestId("calendar-entry").filter({ hasText: ws.second.title })).toHaveCount(0);
  await page.reload();
  await expect(day(page, target).getByTestId("calendar-entry").filter({ hasText: ws.second.title })).toBeVisible({ timeout: 20_000 });

  // The weekly task's next copy — it appears tomorrow and is due six days later —
  // drawn faint on that day in the month view, linking to the task.
  await page.goto(`/calendar?date=${ws.weekly.copyDue}&project=${ws.projectKey}`);
  const copy = day(page, ws.weekly.copyDue).getByTestId("calendar-copy");
  await expect(copy).toHaveCount(1, { timeout: 20_000 });
  await expect(copy.getByRole("link")).toHaveAttribute("href", `/projects/${ws.projectKey}/items/${ws.weekly.number}`);
  await expect(copy).toContainText(`next copy of ${ws.projectKey}-${ws.weekly.number}`);
});

test("the project filter and Only mine narrow the page", async ({ page }) => {
  await page.goto(`/calendar?view=week&date=${plus(ws.today, 1)}`);
  // Nothing in this run's project is assigned to anyone: Only mine empties it.
  await expect(grid(page).getByTestId("calendar-entry").filter({ hasText: ws.first.title })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("calendar-mine").click();
  await expect(page).toHaveURL(/mine=1/);
  await expect(grid(page).getByTestId("calendar-entry").filter({ hasText: ws.first.title })).toHaveCount(0);
  await page.getByTestId("calendar-mine").click();
  await expect(page).not.toHaveURL(/mine=1/);
  // The filter (drawn: the fixture made a second project) writes ?project=
  // and keeps the period; choosing the empty other project empties the week.
  const select = page.getByTestId("calendar-project-filter").getByRole("combobox");
  await select.selectOption(ws.projectKey);
  await expect(page).toHaveURL(new RegExp(`project=${ws.projectKey}`));
  await expect(page).toHaveURL(/view=week/);
  await expect(grid(page).getByTestId("calendar-entry").filter({ hasText: ws.first.title })).toBeVisible({ timeout: 20_000 });
  const other = ws.projectKey.replace(/^CA/, "CB");
  await select.selectOption(other);
  await expect(page).toHaveURL(new RegExp(`project=${other}`));
  await expect(grid(page).getByTestId("calendar-entry").filter({ hasText: ws.first.title })).toHaveCount(0, { timeout: 20_000 });
});
