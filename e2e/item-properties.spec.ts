import { devices, expect, test, type Locator, type Page, type Request } from "@playwright/test";

import {
  SLOW,
  createOwnTask,
  deleteOwnTasks,
  openOwnTaskPeek,
  picker,
  pressUntil,
} from "./fixtures/keys";
import { addClientVisibleComment, requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * THE ITEM RAIL'S P, E, D, A AND V, IN A REAL BROWSER (UI.md §5.2, §9).
 *
 * `keymap.spec.ts` owns the keyboard contract and only reads; these
 * pickers WRITE, so every test here creates the one task it mutates and
 * removes it in `afterEach`, pass or fail. Never a seeded task: the
 * visual sweep photographs this project.
 *
 * What only a browser can see:
 *  · V is never optimistic (§10.4): the chip still says "Client can see"
 *    the instant the picker has closed on a pick of "Private to team"
 *    that the database is about to refuse — and the refusal's sentence
 *    is what the member reads, naming what to make private first;
 *  · A's rows are the tenant's members, checked in place, with the
 *    "Unassigned" row leading only while nothing is set and "Unassign"
 *    trailing only while something is;
 *  · a bare Enter on open is a no-op for P, E and D — proven by COUNTING
 *    that property's POSTs across the next real commit. The value staying
 *    put proves nothing: a round trip that re-saves the same value, then
 *    adopts and announces it, looks exactly like no round trip at all;
 *  · the highlight: the current-state row lit on open and the derived
 *    row lit as the member types (`aria-selected`), and the combobox's
 *    `aria-activedescendant` — absent for a controlled seed or no seed,
 *    and naming the lit row once the member steers with an arrow or End;
 *  · a disabled or absent current row lighting nothing, so Enter has
 *    nothing to commit (`keymap.spec.ts`, as the employee on a gated Done);
 *  · a colleague's change landing UNDER an open picker through the
 *    board's poll, the one refresh nothing the member did caused: the new
 *    current row lit and a bare Enter still posting nothing, and a row the
 *    member typed surviving it and committing;
 *  · the calendar's keys staying its own — no single key leaks, ⌘K still
 *    reaches the palette but offers no "On this page" row from inside the
 *    picker, and Escape hands focus back to where it was — and Enter
 *    committing the FOCUSED day rather than the list's highlighted row;
 *  · the tallest picker on a short phone: the popover ends inside the
 *    screen and scrolls itself, so the calendar's last week is reachable;
 *  · every value surviving a reload, which an optimistic slice cannot fake.
 *
 * "Today" is read from the grid's own `aria-current` day, never from
 * the Node clock, whose zone is not the member's. Waits poll; nothing
 * sleeps. Each property commits twice, because the second commit is
 * the one a stale optimistic slice would get wrong.
 */

let seed!: E2ESeed;
let created: string[] = [];

test.beforeAll(() => {
  seed = requireSeed();
});

test.afterEach(async ({ page }) => {
  const titles = created;
  created = [];
  // The phone test narrows the window; the row menu is swept at desktop width.
  await page.setViewportSize(devices["Desktop Chrome"].viewport);
  await deleteOwnTasks(page, seed, titles);
});

const rail = (page: Page): Locator => page.getByTestId("item-properties");
const searchField = (page: Page): Locator => picker(page).locator('[data-slot="command-input"]');
/** The rail's live regions — one per island, silent until something changed. */
const said = (page: Page, text: string): Locator => rail(page).locator('[role="status"]', { hasText: text });
const palette = (page: Page): Locator => page.getByRole("dialog", { name: /command palette/i });

/** "YYYY-MM-DD" + n days in UTC arithmetic. */
const plusDays = (iso: string, days: number): string =>
  new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days))
    .toISOString()
    .slice(0, 10);

/**
 * Server-action POSTs that carry one property's field. Not every action
 * POST: the timer pill posts one of its own on re-sync, which would make
 * an unfiltered count flaky rather than wrong.
 */
const isActionPostWith =
  (field: string) =>
  (request: Request): boolean =>
    request.method() === "POST" &&
    Boolean(request.headers()["next-action"]) &&
    (request.postData() ?? "").includes(`"${field}"`);

/** Count, for the rest of the test, the action POSTs that carry `field`. */
function countPosts(page: Page, field: string): () => number {
  let posts = 0;
  const matches = isActionPostWith(field);
  page.on("request", (request) => {
    if (matches(request)) posts += 1;
  });
  return () => posts;
}

/**
 * Wait until the SERVER's answer for the value now on the trigger has
 * been announced. The live region speaks only after the action returns,
 * so this is the sync point before a reload or the next count.
 */
