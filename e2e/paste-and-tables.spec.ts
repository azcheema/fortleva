import { expect, test, type Locator, type Page } from "@playwright/test";

import { SLOW, createOwnTask, deleteOwnTasks } from "./fixtures/keys";
import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * PASTED FORMATTING AND SIMPLE TABLES, in a browser (slice 132; founder
 * decision C109).
 *
 * WHAT THIS PROVES THAT THE UNIT TESTS CANNOT: the editor really calls the
 * paste hooks — a ChatGPT/Claude-style answer pasted as PLAIN TEXT becomes a
 * heading, bold, a list and a table, and a Word list pasted as Word's HTML
 * becomes a list; the Table menu inserts a table, Tab moves between cells,
 * the menu adds a column; and each of these SAVES (the server's normaliser
 * keeps the table) and is there after a reload. A table pasted into a
 * progress update shows in its live preview — the component the portal and
 * the PDF's text both come from. What is read as markdown, the Word markers,
 * the table bounds and the normaliser's rules are the unit tests'.
 *
 * The paste is a dispatched `ClipboardEvent` carrying a `DataTransfer`: the
 * same event ProseMirror handles from Ctrl+V, without the OS clipboard.
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

async function paste(target: Locator, data: Record<string, string>) {
  await target.evaluate((el, items) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(items)) transfer.setData(type, value);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, data);
}

/** A task of this run's own, opened on its full page; the description editor and a waiter for its save. */
async function ownTaskPage(page: Page, prefix: string) {
  await createOwnTask(page, seed, prefix, created);
  await page.getByTestId("item-full-page").click();
  await page.waitForURL(new RegExp(`/projects/${seed.projectKey}/items/\\d+$`), WAIT);
  const itemUrl = page.url();
  const editor = page.getByTestId("description-editor");
  await expect(editor).toBeVisible(WAIT);
  const saveLands = () =>
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().startsWith(itemUrl), WAIT);
  return { editor, saveLands, itemUrl };
}

const ANSWER = [
  "## Launch plan",
  "",
  "We go live **on Friday**.",
  "",
  "- Point the domain",
  "- Turn on the cache",
  "",
  "| Page | Owner |",
  "|------|-------|",
  "| Home | Anna |",
  "| Shop | Ben |",
].join("\n");

test("a markdown answer pasted as plain text becomes formatting — and the table saves", async ({ page }) => {
  const { editor, saveLands } = await ownTaskPage(page, "Paste markdown");
  await editor.click();
  await paste(editor, { "text/plain": ANSWER });

  await expect(editor.locator("h2")).toHaveText("Launch plan");
  await expect(editor.locator("strong")).toHaveText("on Friday");
  await expect(editor.locator("ul > li")).toHaveCount(2);
  await expect(editor.locator("table th")).toHaveText(["Page", "Owner"]);
  await expect(editor.locator("table td")).toHaveText(["Home", "Anna", "Shop", "Ben"]);
  // Nothing is left of the markdown's own marks.
  await expect(editor).not.toContainText("**");
  await expect(editor).not.toContainText("|");

  const landed = saveLands();
  await editor.blur();
  await landed;
  // A refusal is a toast, never a silent revert.
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

  await page.reload();
  await expect(editor.locator("table td")).toHaveText(["Home", "Anna", "Shop", "Ben"], WAIT);
  await expect(editor.locator("h2")).toHaveText("Launch plan");
});

