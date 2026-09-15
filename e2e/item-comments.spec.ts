import { expect, test } from "@playwright/test";

import { SLOW, createOwnTask, deleteOwnTasks } from "./fixtures/keys";
import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * THE COMMENTS SECTION IN A REAL BROWSER (UI.md §5.4 / §5.6, slice 10).
 *
 * The service's rules are `comments.dbtest.ts`'s; what only a browser
 * can see is the round trip: words typed into the composer become a
 * comment with the author, the chip and the count on the refresh the
 * post causes (⌘Enter / Ctrl+Enter posts, and the editor clears), the
 * task's history gains a "commented" row, an edit in place replaces
 * the body and marks it edited, and the row's delete behind the §5.9
 * question removes it. On a private task there is no mode toggle — a
 * note follows the task, and the hint says so.
 *
 * The task is the test's own and is removed in `afterEach`, pass or
 * fail; its thread goes with it (the cascade).
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

test("post an internal note from the peek; edit it in place; delete it", async ({ page }) => {
  await createOwnTask(page, seed, "Comments task", created);
  const peek = page.getByTestId("item-peek");
  const section = peek.getByTestId("item-comments");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("item-comment")).toHaveCount(0);

  // A private task: no mode toggle, and the hint names the task.
  const composer = section.getByTestId("comment-composer");
  await expect(composer).toBeVisible();
  await expect(composer.getByTestId("comment-mode-INTERNAL")).toHaveCount(0);
  await expect(composer).toContainText("Follows");

  // Type into the editor (loaded on demand) and post with the key.
  const editor = composer.getByTestId("comment-editor");
  await expect(editor).toBeVisible({ timeout: 20_000 * SLOW });
  const words = `Needs a repro ${Date.now()}`;
  await editor.click();
  await page.keyboard.type(words);
  await expect(composer.getByTestId("comment-editor-submit")).toBeEnabled();
  await page.keyboard.press("ControlOrMeta+Enter");

  const row = section.getByTestId("item-comment");
  await expect(row).toHaveCount(1, { timeout: 20_000 * SLOW });
  await expect(row.getByTestId("item-comment-body")).toContainText(words);
  // A comment is a class-B row: its own chip, INTERNAL under a private task.
  await expect(row.locator('[data-slot="visibility-badge"]')).toHaveAttribute("data-visibility", "INTERNAL");
  // The count lives in the card's header slot, beside the body the section testid wraps.
  await expect(peek.getByTestId("item-comment-count")).toHaveText("1 comment");
  // The editor cleared, and the live region spoke.
  await expect(editor).not.toContainText(words);
  await expect(composer.locator('[role="status"]')).toContainText("Note posted");
  // The task's history says so.
  await expect(peek.getByTestId("item-activity").locator('[data-field="comment"]')).toHaveCount(1, {
    timeout: 20_000 * SLOW,
  });

  // Edit in place: the row's menu, then the editor seeded with the words.
  await row.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const edit = row.getByTestId("comment-edit-editor");
  await expect(edit).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(edit).toContainText(words);
  await edit.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" — fixed in staging");
  await row.getByTestId("comment-edit-editor-submit").click();
  await expect(row.getByTestId("item-comment-body")).toContainText("fixed in staging", { timeout: 20_000 * SLOW });
  await expect(row).toContainText("(edited)");
  await expect(row.getByTestId("comment-edit-editor")).toHaveCount(0);

  // Delete behind the in-place question.
  await row.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await row.getByRole("button", { name: "Yes" }).click();
  await expect(section.getByTestId("item-comment")).toHaveCount(0, { timeout: 20_000 * SLOW });
  await expect(section).toContainText("No comments yet");
});