async function settled(page: Page, testId: string, prefix: string): Promise<void> {
  const text = ((await rail(page).getByTestId(testId).locator("[data-value]").textContent()) ?? "").trim();
  await expect(said(page, `${prefix} ${text}`)).toHaveCount(1, { timeout: 20_000 * SLOW });
}

/** The row is lit AND the combobox names it — what a screen reader follows. */
async function expectAnnounced(page: Page, row: Locator): Promise<void> {
  await expect(row).toHaveAttribute("aria-selected", "true");
  const id = await row.getAttribute("id");
  expect(id, "a cmdk row always carries an id").toBeTruthy();
  await expect(searchField(page)).toHaveAttribute("aria-activedescendant", id ?? "");
}

/**
 * The palette opened from INSIDE a picker: it is there, and it offers no
 * "On this page" row — each one runs a single key, and from here a key
 * would stack a second picker on the first.
 */
async function expectPaletteWithoutPageRows(page: Page): Promise<void> {
  await expect(palette(page)).toBeVisible();
  // Presence first: the palette's own rows have rendered, so the absences
  // below cannot pass against a list that is not there yet.
  await expect(palette(page).getByRole("option", { name: /Projects/ }).first()).toBeVisible();
  await expect(palette(page).getByText("On this page")).toHaveCount(0);
  for (const name of [
    /Change state/,
    /^Assign/,
    /Change priority/,
    /Set estimate/,
    /Set due date/,
    /Change visibility/,
  ]) {
    await expect(palette(page).getByRole("option", { name })).toHaveCount(0);
  }
}

async function tabToDay(page: Page): Promise<void> {
  // search → previous month → next month → the one roving day.
  for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
  const tabStop = picker(page).getByTestId("item-due-calendar").locator('button[tabindex="0"]');
  await expect(tabStop).toHaveCount(1);
  await expect(tabStop).toBeFocused();
}

