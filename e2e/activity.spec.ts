import { expect, test } from "@playwright/test";

import { SLOW, createOwnTask, deleteOwnTasks } from "./fixtures/keys";
import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * THE ACTIVITY PAGE in a browser (slice 133; founder decision C110).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT: the page is in the menu, a task
 * just added stands under "Today" as "You added KEY-N Title" — the reader as
 * "You", the task by key and title — the project filter narrows the page
 * through its URL, and the task's link opens it beside its project's backlog.
 * Which events appear, for whom, and the window are `activity-feed.dbtest.ts`'s.
 */

let seed!: E2ESeed;
let created: string[] = [];
const WAIT = { timeout: 20_000 * SLOW };

test.beforeAll(() => {
  seed = requireSeed();
});

test.afterEach(async ({ page }) => {
  const titles = created;
  created = [];
  await deleteOwnTasks(page, seed, titles);
});

test("a task added stands under Today as yours, the project filter narrows to it, and its link opens it", async ({ page }) => {
  const own = await createOwnTask(page, seed, "Activity task", created);

  await page.goto("/home");
  await page.getByRole("link", { name: "Activity", exact: true }).first().click();
  await page.waitForURL(/\/activity$/, WAIT);

  const firstDay = page.getByTestId("activity-day").first();
  await expect(firstDay.locator("h2")).toHaveText("Today", WAIT);
  const event = page.locator('[data-testid="activity-event"][data-kind="task_added"]', { hasText: own.title });
  await expect(event).toBeVisible(WAIT);
  await expect(event).toContainText(`You added ${seed.projectKey}-${own.number} ${own.title}`);

  await page.getByTestId("activity-project-filter").selectOption(seed.projectKey);
  await page.waitForURL(new RegExp(`/activity\\?project=${seed.projectKey}$`), WAIT);
  await expect(event).toBeVisible(WAIT);

  await event.getByRole("link", { name: `${seed.projectKey}-${own.number} ${own.title}` }).click();
  await page.waitForURL(new RegExp(`/projects/${seed.projectKey}/backlog\\?item=${seed.projectKey}-${own.number}$`), WAIT);
  await expect(page.getByTestId("item-peek")).toBeVisible(WAIT);
});
