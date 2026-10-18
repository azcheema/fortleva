import { expect, test, type Page } from "@playwright/test";

import { SLOW } from "./fixtures/keys";
import { moveWorkspace, requireSeed, type E2ESeed, type MoveWorkspace } from "./fixtures/tenant";

/**
 * MOVE A TASK TO ANOTHER PROJECT OF ITS CLIENT, through a real member session
 * (slice 131; founder decision C108).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT: "Move…" in the task panel opens a
 * dialog that offers the client's other project (chosen by itself when it is
 * the only one) and says what moves with the task; Move takes the task to
 * its new project and opens it there under its new key, its history saying
 * where it came from; and the old key — the item page and the backlog's
 * `?item=` every task e-mail carries — still leads to it. What moves, the
 * refusals and the database's rules are `move.dbtest.ts`'s.
 *
 * IN THE SECOND WORKSPACE, with a client of its own per run
 * (`move-workspace`), never the shared one. The workspace pointer is the
 * SESSION's, so the test switches there and the afterEach switches back.
 */

let seed!: E2ESeed;
let ws!: MoveWorkspace;
const WAIT = { timeout: 20_000 * SLOW };

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  seed = requireSeed();
  ws = await moveWorkspace(seed.secondTenantId);
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

test("Move… takes a task to the client's other project; its old key still leads to it", async ({ page }) => {
  const oldKey = `${ws.fromKey}-${ws.number}`;
  await page.goto(`/projects/${ws.fromKey}/items/${ws.number}`);
  await expect(page.getByRole("heading", { name: ws.title })).toBeVisible(WAIT);

  await page.getByTestId("item-move").click();
  const dialog = page.getByTestId("move-task");
  await expect(dialog).toBeVisible();
  // The client's one other project, chosen by itself; what moves, said.
  await expect(dialog.getByTestId("move-task-project")).toHaveValue(/.+/, WAIT);
  await expect(dialog.getByTestId("move-task-facts")).toContainText("1 task under it moves too.", WAIT);
  await expect(dialog.getByTestId("move-task-facts")).toContainText(`Links to ${oldKey} keep working.`);
  await dialog.getByTestId("move-task-submit").click();
  // Said at once — before the page it opens has loaded (a toast lasts seconds).
  await expect(page.locator("[data-sonner-toast]", { hasText: new RegExp(`^Moved to ${ws.toKey}-\\d+`) }).first()).toBeVisible(WAIT);

  // It opens where it is now — its own page in the other project.
  await page.waitForURL(new RegExp(`/projects/${ws.toKey}/items/\\d+$`), WAIT);
  const newNumber = Number(new URL(page.url()).pathname.split("/").pop());
  await expect(page.getByRole("heading", { name: ws.title })).toBeVisible(WAIT);
  await expect(page.getByTestId("item-activity")).toContainText(`moved this here from ${oldKey}`, WAIT);

  // The old key, by the item page…
  await page.goto(`/projects/${ws.fromKey}/items/${ws.number}`);
  await page.waitForURL(new RegExp(`/projects/${ws.toKey}/items/${newNumber}$`), WAIT);
  // …and by the backlog's peek, the address a task e-mail carries.
  await page.goto(`/projects/${ws.fromKey}/backlog?item=${oldKey}`);
  await page.waitForURL(new RegExp(`/projects/${ws.toKey}/backlog\\?item=${ws.toKey}-${newNumber}$`), WAIT);
  await expect(page.getByTestId("item-peek")).toContainText(ws.title, WAIT);
});
