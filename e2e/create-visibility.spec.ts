import { expect, test, type Browser, type Page } from "@playwright/test";

import { isActionPost } from "./fixtures/actions";
import { SLOW, createOwnTask, deleteOwnTasks, picker, pressUntil, rail } from "./fixtures/keys";
import { CONTACT_STORAGE_STATE, STORAGE_STATE, readItemVisibility, requireSeed } from "./fixtures/tenant";

/**
 * VISIBILITY ON CREATE (Phase 3 slice 73; UI.md rule 10, §5.4; founder
 * decisions (8) of 2026-09-12, C38 and C39 of 2026-09-28), in a real
 * browser, on all four create surfaces.
 *
 * WHAT ONLY A BROWSER CAN SAY HERE:
 *  · **A share at birth reaches the client** — the task created "Client
 *    can see" is on the contact's own portal, behind their own cookie; one
 *    lowered at birth under a shared parent is not, while the parent is.
 *  · **C39 on every field**: after a shared Enter the next task starts
 *    "Private to team" again; ⌘⇧Enter keeps the pick; the subtask row's
 *    "Private to team" is kept across Enters.
 *  · **The select owns no submit key** — a stray letter on it picks
 *    "Client can see" (type-ahead), and Enter there must never publish a
 *    task (the design review's finding): only the title field creates.
 *  · **Choosing another project starts private again** — a kept "Client can
 *    see" does not travel back to a portal-on project — and a portal-off
 *    project asks nothing and stores private. ("Whatever the pick said" is
 *    `rootCreateVisibility`'s, pinned by its unit matrix in model.test.ts.)
 *  · **The board's pending card wears the visibility it SENT**, held
 *    mid-flight — never a false "Private to team" over a share.
 *  · **Escape in the peek closes the FIELD** from the select too, never the
 *    peek with a typed title in it.
 *  · **An Employee** (C38): no "Client can see" on a top-level field — the
 *    "Private to team" chip instead — and yet the lower-only switch on a
 *    subtask under a shared task (decision (8)).
 *
 * EVERY TASK IS THIS FILE'S OWN and is deleted, pass or fail — a child
 * first (`deleteItem` refuses a parent with live children). The employee
 * cannot delete, so its test cleans up in the owner's own jar.
 */

const seed = requireSeed();

let created: string[] = [];
/** Tasks created in the portal-OFF project (`seed.activeProjectKey`). */
let createdOff: string[] = [];

test.afterEach(async ({ page }) => {
  const titles = created;
  const off = createdOff;
  created = [];
  createdOff = [];
  await deleteOwnTasks(page, seed, titles);
  await deleteOwnTasks(page, { ...seed, projectKey: seed.activeProjectKey }, off);
});

const toast = (page: Page, text: string) => page.locator("[data-sonner-toast]", { hasText: text });

/** Whether the client's own portal lists `title`, under the contact plane's jar (sharing.spec.ts' probe). */
async function portalSays(browser: Browser, title: string, present: boolean): Promise<void> {
  const contact = await browser.newContext({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });
  try {
    const page = await contact.newPage();
    await page.goto("/portal");
    await expect(page.getByRole("heading", { name: "Shared with you" })).toBeVisible({ timeout: 30_000 * SLOW });
    if (present) await expect(page.getByText(title)).toBeVisible({ timeout: 30_000 * SLOW });
    else await expect(page.getByText(title)).toHaveCount(0);
  } finally {
    await contact.close();
  }
}

/** Counts the create POSTs that carry `title` — the answer to "did anything get sent?". */
function countCreatesOf(page: Page, title: string): () => number {
  let n = 0;
  page.on("request", (request) => {
    if (isActionPost(request) && (request.postData() ?? "").includes(title)) n += 1;
  });
  return () => n;
}

/** Share the open peek's task from the rail, and wait until the rail says so. */
async function shareFromRail(page: Page): Promise<void> {
  await rail(page).getByTestId("item-visibility").click();
  await picker(page).getByTestId("item-visibility-CLIENT_VISIBLE").click();
  await expect(rail(page).getByTestId("item-visibility").locator('[data-slot="visibility-badge"]')).toHaveAttribute(
    "data-visibility",
    "CLIENT_VISIBLE",
    { timeout: 20_000 * SLOW },
  );
}

