import { expect, test, type Locator, type Page } from "@playwright/test";

import { importWorkspace, requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * IMPORTS, through a real member session (Phase 6 slice 121; founder
 * decision C97).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT: the file is read IN THE BROWSER —
 * a Swedish Excel CSV (semicolons, Swedish headers, a quoted multi-line
 * cell) and a Trello board export — the columns, statuses and people are
 * matched on the page, the check says what will happen, the batches run, and
 * the tasks are then on the backlog; importing the same file again changes
 * nothing; Undo takes the tasks off the backlog and Bring back returns them.
 *
 * IN THE SECOND WORKSPACE (`import-workspace` makes a fresh project there
 * per run), never the shared one: its backlog, project list and health table
 * are other specs' counts and the visual walk's photographs. The workspace
 * pointer is the SESSION's (`account.spec.ts`), so every test switches there
 * and the afterEach switches back — a hook still runs after a timeout.
 */

let seed!: E2ESeed;
let project!: { projectKey: string; projectName: string };

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  seed = requireSeed();
  project = await importWorkspace(seed.secondTenantId);
});

const toast = (page: Page, text: string | RegExp): Locator => page.locator("[data-sonner-toast]", { hasText: text });

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

const CSV = [
  "ID;Namn;Status;Förfallodatum;Etiketter;Beskrivning",
  'T1;Ny startsida;Pågår;15.11.2026;Design;"- [ ] Skiss\n- [x] Färger"',
  "T2;Kontaktformulär;Att göra;;;",
  "",
].join("\r\n");

/**
 * The field's change handler is React's, attached at HYDRATION: a file set
 * after a full `goto` but before it is simply lost (CI run 38712393591 —
 * the field showed nothing chosen and the check never came). Set it until
 * the field names it, as `pressUntil` does for a key.
 */
