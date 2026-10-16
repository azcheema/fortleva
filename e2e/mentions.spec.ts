import { expect, test } from "@playwright/test";

import { SLOW, createOwnTask, deleteOwnTasks, picker, rail } from "./fixtures/keys";
import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * @MENTIONS IN A REAL BROWSER (slice 125, founder decision C101).
 *
 * The rules are `mentions.dbtest.ts`'s; what only a browser can show is the
 * composer's list and its keys: `@` in an internal note opens the teammates
 * who can open the task (the seed's employee is assigned to the client),
 * typing narrows it, Escape closes the LIST and not the peek, Enter picks,
 * the chip reads the name, and the posted comment renders "@E2E Employee";
 * Escape in an in-place edit cancels it and leaves the peek open.
 * In "Reply to client" mode `@` is just a character and nothing opens.
 *
 * The task is the test's own and is removed in `afterEach`, pass or fail.
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

test("mention a teammate in an internal note: the list, its keys, the chip and the posted name", async ({ page }) => {
  await createOwnTask(page, seed, "Mention task", created);
  const peek = page.getByTestId("item-peek");
  const composer = peek.getByTestId("comment-composer");
  const editor = composer.getByTestId("comment-editor");
  await expect(editor).toBeVisible({ timeout: 20_000 * SLOW });
  await editor.click();

  // `@` opens the list — the people load on this first `@`.
  await page.keyboard.type("Over to @");
  const list = composer.getByTestId("comment-editor-mentions");
  const employee = list.getByRole("option", { name: "E2E Employee" });
  await expect(employee).toBeVisible({ timeout: 20_000 * SLOW });
  // The author is never offered.
  await expect(list.getByRole("option", { name: "E2E Owner" })).toHaveCount(0);
  await expect(editor).toHaveAttribute("aria-controls", /.+/);

  // Escape closes the LIST only: the peek stays, the text stays.
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(peek).toBeVisible();
  await expect(editor).not.toHaveAttribute("aria-controls", /.+/);

  // A fresh `@`, narrowed by what follows, picked with Enter.
  await page.keyboard.type(" @emp");
  await expect(employee).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(employee).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(editor.locator('span[data-type="mention"]')).toHaveText("@E2E Employee");
  await page.keyboard.type("please check");
  await page.keyboard.press("ControlOrMeta+Enter");

  const row = peek.getByTestId("item-comment");
  await expect(row).toHaveCount(1, { timeout: 20_000 * SLOW });
  const body = row.getByTestId("item-comment-body");
  await expect(body.locator('span[data-type="mention"]')).toHaveText("@E2E Employee");
  await expect(body).toContainText("@E2E Employee please check");

  // Editing it in place, Escape CANCELS the edit and leaves the peek open
  // (inside the peek ProseMirror never saw Escape before slice 125 — the
  // editor now takes it at the window's capture phase).
  await row.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const edit = row.getByTestId("comment-edit-editor");
  await expect(edit).toBeVisible({ timeout: 20_000 * SLOW });
  await edit.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" — never saved");
  await page.keyboard.press("Escape");
  await expect(row.getByTestId("comment-edit-editor")).toHaveCount(0);
  await expect(peek).toBeVisible();
  await expect(body).not.toContainText("never saved");
});

test("in Reply to client mode, @ opens nothing — a client never reads a teammate's name", async ({ page }) => {
  await createOwnTask(page, seed, "Mention shared task", created);
  // Share the task, so the composer offers its two modes.
  await rail(page).getByTestId("item-visibility").click();
  await picker(page).getByTestId("item-visibility-CLIENT_VISIBLE").click();
  await expect(rail(page).getByTestId("item-visibility").locator('[data-slot="visibility-badge"]')).toHaveAttribute(
    "data-visibility",
    "CLIENT_VISIBLE",
    { timeout: 20_000 * SLOW },
  );

  const composer = page.getByTestId("item-peek").getByTestId("comment-composer");
  const editor = composer.getByTestId("comment-editor");
  const list = composer.getByTestId("comment-editor-mentions");
  await expect(editor).toBeVisible({ timeout: 20_000 * SLOW });
  // In an internal note the people load and the list opens…
  await editor.click();
  await page.keyboard.type("Thanks @");
  await expect(list.getByRole("option", { name: "E2E Employee" })).toBeVisible({ timeout: 20_000 * SLOW });
  // …switching to "Reply to client" closes it under the open `@`…
  await composer.getByTestId("comment-mode-CLIENT_VISIBLE").click();
  await expect(list).toHaveCount(0);
  // …and with the people already loaded, a fresh `@` there opens nothing.
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and @E2E");
  await expect(editor).toContainText("and @E2E");
  await expect(list).toHaveCount(0);

  // Back to an internal note, the same `@` offers people again.
  await composer.getByTestId("comment-mode-INTERNAL").click();
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" @");
  await expect(list.getByRole("option", { name: "E2E Employee" })).toBeVisible({ timeout: 20_000 * SLOW });
});