test("quick create: \"Client can see\" reaches the portal, the next starts private, ⌘⇧Enter keeps it, a portal-off project sends private, and the select never creates", async ({
  page,
  browser,
}) => {
  const dialog = page.getByTestId("quick-create");
  const title = page.getByTestId("quick-create-title");
  const select = page.getByTestId("quick-create-visibility");
  const stamp = Date.now();
  const first = `QC shared ${stamp}`;
  const second = `QC kept ${stamp}`;
  const third = `QC portal off ${stamp}`;
  created.push(first, second);
  createdOff.push(third);

  await page.goto(`/projects/${seed.projectKey}/backlog`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await pressUntil(page, "c", dialog);
  await expect(title).toBeFocused();
  // Asked, never required: the seed project's portal is on and the owner
  // may share, so the choice is there — at "Private to team".
  await expect(select).toHaveAttribute("data-visibility", "INTERNAL");

  // THE SELECT OWNS NO SUBMIT KEY. A stray `c` on it picks "Client can
  // see" (type-ahead), and an Enter there must not create anything.
  const posts = countCreatesOf(page, first);
  await title.fill(first);
  await select.focus();
  await page.keyboard.press("c");
  await expect(select).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");
  await page.keyboard.press("Enter");
  // Back to the title by pointer (Enter may have opened the native list).
  await title.click();
  expect(posts()).toBe(0);
  await expect(title).toHaveValue(first);
  // The sentence that says who will see it, before Enter.
  await expect(page.getByText("The client will see this task on their portal.")).toBeVisible();

  // Enter in the TITLE creates it shared — and the next starts private (C39).
  await title.press("Enter");
  await expect(toast(page, "the client can see it").first()).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(title).toHaveValue("", { timeout: 20_000 * SLOW });
  await expect(select).toHaveAttribute("data-visibility", "INTERNAL");
  expect(posts()).toBe(1);

  // ⌘⇧Enter keeps the pick for the next one.
  await select.selectOption("CLIENT_VISIBLE");
  await title.fill(second);
  await title.press("Control+Shift+Enter");
  await expect(title).toHaveValue("", { timeout: 20_000 * SLOW });
  await expect(select).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");

  // Another project — the portal-off one: it asks nothing, and the task is
  // stored private.
  await dialog.getByRole("button", { name: /Change project/ }).click();
  await page
    .getByTestId("quick-create-projects")
    .getByRole("option", { name: new RegExp(seed.activeProjectKey) })
    .first()
    .click();
  await expect(title).toBeFocused();
  await expect(select).toHaveCount(0);
  await expect(page.getByTestId("quick-create-visibility-fixed")).toHaveCount(0);
  await title.fill(third);
  await title.press("Enter");
  await expect(title).toHaveValue("", { timeout: 20_000 * SLOW });
  // …and back to the portal-ON project: the "Client can see" kept by
  // ⌘⇧Enter above did not travel — it starts private again.
  await dialog.getByRole("button", { name: /Change project/ }).click();
  await page
    .getByTestId("quick-create-projects")
    .getByRole("option", { name: new RegExp(seed.projectKey) })
    .first()
    .click();
  await expect(title).toBeFocused();
  await expect(select).toHaveAttribute("data-visibility", "INTERNAL");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await portalSays(browser, first, true);
  await portalSays(browser, second, true);
  await page.goto(`/projects/${seed.activeProjectKey}/backlog`);
  const offRow = page.locator('[data-slot="table-row"]', { hasText: third });
  await expect(offRow).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(offRow.locator('[data-slot="visibility-badge"]')).toHaveAttribute("data-visibility", "INTERNAL");
});

test("the backlog's create row: a shared create lands shared, the next starts private, and Escape from the select returns to rest", async ({
  page,
}) => {
  const stamp = Date.now();
  const shared = `Row shared ${stamp}`;
  const next = `Row next ${stamp}`;
  created.push(shared, next);
  await page.goto(`/projects/${seed.projectKey}/backlog`);
  await page.locator("#new-task").getByRole("button").click();
  const input = page.locator("#new-task input");
  const select = page.getByTestId("backlog-create-visibility");
  await expect(input).toBeFocused();
  // Still ONE input in the row — the select is not one, and every spec's
  // `createOwnTask` addresses the field this way.
  await expect(page.locator("#new-task input")).toHaveCount(1);
  await expect(select).toHaveAttribute("data-visibility", "INTERNAL");

  await select.selectOption("CLIENT_VISIBLE");
  await input.fill(shared);
  await input.press("Enter");
  const sharedRow = page.locator('[data-slot="table-row"]', { hasText: shared });
  await expect(sharedRow).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(sharedRow.locator('[data-slot="visibility-badge"]')).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");
  await expect(select).toHaveAttribute("data-visibility", "INTERNAL");

  // The next one, with nothing touched: STORED private (C39).
  await input.fill(next);
  await input.press("Enter");
  const nextRow = page.locator('[data-slot="table-row"]', { hasText: next });
  await expect(nextRow).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(nextRow.locator('[data-slot="visibility-badge"]')).toHaveAttribute("data-visibility", "INTERNAL");

  // Escape from the select closes the field and hands focus back.
  await select.focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#new-task input")).toHaveCount(0);
  await expect(page.locator("#new-task").getByRole("button")).toBeFocused();
});

test("the board column: the PENDING card wears the visibility it sent, the task lands shared, and the next starts private", async ({
  page,
}) => {
  const shared = `Board shared ${Date.now()}`;
  created.push(shared);
  // The create POST is HELD until the pending card has been read (a gate,
  // never an `unroute`).
  let gate: (() => void) | null = null;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (isActionPost(request) && (request.postData() ?? "").includes(shared)) {
      await new Promise<void>((release) => {
        gate = release;
      });
    }
    await route.continue();
  });

  await page.goto(`/projects/${seed.projectKey}/board`);
  await expect(page.getByTestId("board-card").first()).toBeVisible({ timeout: 20_000 * SLOW });
  await page.locator("#board-create").click();
  const input = page.getByTestId("board-create-input");
  const select = page.getByTestId("board-create-visibility");
  await expect(input).toBeFocused();
  await expect(select).toHaveAttribute("data-visibility", "INTERNAL");
  await select.selectOption("CLIENT_VISIBLE");
  await input.fill(shared);
  await input.press("Enter");

  const card = page.getByTestId("board-card").filter({ hasText: shared });
  await expect.poll(() => gate !== null, { timeout: 20_000 * SLOW }).toBe(true);
  // HELD: the pending card, keyed "…", already says what it will be.
  await expect(card).toHaveCount(1);
  await expect(card.locator('[data-slot="visibility-badge"]')).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");
  (gate as unknown as () => void)();

  await expect(card).toHaveAttribute("data-item-key", new RegExp(`^${seed.projectKey}-\\d+$`), {
    timeout: 20_000 * SLOW,
  });
  await expect(card.locator('[data-slot="visibility-badge"]')).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");
  await expect(select).toHaveAttribute("data-visibility", "INTERNAL");
  const key = (await card.getAttribute("data-item-key")) ?? "";
  expect(await readItemVisibility(seed.projectId, Number(key.slice(key.lastIndexOf("-") + 1)))).toMatchObject({
    visibility: "CLIENT_VISIBLE",
  });
  await input.press("Escape");
});

