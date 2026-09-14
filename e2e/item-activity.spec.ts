import { expect, test, type Locator } from "@playwright/test";

import { SLOW, createOwnTask, deleteOwnTasks, picker, pressUntil } from "./fixtures/keys";
import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * THE ACTIVITY SECTION IN A REAL BROWSER (UI.md §5.4, slice 8).
 *
 * The service's paging and name resolution are `work.dbtest.ts`'s;
 * what only a browser can see is the round trip: a pick through the
 * rail's picker lands as a NEW row at the top of the section on the
 * refresh the commit itself causes, worded for a person, with the
 * member's own name on it and the row's chip — and the same two rows
 * are there after a reload and on the full page, which is where the
 * older pages would live.
 *
 * The task is the test's own (the visual sweep photographs the seeded
 * ones) and is removed in `afterEach`, pass or fail.
 */

let seed!: E2ESeed;
let created: string[] = [];

test.beforeAll(() => {
  seed = requireSeed();
});

test.afterEach(async ({ page }) => {
  const titles = created;
  created = [];
  await deleteOwnTasks(page, seed, titles);
});

const rows = (scope: Locator): Locator => scope.getByTestId("item-activity").getByTestId("item-activity-row");

test("a new task's history is its creation; a pick adds a row at the top; both survive a reload and the full page", async ({
  page,
}) => {
  await createOwnTask(page, seed, "Activity", created);
  const peek = page.getByTestId("item-peek");

  await expect(rows(peek)).toHaveCount(1);
  const first = rows(peek).first();
  await expect(first).toHaveAttribute("data-field", "created");
  await expect(first).toContainText("E2E Owner");
  await expect(first).toContainText("created this task");
  // A history row is a class-B row: it wears its own chip (§10.4).
  await expect(first.locator('[data-slot="visibility-badge"]')).toHaveAttribute("data-visibility", "INTERNAL");
  // Relative on the face, absolute in the attribute (§8).
  await expect(first.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
  await expect(first.locator("time")).toContainText(/ago|now/);

  // A pick through `P`: the section's new row arrives with the refresh
  // the commit causes, after the live region has spoken.
  await pressUntil(page, "p", picker(page));
  await picker(page).getByTestId("item-priority-HIGH").click();
  await expect(picker(page)).toHaveCount(0);
  await expect(
    peek.getByTestId("item-properties").locator('[role="status"]', { hasText: "Priority changed to High" }),
  ).toHaveCount(1, { timeout: 20_000 * SLOW });
  await expect(rows(peek)).toHaveCount(2, { timeout: 20_000 * SLOW });
  await expect(rows(peek).first()).toHaveAttribute("data-field", "priority");
  await expect(rows(peek).first()).toContainText("E2E Owner");
  await expect(rows(peek).first()).toContainText("changed the priority from No priority to High");
  await expect(rows(peek).last()).toHaveAttribute("data-field", "created");
  // Two rows is one page: no older page to offer.
  await expect(peek.getByTestId("item-activity").getByRole("link", { name: "Older activity" })).toHaveCount(0);

  // A cold reload of backlog + peek + documents + preferences: the same
  // budget item-properties.spec.ts gives the same page shape.
  await page.reload();
  await expect(rows(page.getByTestId("item-peek"))).toHaveCount(2, { timeout: 20_000 * SLOW });

  await page.getByTestId("item-full-page").click();
  await expect(page.getByTestId("item-peek")).toHaveCount(0);
  await expect(page.getByTestId("item-properties")).toBeVisible();
  const body = page.locator("body");
  await expect(rows(body)).toHaveCount(2, { timeout: 20_000 * SLOW });
  await expect(rows(body).first()).toContainText("changed the priority from No priority to High");
  await expect(body.getByTestId("item-activity").getByRole("link", { name: "Older activity" })).toHaveCount(0);
});