async function chooseFile(page: Page, name: string, mimeType: string, body: string) {
  const field = page.locator('[data-slot="file-drop"]');
  await expect(async () => {
    await page.locator("#import-file").setInputFiles({ name, mimeType, buffer: Buffer.from(body, "utf8") });
    await expect(field).toContainText(name, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** A row's menu, opened until its item shows — the trigger is Radix's, live only after hydration. */
async function openMenu(page: Page, row: Locator, trigger: string, item: string) {
  await expect(async () => {
    if (!(await page.getByRole("menuitem", { name: item }).isVisible())) {
      await row.getByRole("button", { name: trigger }).click({ timeout: 2_000 });
    }
    await expect(page.getByRole("menuitem", { name: item })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test("a Swedish spreadsheet imports, and importing it again changes nothing", async ({ page }) => {
  await page.goto(`/projects/${project.projectKey}/backlog`);
  // The empty backlog offers the import beside "New task".
  await page.getByTestId("backlog-empty-import").click();
  await page.waitForURL(`**/projects/${project.projectKey}/import`);

  await chooseFile(page, "uppgifter.csv", "text/csv", CSV);
  // The columns were matched from the Swedish headers.
  const columns = page.getByTestId("import-columns");
  await expect(columns.locator('select[data-field="name"]')).toHaveValue("1");
  await expect(columns.locator('select[data-field="status"]')).toHaveValue("2");
  await expect(columns.locator('select[data-field="id"]')).toHaveValue("0");
  // Two statuses, each mapped to a state.
  await expect(page.getByTestId("import-statuses").locator("li")).toHaveCount(2);

  const check = page.getByTestId("import-check");
  await expect(check.getByTestId("import-check-create")).toHaveText("2 new tasks");
  await expect(check.getByTestId("import-preview-row")).toHaveCount(2);
  await page.getByTestId("import-submit").click();
  await expect(page.getByTestId("import-result-summary")).toHaveText("New: 2 · Updated: 0 · Kept: 0 · Unchanged: 0");

  await page.goto(`/projects/${project.projectKey}/backlog`);
  await expect(page.getByText("Ny startsida", { exact: true })).toBeVisible();
  await expect(page.getByText("Kontaktformulär", { exact: true })).toBeVisible();

  // The same file again: both tasks are found by their ids and nothing changes.
  await page.goto(`/projects/${project.projectKey}/import`);
  await chooseFile(page, "uppgifter.csv", "text/csv", CSV);
  await expect(page.getByTestId("import-check-update")).toHaveText("2 tasks imported before are updated where the file has changed");
  await page.getByTestId("import-submit").click();
  await expect(page.getByTestId("import-result-summary")).toHaveText("New: 0 · Updated: 0 · Kept: 0 · Unchanged: 2");
  await expect(page.locator('[data-testid="import-history-row"]')).toHaveCount(2);
});

test("a Trello board imports its lists, checklists and the link to the card", async ({ page }) => {
  const board = {
    id: "board",
    name: "Website",
    lists: [{ id: "L1", name: "Doing", closed: false, pos: 1 }],
    labels: [],
    members: [],
    checklists: [
      { id: "C1", idCard: "card1", name: "Launch", pos: 1, checkItems: [{ name: "Check the forms", state: "complete", pos: 1 }] },
    ],
    cards: [
      { id: "card1", name: "Trello card task", desc: "From the board", idList: "L1", pos: 1, closed: false, shortUrl: "https://trello.com/c/e2eCard" },
      { id: "card2", name: "Archived card", idList: "L1", pos: 2, closed: true },
    ],
  };
  await page.goto(`/projects/${project.projectKey}/import`);
  await chooseFile(page, "board.json", "application/json", JSON.stringify(board));
  await expect(page.getByTestId("import-statuses").locator("li")).toHaveCount(1);
  await expect(page.getByTestId("import-check-create")).toHaveText("1 new task");
  await expect(page.getByTestId("import-check")).toContainText("1 archived Trello card is left out");
  await page.getByTestId("import-submit").click();
  await expect(page.getByTestId("import-result-summary")).toHaveText("New: 1 · Updated: 0 · Kept: 0 · Unchanged: 0");

  // The task's own page carries the checklist and the closing link. It is
  // this project's THIRD task: the spreadsheet made the first two.
  await page.goto(`/projects/${project.projectKey}/items/3`);
  await expect(page.getByText("Trello card task").first()).toBeVisible();
  // Exact: the checkbox's screen-reader label repeats the item's words.
  await expect(page.getByText("Check the forms", { exact: true })).toBeVisible();
  await expect(page.getByText("Imported from Trello:")).toBeVisible();
  await expect(page.locator('a[href="https://trello.com/c/e2eCard"]')).toHaveCount(1);
});

test("Undo takes an import's tasks off the backlog, and Bring back returns them", async ({ page }) => {
  await page.goto(`/projects/${project.projectKey}/import`);
  // The FIRST import (the oldest row) made the two spreadsheet tasks.
  const first = page.locator('[data-testid="import-history-row"]').last();
  await openMenu(page, first, "Actions for uppgifter.csv", "Undo import");
  await page.getByRole("menuitem", { name: "Undo import" }).click();
  // The danger item asks in place (UI.md §5.9): the row's question, then Yes.
  await expect(first).toContainText("Move this import's tasks to the bin?");
  await first.getByRole("button", { name: "Yes" }).click();
  await expect(toast(page, "2 tasks moved to the bin.")).toBeVisible();
  await expect(first).toHaveAttribute("data-status", "UNDONE");

  await page.goto(`/projects/${project.projectKey}/backlog`);
  await expect(page.getByText("Ny startsida", { exact: true })).toHaveCount(0);

  await page.goto(`/projects/${project.projectKey}/import`);
  const undone = page.locator('[data-testid="import-history-row"][data-status="UNDONE"]');
  await openMenu(page, undone, "Actions for uppgifter.csv", "Bring back the tasks");
  await page.getByRole("menuitem", { name: "Bring back the tasks" }).click();
  await expect(toast(page, "2 tasks brought back.")).toBeVisible();

  await page.goto(`/projects/${project.projectKey}/backlog`);
  await expect(page.getByText("Ny startsida", { exact: true })).toBeVisible();
});