test("the subtask row: \"Private to team\" lowers a child of a shared task, is kept for the next one, and Escape from the select keeps the peek", async ({
  page,
  browser,
}) => {
  const parent = await createOwnTask(page, seed, "Create-visibility parent", created);
  await shareFromRail(page);
  const peek = page.getByTestId("item-peek");
  const section = peek.getByTestId("item-subtasks");
  const stamp = Date.now();
  const first = `Lowered child ${stamp}`;
  const second = `Lowered again ${stamp}`;
  created.unshift(first, second);

  await section.getByTestId("item-subtask-add").click();
  const input = section.getByTestId("item-subtask-input");
  const select = section.getByTestId("item-subtask-visibility");
  await expect(input).toBeFocused();
  // Decision (8)'s default: born with the parent's visibility.
  await expect(select).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");
  await select.selectOption("INTERNAL");
  await input.fill(first);
  await input.press("Enter");
  const firstRow = section.getByTestId("item-subtask-row").filter({ hasText: first });
  await expect(firstRow.locator('[data-slot="visibility-badge"]')).toHaveAttribute("data-visibility", "INTERNAL", {
    timeout: 20_000 * SLOW,
  });
  // KEPT across Enters — the safe side (C39).
  await expect(select).toHaveAttribute("data-visibility", "INTERNAL");
  await input.fill(second);
  await input.press("Enter");
  await expect(
    section.getByTestId("item-subtask-row").filter({ hasText: second }).locator('[data-slot="visibility-badge"]'),
  ).toHaveAttribute("data-visibility", "INTERNAL", { timeout: 20_000 * SLOW });
  const number = Number((await firstRow.textContent())?.match(new RegExp(`${seed.projectKey}-(\\d+)`))?.[1]);
  expect(await readItemVisibility(seed.projectId, number)).toMatchObject({ visibility: "INTERNAL" });

  // Escape from the SELECT closes the field — never the peek.
  await select.focus();
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(peek).toBeVisible();
  await expect(section.getByTestId("item-subtask-add")).toBeFocused();

  // The client reads the parent (the positive control) and not the child.
  await portalSays(browser, parent.title, true);
  await portalSays(browser, first, false);
});