test("P: two commits, then a no-op that posts nothing", async ({ page }) => {
  const priorityPosts = countPosts(page, "priority");

  await createOwnTask(page, seed, "Priority picker", created);
  const trigger = rail(page).getByTestId("item-priority");
  const shown = trigger.locator('[data-slot="priority-indicator"]');
  await expect(trigger).toBeVisible();

  await pressUntil(page, "p", picker(page));
  // ONE check in the list, on the current row, drawn by the picker itself
  // beside its "(current)" words — never a second one, never none.
  await expect(picker(page).locator("svg.lucide-check")).toHaveCount(1);
  await expect(picker(page).getByTestId("item-priority-NONE").locator("svg.lucide-check")).toHaveCount(1);
  await picker(page).getByTestId("item-priority-HIGH").click();
  await expect(picker(page)).toHaveCount(0);
  await expect(shown).toHaveAttribute("data-value", "HIGH");
  await expect(said(page, "Priority changed to High")).toHaveCount(1, { timeout: 20_000 * SLOW });
  const afterHigh = priorityPosts();

  // High is not the first row, so the picker SEEDS it: lit at once, but
  // cmdk leaves `aria-activedescendant` unset until the member steers —
  // the recorded residue. The first ArrowDown moves the highlight AND
  // names it, and Enter then commits the row steered to.
  await page.keyboard.press("p");
  await expect(searchField(page)).toBeFocused();
  await expect(picker(page).getByTestId("item-priority-HIGH")).toHaveAttribute("aria-selected", "true");
  // The check moved with the value.
  await expect(picker(page).locator("svg.lucide-check")).toHaveCount(1);
  await expect(picker(page).getByTestId("item-priority-HIGH").locator("svg.lucide-check")).toHaveCount(1);
  await expect(searchField(page)).not.toHaveAttribute("aria-activedescendant");
  await page.keyboard.press("ArrowDown");
  await expectAnnounced(page, picker(page).getByTestId("item-priority-URGENT"));
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(shown).toHaveAttribute("data-value", "URGENT");
  await expect(said(page, "Priority changed to Urgent")).toHaveCount(1, { timeout: 20_000 * SLOW });

  // The current row is highlighted on open, so a bare Enter picks what
  // the item already is: the picker closes and NOTHING is posted.
  await page.keyboard.press("p");
  await expect(picker(page).getByTestId("item-priority-URGENT")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.keyboard.press("p");
  await picker(page).getByTestId("item-priority-LOW").click();
  await expect(picker(page)).toHaveCount(0);
  await expect(shown).toHaveAttribute("data-value", "LOW");
  await expect(said(page, "Priority changed to Low")).toHaveCount(1, { timeout: 20_000 * SLOW });
  expect(priorityPosts()).toBe(afterHigh + 2);

  await page.reload();
  await expect(trigger).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(shown).toHaveAttribute("data-value", "LOW");
});

test("A: assign by typing, reassign by steering, a bare Enter posts nothing, unassign, and the value survives a reload", async ({
  page,
}) => {
  const assigneePosts = countPosts(page, "memberId");

  await createOwnTask(page, seed, "Assignee picker", created);
  const trigger = rail(page).getByTestId("item-assignee");
  const value = trigger.locator("[data-value]");
  await expect(trigger).toBeVisible();
  await expect(value).toHaveAttribute("data-value", "");

  // Unassigned: the checked "Unassigned" row is first and lit on open, so
  // a bare Enter closes the picker having committed nothing.
  await pressUntil(page, "a", picker(page));
  await expect(picker(page).getByTestId("item-assignee-none")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // Type-ahead narrows the members to one row, which cmdk lights.
  await page.keyboard.press("a");
  await expect(searchField(page)).toBeFocused();
  await page.keyboard.type("Employee");
  const employeeRow = picker(page).getByRole("option", { name: /E2E Employee/ });
  await expect(employeeRow).toHaveAttribute("aria-selected", "true");
  await expect(picker(page).getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(value).toHaveText("E2E Employee");
  await settled(page, "item-assignee", "Assigned to");
  expect(assigneePosts()).toBe(1);

  // Set: the members keep their order (the owner joined first), the
  // current member is checked in place and seeded, "Unassigned" is gone
  // and "Unassign" trails under its OWN value. A bare Enter is a no-op.
  await page.keyboard.press("a");
  await expect(picker(page).getByTestId("item-assignee-1")).toHaveAttribute("aria-selected", "true");
  await expect(picker(page).getByTestId("item-assignee-none")).toHaveCount(0);
  await expect(picker(page).getByTestId("item-assignee-clear")).toHaveAttribute("data-value", "clear");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(value).toHaveText("E2E Employee");
  await expect(trigger).toBeFocused();

  // Steering names the row it lands on; Enter commits it.
  await page.keyboard.press("a");
  await page.keyboard.press("ArrowUp");
  await expectAnnounced(page, picker(page).getByTestId("item-assignee-0"));
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(value).toHaveText("E2E Owner");
  await settled(page, "item-assignee", "Assigned to");
  expect(assigneePosts()).toBe(2);

  await page.reload();
  await expect(trigger).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(value).toHaveText("E2E Owner");

  // End reaches the clear row, last; Enter unassigns.
  await pressUntil(page, "a", picker(page));
  await expect(searchField(page)).toBeFocused();
  await page.keyboard.press("End");
  await expectAnnounced(page, picker(page).getByTestId("item-assignee-clear"));
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(value).toHaveAttribute("data-value", "");
  await expect(said(page, "Assignee removed")).toHaveCount(1, { timeout: 20_000 * SLOW });
  expect(assigneePosts()).toBe(3);
});

test("V: share, then a refused make-private that explains — and the chip is never optimistic", async ({ page }) => {
  const visibilityPosts = countPosts(page, "visibility");

  const task = await createOwnTask(page, seed, "Visibility picker", created);
  const trigger = rail(page).getByTestId("item-visibility");
  const chip = trigger.locator('[data-slot="visibility-badge"]');
  await expect(chip).toHaveAttribute("data-visibility", "INTERNAL");

  // Private, and "Private to team" is the first row: lit on open, a bare
  // Enter closes the picker having committed nothing.
  await pressUntil(page, "v", picker(page));
  await expect(picker(page).getByTestId("item-visibility-INTERNAL")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.keyboard.press("v");
  await picker(page).getByTestId("item-visibility-CLIENT_VISIBLE").click();
  await expect(picker(page)).toHaveCount(0);
  await expect(chip).toHaveAttribute("data-visibility", "CLIENT_VISIBLE", { timeout: 20_000 * SLOW });
  await expect(said(page, "Visibility changed to Client can see")).toHaveCount(1, { timeout: 20_000 * SLOW });
  expect(visibilityPosts()).toBe(1);

  // Shared: the current row is second, seeded (lit) — a bare Enter is
  // again a no-op, and the count after the next commit proves it.
  await page.keyboard.press("v");
  await expect(picker(page).getByTestId("item-visibility-CLIENT_VISIBLE")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // A comment the client can see, under the task: the database now
  // refuses to make the task private (work_item_visibility_downgrade_guard).
  await addClientVisibleComment(seed.projectId, task.number);

  await page.keyboard.press("v");
  await picker(page).getByTestId("item-visibility-INTERNAL").click();
  await expect(picker(page)).toHaveCount(0);
  // NEVER optimistic: a one-shot read the instant the picker has closed.
  // An optimistic slice would already read INTERNAL here, a chip saying
  // "Private to team" over a task the client can still see.
  expect(await chip.getAttribute("data-visibility")).toBe("CLIENT_VISIBLE");
  // The refusal explains what to make private first, and the chip never moved.
  await expect(page.getByText(/Make those private first, then the task/)).toBeVisible({
    timeout: 20_000 * SLOW,
  });
  await expect(chip).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");
  await expect(said(page, "Visibility changed to Private to team")).toHaveCount(0);
  expect(visibilityPosts()).toBe(2);

  await page.reload();
  await expect(trigger).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(chip).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");
});

test("V: a reversal picked while the first pick is in flight supersedes it — the task ends on the member's last word", async ({
  page,
}) => {
  const visibilityPosts = countPosts(page, "visibility");

  await createOwnTask(page, seed, "Visibility reversal", created);
  const trigger = rail(page).getByTestId("item-visibility");
  const chip = trigger.locator('[data-slot="visibility-badge"]');
  await expect(chip).toHaveAttribute("data-visibility", "INTERNAL");

  // Hold every visibility POST for a while, so the second pick is made
  // while the first is still in flight — the window in which the old
  // guard compared the reversal against the unchanged chip, called it a
  // no-op, and let the share land as the member's last word. The hold is
  // a FLAG, never an `unroute`: unrouting auto-continues a request a
  // delayed handler still holds, and that handler's own `continue` then
  // throws "Route is already handled", which ends the test mid-assertion
  // (seen on the first run, 2026-09-13).
  const holds = isActionPostWith("visibility");
  let holding = true;
  await page.route("**/*", async (route) => {
    if (holding && holds(route.request())) await new Promise((r) => setTimeout(r, 1_500));
    await route.continue();
  });

  await pressUntil(page, "v", picker(page));
  await picker(page).getByTestId("item-visibility-CLIENT_VISIBLE").click();
  await expect(picker(page)).toHaveCount(0);
  // Never optimistic: still private on screen while the share is in flight.
  expect(await chip.getAttribute("data-visibility")).toBe("INTERNAL");
  // The reversal, before any answer: a second POST, not a dropped no-op.
  await page.keyboard.press("v");
  await picker(page).getByTestId("item-visibility-INTERNAL").click();
  await expect(picker(page)).toHaveCount(0);
  await expect.poll(() => visibilityPosts(), { timeout: 20_000 * SLOW }).toBe(2);
  holding = false;

  // The newest pick decides: the share landed and was superseded, the
  // make-private landed last, and the task ends private — said so, shown
  // so, and stored so.
  await expect(said(page, "Visibility changed to Private to team")).toHaveCount(1, { timeout: 20_000 * SLOW });
  await expect(chip).toHaveAttribute("data-visibility", "INTERNAL");
  await page.reload();
  await expect(trigger).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(chip).toHaveAttribute("data-visibility", "INTERNAL");
});

test("the backlog's visibility cell says Saved for a write that happened, and its badge follows the server", async ({
  page,
}) => {
  const { title } = await createOwnTask(page, seed, "Backlog visibility cell", created);
  // The cell sits behind the peek: the list URL without `?item=` closes it.
  await page.goto(`/projects/${seed.projectKey}/backlog`);
  const row = page.locator('[data-slot="table-row"]', { hasText: title });
  await expect(row).toBeVisible({ timeout: 20_000 * SLOW });
  const badge = row.locator('[data-slot="visibility-badge"]');
  await expect(badge).toHaveAttribute("data-visibility", "INTERNAL");

  // Rest → select → CLIENT_VISIBLE commits on change (§5.11); the table
  // toasts "Saved" for the write, and the badge — never optimistic — shows
  // the value once the server has it.
  await row.locator('[data-slot="inline-edit"]').filter({ has: page.locator('[data-slot="visibility-badge"]') }).click();
  await row.locator("select").selectOption("CLIENT_VISIBLE");
  await expect(page.locator("[data-sonner-toast]", { hasText: "Saved" })).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(badge).toHaveAttribute("data-visibility", "CLIENT_VISIBLE", { timeout: 20_000 * SLOW });
});

test("E: typed text is the option, and a bare Enter posts nothing", async ({ page }) => {
  const estimatePosts = countPosts(page, "estimateMinutes");

  await createOwnTask(page, seed, "Estimate picker", created);
  const trigger = rail(page).getByTestId("item-estimate");
  const value = trigger.locator("[data-value]");
  const derived = picker(page).getByTestId("item-estimate-derived");
  await expect(trigger).toBeVisible();

  // The current state is the first row — "No estimate", checked — and
  // it is lit on open, so a bare Enter closes the picker having
  // committed nothing. The count after the next real commit proves it.
  await pressUntil(page, "e", picker(page));
  await expect(picker(page).getByTestId("item-estimate-none")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.keyboard.press("e");
  await expect(searchField(page)).toBeFocused();
  await page.keyboard.type("90m");
  await expect(derived).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(value).toHaveAttribute("data-value", "90");
  await settled(page, "item-estimate", "Estimate changed to");
  expect(estimatePosts()).toBe(1);

  // The same no-op on a SET value: its own row is first, and lit.
  await page.keyboard.press("e");
  await expect(picker(page).getByTestId("item-estimate-current")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(value).toHaveAttribute("data-value", "90");
  await expect(trigger).toBeFocused();

  await page.keyboard.press("e");
  await expect(searchField(page)).toBeFocused();
  await page.keyboard.type("2h");
  await expect(derived).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(value).toHaveAttribute("data-value", "120");
  await settled(page, "item-estimate", "Estimate changed to");
  expect(estimatePosts()).toBe(2);

  // Steering names the row it lands on: the clear row is LAST, and the
  // current row is back one step up.
  await page.keyboard.press("e");
  await expect(searchField(page)).toBeFocused();
  await expect(picker(page).getByTestId("item-estimate-current")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expectAnnounced(page, picker(page).getByTestId("item-estimate-clear"));
  await page.keyboard.press("ArrowUp");
  await expectAnnounced(page, picker(page).getByTestId("item-estimate-current"));

  // Text that is not an estimate derives nothing: the empty state
  // speaks, and Enter has no row to commit.
  await page.keyboard.type("1d");
  await expect(picker(page).locator('[data-slot="command-empty-state"]')).toBeVisible();
  await expect(derived).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(picker(page)).toBeVisible();
  await expect(value).toHaveAttribute("data-value", "120");
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);

  await page.reload();
  await expect(trigger).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(value).toHaveAttribute("data-value", "120");

  // A typed zero is the grammar's CLEAR.
  await pressUntil(page, "e", picker(page));
  await expect(searchField(page)).toBeFocused();
  await page.keyboard.type("0");
  await expect(derived).toHaveText("Remove estimate");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(value).toHaveAttribute("data-value", "");
  await expect(said(page, "Estimate removed")).toHaveCount(1, { timeout: 20_000 * SLOW });
  expect(estimatePosts()).toBe(3);
});

/**
 * One tick of the board's version poll (12 s, ARC-18) plus the board's own
 * render: the only way a colleague's write reaches an open peek. The
 * backlog and the full page refresh only on their own writes.
 */
const POLL_WAIT = 30_000 * SLOW;

/**
 * A colleague sets the estimate from their own peek: a SECOND page of the
 * same session, never the picker under test. Each page is brought to the
 * front before it is driven or watched. A page behind another may count
 * as hidden, and a hidden board skips its poll (`visibilityState`).
 */
async function setEstimateAsColleague(colleague: Page, typed: string, minutes: string): Promise<void> {
  await colleague.bringToFront();
  const trigger = rail(colleague).getByTestId("item-estimate");
  await expect(trigger).toBeVisible({ timeout: 20_000 * SLOW });
  await pressUntil(colleague, "e", picker(colleague));
  await expect(searchField(colleague)).toBeFocused();
  await colleague.keyboard.type(typed);
  await expect(picker(colleague).getByTestId("item-estimate-derived")).toHaveAttribute("aria-selected", "true");
  await colleague.keyboard.press("Enter");
  await expect(picker(colleague)).toHaveCount(0);
  await expect(trigger.locator("[data-value]")).toHaveAttribute("data-value", minutes);
  await settled(colleague, "item-estimate", "Estimate changed to");
}

test("E under a colleague's change: the new value is lit, a bare Enter posts nothing, and a typed row survives", async ({
  page,
}) => {
  const estimatePosts = countPosts(page, "estimateMinutes");

  // The peek IS its URL (`?item=KEY-N`), so both pages open it directly.
  const { key: itemKey } = await createOwnTask(page, seed, "Estimate refresh", created);

  // Watched from the BOARD's peek, the surface that polls.
  await page.goto(`/projects/${seed.projectKey}/board?item=${itemKey}`);
  const trigger = rail(page).getByTestId("item-estimate");
  const value = trigger.locator("[data-value]");
  const current = picker(page).getByTestId("item-estimate-current");
  const clear = picker(page).getByTestId("item-estimate-clear");
  const derived = picker(page).getByTestId("item-estimate-derived");
  await expect(trigger).toBeVisible({ timeout: 20_000 * SLOW });

  // Unset, so the lit row is "No estimate". This is F04's setup: a
  // refresh under it once turned that highlight into "Remove estimate",
  // and the member's Enter cleared the colleague's estimate.
  await pressUntil(page, "e", picker(page));
  await expect(searchField(page)).toBeFocused();
  await expect(picker(page).getByTestId("item-estimate-none")).toHaveAttribute("aria-selected", "true");

  const colleague = await page.context().newPage();
  try {
    await colleague.goto(`/projects/${seed.projectKey}/backlog?item=${itemKey}`);
    await setEstimateAsColleague(colleague, "90m", "90");

    // The poll refreshes the peek with the picker still open. The
    // highlight follows the NEW value, and never the clear row.
    await page.bringToFront();
    await expect(value).toHaveAttribute("data-value", "90", { timeout: POLL_WAIT });
    await expect(current).toHaveAttribute("aria-selected", "true");
    await expect(clear).toBeVisible();
    // F04's own guard, stated directly: the clear row carries its OWN cmdk
    // value, never the unset row's `none` (cmdk writes it to `data-value`).
    await expect(clear).toHaveAttribute("data-value", "clear");
    await expect(clear).not.toHaveAttribute("aria-selected", "true");
    await expect(picker(page).getByTestId("item-estimate-none")).toHaveCount(0);
    // A bare Enter is the no-op it was on open. Counted after the commit below.
    await page.keyboard.press("Enter");
    await expect(picker(page)).toHaveCount(0);
    await expect(value).toHaveAttribute("data-value", "90");
    await expect(trigger).toBeFocused();

    // A row the member TYPED is their own pick, and a colleague's change
    // it has nothing to do with must not take it away. The old re-seed
    // did: nothing stayed lit, and Enter did nothing.
    await page.keyboard.press("e");
    await expect(searchField(page)).toBeFocused();
    await expect(current).toHaveAttribute("aria-selected", "true");
    await page.keyboard.type("3h");
    await expect(derived).toHaveAttribute("aria-selected", "true");

    await setEstimateAsColleague(colleague, "2h", "120");

    await page.bringToFront();
    await expect(value).toHaveAttribute("data-value", "120", { timeout: POLL_WAIT });
    await expect(derived).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(picker(page)).toHaveCount(0);
    await expect(value).toHaveAttribute("data-value", "180");
    await settled(page, "item-estimate", "Estimate changed to");
    // One POST from this page: the typed row. The bare Enter sent none.
    expect(estimatePosts()).toBe(1);
  } finally {
    await colleague.close();
  }
});

test("D: grid keyboard, leak probes, Enter commits the focused day, and a bare Enter posts nothing", async ({
  page,
}) => {
  const duePosts = countPosts(page, "targetDate");

  await createOwnTask(page, seed, "Due picker", created);
  const trigger = rail(page).getByTestId("item-due");
  const value = trigger.locator("[data-value]");
  const calendar = picker(page).getByTestId("item-due-calendar");
  const focusedDay = calendar.locator("button[data-date]:focus");
  await expect(trigger).toBeVisible();

  await pressUntil(page, "d", picker(page));
  await expect(searchField(page)).toBeFocused();
  await expect(picker(page).getByTestId("item-due-none")).toHaveAttribute("aria-selected", "true");
  await expect(picker(page).getByTestId("item-due-token-tomorrow")).toBeVisible();
  const todayCell = calendar.locator('button[aria-current="date"]');
  await expect(todayCell).toHaveCount(1);
  const today = (await todayCell.getAttribute("data-date")) ?? "";
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  await tabToDay(page);
  await page.keyboard.press("ArrowRight");
  await expect(focusedDay).toHaveAttribute("data-date", plusDays(today, 1));
  await page.keyboard.press("ArrowDown");
  await expect(focusedDay).toHaveAttribute("data-date", plusDays(today, 8));

  const caption = calendar.locator('[aria-live="polite"]');
  const monthBefore = ((await caption.textContent()) ?? "").trim();
  await page.keyboard.press("PageDown");
  await expect(caption).not.toHaveText(monthBefore);
  await expect(focusedDay).toHaveCount(1);
  const landed = (await focusedDay.getAttribute("data-date")) ?? "";

  // Leak probes: a picker key, the overlay, a `G` sequence, another
  // picker key. A focused day sits inside `popover-content`, so the
  // dispatcher leaves all four alone — `g` does not even arm.
  for (const key of ["s", "?", "g", "p"]) await page.keyboard.press(key);
  // A key the grid DOES own, as the sync point: once it has moved focus,
  // every probe before it has been dispatched.
  await page.keyboard.press("ArrowLeft");
  await expect(focusedDay).toHaveAttribute("data-date", plusDays(landed, -1));
  await page.keyboard.press("ArrowRight");
  await expect(focusedDay).toHaveAttribute("data-date", landed);
  await expect(picker(page)).toHaveCount(1);
  await expect(calendar).toBeVisible();
  await expect(page).toHaveURL(/item=/);
  await expect(page.getByRole("dialog", { name: /shortcut/i })).toHaveCount(0);

  // Enter on a DAY is the native button click: it commits that day, not
  // the list's highlighted "No due date" row.
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(value).toHaveAttribute("data-value", landed);
  await expect(trigger).toBeFocused();
  await settled(page, "item-due", "Due date changed to");
  expect(duePosts()).toBe(1);

  // The date just set is the first row, and lit: a bare Enter closes the
  // picker having committed nothing — counted after the next commit.
  await page.keyboard.press("d");
  await expect(picker(page).getByTestId("item-due-current")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(value).toHaveAttribute("data-value", landed);
  await expect(trigger).toBeFocused();

  await page.keyboard.press("d");
  await expect(searchField(page)).toBeFocused();
  await page.keyboard.type("2031-03-14");
  await expect(picker(page).getByTestId("item-due-derived")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(value).toHaveAttribute("data-value", "2031-03-14");
  await settled(page, "item-due", "Due date changed to");
  expect(duePosts()).toBe(2);

  await page.reload();
  await expect(trigger).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(value).toHaveAttribute("data-value", "2031-03-14");

  // The clear row is LAST, and only there when a date is set. End steers
  // to it, so the combobox names it.
  await pressUntil(page, "d", picker(page));
  await expect(picker(page).getByTestId("item-due-clear")).toBeVisible();
  await page.keyboard.press("End");
  await expectAnnounced(page, picker(page).getByTestId("item-due-clear"));
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(value).toHaveAttribute("data-value", "");
  await expect(said(page, "Due date removed")).toHaveCount(1, { timeout: 20_000 * SLOW });
  expect(duePosts()).toBe(3);
});

test("⌘K from inside the due-date picker offers no page rows, and Escape hands focus back where it was", async ({
  page,
}) => {
  await createOwnTask(page, seed, "Due palette", created);
  const calendar = picker(page).getByTestId("item-due-calendar");
  await expect(rail(page).getByTestId("item-due")).toBeVisible();

  await pressUntil(page, "d", picker(page));
  await expect(searchField(page)).toBeFocused();

  // From the search field. Radix gives a trigger-less dialog nothing to
  // return focus to; `CommandDialog` returns it to where it was opened.
  await page.keyboard.press("ControlOrMeta+k");
  await expectPaletteWithoutPageRows(page);
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await expect(calendar).toBeVisible();
  await expect(searchField(page)).toBeFocused();

  // From a focused day. The grid returns null for every chord, so ⌘K is
  // never preventDefaulted.
  await tabToDay(page);
  const day = (await calendar.locator("button[data-date]:focus").getAttribute("data-date")) ?? "";
  expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await page.keyboard.press("ControlOrMeta+k");
  await expectPaletteWithoutPageRows(page);
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await expect(calendar.locator(`button[data-date="${day}"]`)).toBeFocused();

  // Back inside `popover-content`, a single key is inert again. Had focus
  // fallen to <body>, `p` would stack the Priority picker on this one.
  await page.keyboard.press("p");
  // A key the grid owns, as the sync point: it moves focus only once `p`
  // has been dispatched.
  await page.keyboard.press("ArrowRight");
  await expect(calendar.locator("button[data-date]:focus")).toHaveAttribute("data-date", plusDays(day, 1));
  await expect(picker(page)).toHaveCount(1);
  await expect(page.getByTestId("item-priority-HIGH")).toHaveCount(0);

  // The `?` overlay is another trigger-less dialog, and the palette still
  // offers its row from inside a picker. Choosing it closes the palette
  // and opens the overlay in one batch, so the overlay mounts while the
  // palette is still fading out and still holds focus. It inherits the
  // palette's origin (the day) rather than that closing input, and must
  // hand focus back there when it closes (`useFocusReturn`), not drop it
  // on <body>.
  const moved = plusDays(day, 1);
  await page.keyboard.press("ControlOrMeta+k");
  await expectPaletteWithoutPageRows(page);
  await palette(page).getByRole("option", { name: /shortcut/i }).click();
  const overlay = page.getByRole("dialog", { name: /shortcut/i });
  await expect(overlay).toBeVisible();
  // The palette must be GONE before Escape, not merely fading: a Radix
  // layer registers itself and its Escape listener in passive effects,
  // which run after the overlay has painted, so an Escape pressed the
  // instant the overlay is visible can still find the closing palette as
  // the highest layer — it takes the key, and the overlay stays open
  // (seen once on a loaded machine, 2026-09-13).
  await expect(palette(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await expect(calendar.locator(`button[data-date="${moved}"]`)).toBeFocused();
  await expect(picker(page)).toHaveCount(1);

  // One layer at a time: the palette went first, the picker goes now,
  // and the peek stays.
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await expect(page.getByTestId("item-peek")).toBeVisible();
});

test("D: the Escape ladder from a focused day, then the same picker on the full page", async ({ page }) => {
  const { title } = await createOwnTask(page, seed, "Due ladder", created);
  const trigger = page.getByTestId("item-due");
  await expect(trigger).toBeVisible();

  await pressUntil(page, "d", picker(page));
  await tabToDay(page);
  // No hand-written Escape anywhere: Radix closes the picker and hands
  // focus back to the trigger, so the key reopens it.
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await expect(page.getByTestId("item-peek")).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("d");
  await expect(picker(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  // A server navigation — poll, never sleep.
  await expect(page.getByTestId("item-peek")).toHaveCount(0, { timeout: 30_000 * SLOW });

  await openOwnTaskPeek(page, seed, title);
  await page.getByTestId("item-full-page").click();
  await page.waitForURL(/\/items\/\d+$/, { timeout: 20_000 * SLOW });
  // The page has no poll: the island's own refresh is its only update.
  const value = page.getByTestId("item-due").locator("[data-value]");
  await expect(page.getByTestId("item-due")).toBeVisible();
  await pressUntil(page, "d", picker(page));
  await expect(searchField(page)).toBeFocused();
  await page.keyboard.type("2031-10-01");
  await expect(picker(page).getByTestId("item-due-derived")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(value).toHaveAttribute("data-value", "2031-10-01");
  await settled(page, "item-due", "Due date changed to");

  await page.reload();
  await expect(page.getByTestId("item-due")).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(value).toHaveAttribute("data-value", "2031-10-01");
});

test("the calendar fits a short phone screen, and its last week scrolls into view", async ({ page }) => {
  const phone = { width: 375, height: 667 };

  // Created — and given a due date, which makes the list its tallest
  // (current, three tokens, clear) — at desktop width, where the
  // backlog's create row and key link are known to be reachable. The
  // PEEK is then re-rendered at phone size from its own URL.
  await createOwnTask(page, seed, "Due phone", created);
  const value = rail(page).getByTestId("item-due").locator("[data-value]");
  await expect(rail(page).getByTestId("item-due")).toBeVisible();
  await pressUntil(page, "d", picker(page));
  await expect(searchField(page)).toBeFocused();
  await page.keyboard.type("2031-03-14");
  await expect(picker(page).getByTestId("item-due-derived")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(value).toHaveAttribute("data-value", "2031-03-14");
  await settled(page, "item-due", "Due date changed to");

  await page.setViewportSize(phone);
  await page.reload();
  await expect(page.getByTestId("item-due")).toBeVisible({ timeout: 20_000 * SLOW });

  await pressUntil(page, "d", picker(page));
  const calendar = picker(page).getByTestId("item-due-calendar");
  await expect(calendar).toBeVisible();
  await expect(picker(page).getByTestId("item-due-clear")).toBeVisible();

  // Radix flips a popover but never resizes it: without a height limit
  // this one ran past the bottom of the screen, under two scroll locks.
  // Polled, because the content lifts into place as it opens.
  await expect
    .poll(async () => {
      const box = await picker(page).boundingBox();
      return box !== null && box.y >= 0 && box.y + box.height <= phone.height;
    })
    .toBe(true);
  // ~450px of list and calendar cannot fit either side of a trigger
  // halfway down 667px, so the content must be the scroller.
  expect(
    await picker(page).evaluate((el) => el.scrollHeight > el.clientHeight + 1),
    "the popover should be height-limited and scroll",
  ).toBe(true);

  // Wheel-scrolled from the search field, which is on screen at the top
  // of the scroller — never `scrollIntoView`, which would pass whether
  // or not a member could scroll.
  const lastWeekDay = calendar.locator("tbody tr").last().locator("button[data-date]").last();
  await expect(lastWeekDay).toBeAttached();
  await searchField(page).hover();
  await page.mouse.wheel(0, 2_000);
  await expect
    .poll(async () => {
      const [box, day] = await Promise.all([picker(page).boundingBox(), lastWeekDay.boundingBox()]);
      return (
        box !== null &&
        day !== null &&
        day.y >= box.y - 1 &&
        day.y + day.height <= Math.min(box.y + box.height, phone.height) + 1
      );
    })
    .toBe(true);

  // And it still fits the width.
  const popover = await picker(page).boundingBox();
  const lastColumnDay = calendar.locator("tbody tr").first().locator("td").last().locator("button");
  const day = await lastColumnDay.boundingBox();
  if (!popover || !day) throw new Error("the picker or its last day has no box");
  expect(day.x + day.width).toBeLessThanOrEqual(popover.x + popover.width);
  expect(await picker(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(popover.x).toBeGreaterThanOrEqual(0);
  expect(popover.x + popover.width).toBeLessThanOrEqual(phone.width);
});