test("Word's lists pasted as Word's HTML become real lists — nested, lettered, the markers gone", async ({ page }) => {
  const { editor } = await ownTaskPage(page, "Paste Word");
  await editor.click();
  // Word's clipboard as Word writes it: list items are paragraphs styled
  // `mso-list:lN levelM`, the marker Word drew in a `mso-list:Ignore` span
  // inside its conditional comments.
  const item = (list: string, level: number, marker: string, text: string, font = "Symbol") =>
    `<p class=MsoListParagraphCxSpMiddle style='margin-left:${level * 36}pt;text-indent:-18.0pt;mso-list:${list} level${level} lfo1'>` +
    `<![if !supportLists]><span style='font-family:${font}'><span style='mso-list:Ignore'>${marker}` +
    `<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>${text}<o:p></o:p></p>`;
  const html =
    `<html xmlns:w="urn:schemas-microsoft-com:office:word"><body><!--StartFragment-->` +
    item("l0", 1, "·", "Order the photos") +
    item("l0", 2, "o", "From the shoot", "Courier New") +
    item("l0", 1, "·", "Write the texts") +
    `<p class=MsoNormal>Steps:</p>` +
    item("l1", 1, "1.", "Prepare", "Calibri") +
    item("l1", 2, "a.", "Back up", "Calibri") +
    item("l1", 2, "b.", "Check the DNS", "Calibri") +
    item("l1", 2, "c.", "Tell the client", "Calibri") +
    item("l1", 1, "2.", "Launch", "Calibri") +
    `<p class=MsoNormal>§&nbsp;3 Betalning</p><!--EndFragment--></body></html>`;
  await paste(editor, { "text/html": html, "text/plain": "Order the photos\nFrom the shoot\nWrite the texts" });

  const bullets = editor.locator(":scope > ul > li");
  await expect(bullets).toHaveCount(2);
  await expect(bullets.first().locator(":scope > p")).toHaveText("Order the photos");
  await expect(bullets.first().locator("ul > li")).toHaveText("From the shoot");
  await expect(bullets.nth(1)).toHaveText("Write the texts");

  const steps = editor.locator(":scope > ol > li");
  await expect(steps).toHaveCount(2);
  // "c." is the lettered list's third item — never a roman 100 a level deeper.
  const lettered = steps.first().locator(":scope > ol");
  await expect(lettered).toHaveAttribute("type", "a");
  await expect(lettered.locator(":scope > li")).toHaveText(["Back up", "Check the DNS", "Tell the client"]);
  await expect(steps.nth(1)).toHaveText("Launch");

  // Word's markers are gone; a "§" in an ordinary paragraph is text, kept.
  await expect(editor).not.toContainText("·");
  await expect(editor.locator(":scope > p", { hasText: "Betalning" })).toContainText("§");
});

test("the Table menu inserts a table, Tab moves between cells, and a column added stays", async ({ page }) => {
  const { editor, itemUrl } = await ownTaskPage(page, "Table menu");
  // Opening the menu takes focus off the editor, which SAVES — so "a save
  // landed" is not enough here: wait for the save that holds four header
  // cells (the first run's waiter caught the "Prices:" save still in flight,
  // and the reload beat the save behind it).
  const fourColumnsSaved = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().startsWith(itemUrl) &&
      (r.request().postData() ?? "").split('"tableHeader"').length - 1 === 4,
    // Armed before the steps below, so its clock covers them too.
    { timeout: 45_000 * SLOW },
  );
  await editor.click();
  await page.keyboard.type("Prices:");

  const menu = page.getByTestId("description-table-menu");
  await menu.click();
  await page.getByTestId("description-table-menu-insert").click();
  await expect(editor.locator("table tr")).toHaveCount(3, WAIT);
  await expect(editor.locator("table th")).toHaveCount(3);

  // The caret is in the first header cell; Tab walks the row.
  await page.keyboard.type("Item");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Price");
  await expect(editor.locator("table th")).toHaveText(["Item", "Price", ""]);

  // Inside a table the menu offers rows and columns — never a table in a table.
  await menu.click();
  await expect(page.getByTestId("description-table-menu-insert")).toHaveCount(0);
  await page.getByTestId("description-table-menu-addColumnRight").click();
  await expect(editor.locator("table th")).toHaveCount(4, WAIT);

  await editor.blur();
  await fourColumnsSaved;
  await expect(page.getByTestId("description").getByText("Saved", { exact: true })).toBeVisible(WAIT);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

  await page.reload();
  await expect(editor.locator("table th")).toHaveCount(4, WAIT);
  await expect(editor.locator("table th").first()).toHaveText("Item");

  // The last row cannot be deleted: down to the header row, and the item is
  // disabled. Each action is waited for before the menu opens again (an
  // action runs once the menu's close has finished).
  await editor.locator("table td").last().click();
  for (const rows of [2, 1]) {
    await menu.click();
    await page.getByTestId("description-table-menu-deleteRow").click();
    await expect(editor.locator("table tr")).toHaveCount(rows, WAIT);
  }
  await menu.click();
  await expect(page.getByTestId("description-table-menu-deleteRow")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("description-table-menu-deleteColumn")).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
});

test("a table pasted into a progress update shows in its preview — what the client reads", async ({ page }) => {
  await page.goto(`/projects/${seed.projectKey}/updates`);
  await page.getByTestId("new-update").click();
  await expect(page.getByTestId("update-composer")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("update-section-SUMMARY-table-menu")).toBeVisible();

  const editor = page.getByTestId("update-section-SUMMARY");
  await editor.click();
  await paste(editor, { "text/plain": "| Page | Status |\n|---|---|\n| Home | Live |" });
  await expect(editor.locator("table td")).toHaveText(["Home", "Live"]);

  const preview = page.getByTestId("update-preview");
  await expect(preview.locator(".table-scroll table th")).toHaveText(["Page", "Status"], WAIT);
  await expect(preview.locator(".table-scroll table td")).toHaveText(["Home", "Live"]);
});
