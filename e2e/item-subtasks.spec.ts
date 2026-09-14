import { expect, test } from "@playwright/test";

import { SLOW, createOwnTask, deleteOwnTasks } from "./fixtures/keys";
import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * THE SUBTASKS SECTION IN A REAL BROWSER (UI.md §5.4, slice 9).
 *
 * The service's rows and counts are `work.dbtest.ts`'s; what only a
 * browser can see is the round trip and the navigation: a title typed
 * into the section's add row becomes a row with its own key and chip on
 * the refresh the create causes, the field stays open for the next one
 * and its Escape closes the FIELD rather than the peek (the one place a
 * hand-written Escape is let through Radix's layer), the meter counts
 * it, opening the subtask stays a peek over the same list and its "Part
 * of" leads back — and the full page shows the same rows, linking to
 * the child's page.
 *
 * Both tasks are the test's own and are removed in `afterEach`, pass or
 * fail — the child first, because the service refuses to delete a
 * parent with a live child.
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

test("add a subtask from the peek; it lands as a row; opening it stays in the peek and leads back; the full page agrees", async ({
  page,
}) => {
  const parent = await createOwnTask(page, seed, "Subtasks parent", created);
  const peek = page.getByTestId("item-peek");
  const section = peek.getByTestId("item-subtasks");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("item-subtask-row")).toHaveCount(0);

  // The empty state's one verb is the add row itself.
  await section.getByTestId("item-subtask-add").click();
  const childTitle = `Subtask child ${Date.now()}`;
  // FIRST in the cleanup order: `deleteItem` refuses a parent with live
  // children (HAS_CHILDREN), so the child goes before the parent.
  created.unshift(childTitle);
  const input = section.getByTestId("item-subtask-input");
  await expect(input).toBeFocused();
  await input.fill(childTitle);
  await input.press("Enter");

  const row = section.getByTestId("item-subtask-row");
  await expect(row).toHaveCount(1, { timeout: 20_000 * SLOW });
  await expect(row).toContainText(childTitle);
  await expect(row).toContainText(new RegExp(`${seed.projectKey}-\\d+`));
  // A child is a class-B row: its own chip, defaulted from the parent.
  await expect(row.locator('[data-slot="visibility-badge"]')).toHaveAttribute("data-visibility", "INTERNAL");
  await expect(row.getByTestId("item-subtask-state")).toHaveText("To do");
  // The pending row is gone once the server's row is there, and the live
  // region spoke the new key.
  await expect(section.getByTestId("item-subtask-pending")).toHaveCount(0);
  await expect(section.locator('[role="status"]')).toContainText(new RegExp(`${seed.projectKey}-\\d+ added`));
  await expect(peek.locator('[data-slot="progress-meter"]')).toContainText("0 of 1");

  // The field stays open for the next title; Escape closes the FIELD,
  // hands focus to the button, and the peek is still open.
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await input.press("Escape");
  await expect(section.getByTestId("item-subtask-add")).toBeFocused();
  await expect(peek).toBeVisible();

  // Opening the subtask is a peek over the same list; a subtask has no
  // Subtasks section; its "Part of" leads back to the parent's peek.
  await row.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${seed.projectKey}/backlog\\?.*item=${seed.projectKey}-\\d+`));
  await expect(page).not.toHaveURL(new RegExp(`item=${parent.key}(&|$)`));
  await expect(peek.getByText(childTitle)).toBeVisible();
  await expect(peek.getByTestId("item-subtasks")).toHaveCount(0);
  const back = peek.getByTestId("item-parent-link");
  await expect(back).toContainText(parent.key);
  await back.click();
  await expect(page).toHaveURL(new RegExp(`[?&]item=${parent.key}(&|$)`));
  await expect(peek.getByTestId("item-subtasks").getByTestId("item-subtask-row")).toHaveCount(1, {
    timeout: 20_000 * SLOW,
  });

  // The full page: the same row, linking to the child's own page.
  await page.getByTestId("item-full-page").click();
  await expect(page.getByTestId("item-peek")).toHaveCount(0);
  const body = page.locator("body");
  const pageRow = body.getByTestId("item-subtasks").getByTestId("item-subtask-row");
  await expect(pageRow).toHaveCount(1, { timeout: 20_000 * SLOW });
  await expect(pageRow.getByRole("link")).toHaveAttribute(
    "href",
    new RegExp(`/projects/${seed.projectKey}/items/\\d+$`),
  );
});
