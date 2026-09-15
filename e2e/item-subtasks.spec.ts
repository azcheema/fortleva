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

test("⌘⇧O: the focused checklist item becomes a subtask, the line goes, and the removal is saved", async ({
  page,
}) => {
  /**
   * The chord is ProseMirror's, not the shell registry's — the registry
   * is inert inside an editable element and answers no chord but ⌘K — so
   * the only instrument that can say whether it arrives at all is a
   * browser. What it must prove beyond arrival is the ORDER the design
   * rests on: the child exists first, and only then does the line leave
   * the document. A run where the row appeared and the line stayed would
   * be a survivable bug; the reverse would not.
   *
   * NOTHING HERE MOVES THE CARET WITH A CLICK, and that is the test's own
   * trap, found the expensive way. A click sets the DOM selection at
   * once, but ProseMirror learns of it from `selectionchange`, which
   * Chromium fires on a later task — so a chord pressed in the same tick
   * reads the selection the caret had BEFORE the click. The refusal is
   * therefore checked on an empty description, where no reading of the
   * selection can convert anything, and the conversion is done where the
   * typing already left the caret. A member is slower than a task; this
   * harness is not.
   */
  const parent = await createOwnTask(page, seed, "Convert parent", created);
  const peek = page.getByTestId("item-peek");
  const editor = peek.getByTestId("description-editor");
  const section = peek.getByTestId("item-subtasks");
  await expect(editor).toBeVisible({ timeout: 20_000 * SLOW });

  const stamp = Date.now();
  const kept = `call the roofer ${stamp}`;
  const converted = `order the tiles ${stamp}`;

  // A caret outside a checklist — here, an empty description: the key
  // ANSWERS rather than falling through to whatever the browser makes of
  // ⌘⇧O, and nothing is created.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(page.locator("[data-sonner-toast]")).toContainText(/checklist item first/i);
  await expect(section.getByTestId("item-subtask-row")).toHaveCount(0);

  // The idle autosave, not a blur: a blur would take the focus the chord
  // needs. Waiting for it means the only writes left in this test are
  // the ones the chord causes.
  const typingSaved = page.waitForResponse((r) => r.request().method() === "POST", {
    timeout: 30_000 * SLOW,
  });
  await page.keyboard.type("Roof work");
  await page.keyboard.press("Enter");
  await page.keyboard.type(`[ ] ${kept}`);
  await page.keyboard.press("Enter");
  await page.keyboard.type(converted);
  await expect(page.getByRole("checkbox", { name: new RegExp(converted) })).toBeVisible();
  await typingSaved;

  // TWO POSTs: the create, then the description this editor flushes the
  // moment the line is gone. Waiting on the pair is what makes the
  // reload below a test of what was STORED rather than of a race.
  let posts = 0;
  const bothLanded = page.waitForResponse((r) => r.request().method() === "POST" && ++posts === 2, {
    timeout: 30_000 * SLOW,
  });
  // FIRST in the cleanup order: `deleteItem` refuses a parent with live
  // children.
  created.unshift(converted);
  // The caret is where the typing left it — in the second checklist item.
  await page.keyboard.press("ControlOrMeta+Shift+O");

  const row = section.getByTestId("item-subtask-row");
  await expect(row).toHaveCount(1, { timeout: 20_000 * SLOW });
  await expect(row).toContainText(converted);
  // The new key is spoken by the DESCRIPTION's own live region — the
  // verb belongs to the editor, not to the section's add row.
  await expect(peek.getByTestId("description-convert-status")).toContainText(
    new RegExp(`${seed.projectKey}-\\d+`),
  );
  // The line left the document as the row arrived; the other one stayed.
  await expect(editor).not.toContainText(converted);
  await expect(editor).toContainText(kept);
  await bothLanded;

  // What was STORED: the checklist is one item shorter, and the subtask
  // is the parent's child on a fresh render of both.
  await page.reload();
  await expect(editor).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(editor).not.toContainText(converted);
  await expect(editor).toContainText(kept);
  await expect(peek.getByTestId("item-properties")).toContainText("0 of 1 done");
  await expect(section.getByTestId("item-subtask-row")).toContainText(converted);
  await expect(peek).toContainText(parent.title);
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