test.describe("an employee (C38 and decision (8))", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  async function signInAsEmployee(page: Page): Promise<void> {
    await page.goto("/login");
    await page.locator("#email").fill(seed.employeeEmail);
    await page.locator("#password").fill(seed.employeePassword);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("**/home", { timeout: 30_000 });
  }

  test("no \"Client can see\" on a top-level field — the chip instead — and the lower-only switch under a shared task", async ({
    page,
    browser,
  }) => {
    // The shared parent is the OWNER's, in the owner's own jar — the
    // employee may not share it, and may not delete what it creates.
    const owner = await browser.newContext({ storageState: STORAGE_STATE, locale: "en-US" });
    const ownerPage = await owner.newPage();
    const mine: string[] = [];
    try {
      const parent = await createOwnTask(ownerPage, seed, "Employee shared parent", mine);
      await shareFromRail(ownerPage);
      const child = `Employee lowered ${Date.now()}`;
      mine.unshift(child);

      await signInAsEmployee(page);

      // The backlog's create row: the chip, no select.
      await page.goto(`/projects/${seed.projectKey}/backlog`);
      await page.locator("#new-task").getByRole("button").click();
      await expect(page.locator("#new-task input")).toBeFocused();
      await expect(page.getByTestId("backlog-create-visibility")).toHaveCount(0);
      await expect(page.getByTestId("backlog-create-visibility-fixed")).toBeVisible();
      await page.keyboard.press("Escape");

      // Quick create: the same.
      const dialog = page.getByTestId("quick-create");
      await pressUntil(page, "c", dialog);
      await expect(page.getByTestId("quick-create-title")).toBeFocused();
      await expect(page.getByTestId("quick-create-visibility")).toHaveCount(0);
      await expect(page.getByTestId("quick-create-visibility-fixed")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      // The board column: the same.
      await page.goto(`/projects/${seed.projectKey}/board`);
      await expect(page.getByTestId("board-card").first()).toBeVisible({ timeout: 20_000 * SLOW });
      await page.locator("#board-create").click();
      await expect(page.getByTestId("board-create-input")).toBeFocused();
      await expect(page.getByTestId("board-create-visibility")).toHaveCount(0);
      await expect(page.getByTestId("board-create-visibility-fixed")).toBeVisible();
      await page.keyboard.press("Escape");

      // Under the SHARED task: the lower-only switch — the one lever an
      // employee has, since they cannot make it private afterwards.
      await page.goto(`/projects/${seed.projectKey}/backlog?item=${parent.key}`);
      const section = page.getByTestId("item-peek").getByTestId("item-subtasks");
      await section.getByTestId("item-subtask-add").click();
      const select = section.getByTestId("item-subtask-visibility");
      await expect(select).toHaveAttribute("data-visibility", "CLIENT_VISIBLE", { timeout: 20_000 * SLOW });
      await select.selectOption("INTERNAL");
      const input = section.getByTestId("item-subtask-input");
      await input.fill(child);
      await input.press("Enter");
      const row = section.getByTestId("item-subtask-row").filter({ hasText: child });
      await expect(row.locator('[data-slot="visibility-badge"]')).toHaveAttribute("data-visibility", "INTERNAL", {
        timeout: 20_000 * SLOW,
      });
      await input.press("Escape");
    } finally {
      await deleteOwnTasks(ownerPage, seed, mine);
      await owner.close();
    }
  });
});
