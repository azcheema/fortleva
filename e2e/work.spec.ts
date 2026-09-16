import { expect, test, type Locator, type Page } from "@playwright/test";

import { actionAnswered } from "./fixtures/actions";
import { backlogRows, focusedBacklogRow, keyLink, pressUntil } from "./fixtures/keys";
import { createBigProject, dropProject, requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * The project board in a browser (PLAN.md 2W "Demo"; UI.md rule 5, §7.1,
 * §7.2): a title-only create in a column lands there and takes its key
 * on the refresh; a drag across columns is a state change that survives
 * a reload; the keyboard twin (`S` → "Move to…" → Top of Done) does the
 * same without a pointer; the backlog — the same list — agrees; group by
 * assignee puts the card in the Unassigned lane; and the employee who is
 * not on the project gets the in-shell 404, not a board. Everything
 * happens inside the throwaway e2e tenant and is removed by teardown.
 */

let seed!: E2ESeed;
/**
 * The titles this run created, so teardown removes them EVEN IF the test
 * failed — a failing run is exactly when a leftover row would poison the
 * project the visual sweep photographs. A list, not one title: the bulk
 * tests create several, and a cleanup that only handles the happy path
 * is the defect a previous review already caught on this suite.
 */
let created: string[] = [];

// A move is a server action plus a refresh of the whole board; on CI
// (US runner, EU database) the same waits get three times the leash.
const SLOW = process.env["CI"] ? 3 : 1;

test.beforeAll(() => {
  seed = requireSeed();
});

test.afterEach(async ({ page }) => {
  const titles = created;
  created = [];
  if (titles.length === 0) return;
  // Archived rows are not on the board, so the sweep runs with the
  // backlog's archived view open — every task this file made is
  // reachable there whatever state the test left it in.
  await page.goto(`/projects/${seed.projectKey}/backlog?archived=1`);
  for (const title of titles) {
    const row = page.locator('[data-slot="table-row"]', { hasText: title });
    if ((await row.count()) === 0) continue;
    await row.first().getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Yes" }).click();
    await expect(page.locator('[data-slot="table-row"]', { hasText: title })).toHaveCount(0, {
      timeout: 20_000 * SLOW,
    });
  }
});

// `.first()` = the first column of that category in DOM (= rank) order:
// IN_PROGRESS has two states since 2W-R (In progress, then In review),
// and a bare two-element locator fails Playwright's strict mode. The
// category attribute is the anchor on purpose — never the label, which
// since 2026-09-01 follows the VIEWER's language for an untouched seed.
const column = (page: Page, category: string): Locator =>
  page.locator(`[data-testid="board-column"][data-state-category="${category}"]`).first();
const cardIn = (scope: Locator | Page, title: string): Locator =>
  scope.locator('[data-testid="board-card"]', { hasText: title });

test.describe("project board (owner)", () => {
  test("create in a column, drag across columns, move by keyboard, the backlog agrees, group by assignee", async ({ page }) => {
    await page.goto(`/projects/${seed.projectKey}/board`);
    await expect(page.getByTestId("board")).toBeVisible();
    const todo = column(page, "TODO");
    const inProgress = column(page, "IN_PROGRESS");
    const done = column(page, "DONE");
    await expect(todo).toBeVisible();

    // Title-only create at the foot of To do: at rest a button, then a
    // field; Enter creates and keeps the field open for the next title.
    const title = `Board task ${Date.now()}`;
    created.push(title); // afterEach removes it, pass or fail
    await todo.getByTestId("board-create").click();
    const input = todo.getByTestId("board-create-input");
    await input.fill(title);
    await input.press("Enter");
    const card = cardIn(todo, title);
    await expect(card).toBeVisible();
    // The real key replaces the optimistic "…" once the refresh lands.
    await expect(card).toHaveAttribute("data-item-key", new RegExp(`^${seed.projectKey}-\\d+$`), {
      timeout: 20_000 * SLOW,
    });
    await expect(input).toBeVisible();
    await input.press("Escape");
    await expect(input).toHaveCount(0);

    // The card's own id, so the waits below take the MOVE's answer and
    // not the timer pill's re-sync POST (fixtures/actions.ts).
    const cardId = (await card.getAttribute("data-board-card")) ?? "";
    expect(cardId).not.toBe("");

    // Drag to In progress (Pragmatic: native HTML5 drag, desktop only).
    // The board paints the move optimistically, so the assertion below can
    // be true before the server has stored it. Wait for the action's own
    // answer, or the reload races the write and reads the old column.
    const dragged = actionAnswered(page, { contains: [cardId, '"stateId"'] });
    await card.dragTo(inProgress);
    await expect(cardIn(inProgress, title)).toBeVisible({ timeout: 20_000 * SLOW });
    await dragged;
    await page.reload();
    await expect(cardIn(inProgress, title)).toBeVisible();
    await expect(cardIn(todo, title)).toHaveCount(0);

    // Keyboard twin: focus the card, S opens "Move to…", pick Top of Done.
    await cardIn(inProgress, title).focus();
    await page.keyboard.press("s");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const movedByKeyboard = actionAnswered(page, { contains: [cardId, '"stateId"'] });
    await dialog.getByTestId("move-top-DONE").click();
    await expect(cardIn(done, title)).toBeVisible({ timeout: 20_000 * SLOW });
    await movedByKeyboard;
    await page.reload();
    await expect(cardIn(done, title)).toBeVisible();
    // "Top of Done" means first in that column.
    const key = (await cardIn(done, title).getAttribute("data-item-key")) ?? "";
    await expect(done.locator('[data-testid="board-card"]').first()).toHaveAttribute("data-item-key", key);

    // The WORDS, not just "some string". This is the founder-visible
    // half of the 2026-09-01 stage-name change: the fixture's project is
    // seeded fresh, so its states carry no stored name and render
    // through i18n in the VIEWER's language. English here comes from
    // `User.locale = "en"` on the seeded principals
    // (e2e/fixtures/seed-cli.ts) — NOT from Playwright's browser locale,
    // which src/i18n/resolve.ts only reaches third, after the User row
    // and the tenant default (the seeded tenant is `sv`). Asserting the
    // exact label is what would catch a raw enum reaching the screen, or
    // the resolution silently falling back to the tenant's language.
    const doneName = (await done.locator("h3").textContent())?.trim() ?? "";
    expect(doneName).toBe("Done");

    // One list, two surfaces: the backlog row must agree with it.
    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const row = page.locator('[data-slot="table-row"]', { hasText: title });
    await expect(row).toBeVisible();
    await expect(row).toContainText(doneName);

    // Group by assignee: the unassigned card sits in the Unassigned lane,
    // and the view is a link.
    await page.goto(`/projects/${seed.projectKey}/board?group=assignee`);
    await expect(page.getByTestId("board-group-assignee")).toHaveAttribute("aria-current", "page");
    const lane = page.locator('[data-testid="board-lane"][data-lane="unassigned"]');
    await expect(cardIn(lane, title)).toBeVisible();

    // The row this test added is removed by afterEach, pass or fail: this
    // project is the one the visual sweep photographs, and a leftover task
    // would change tomorrow's screenshots (timeline.spec.ts states the
    // doctrine; today only file ordering keeps it true).
  });

  test("grooming (2W-G): priority, due date and an estimate set inline from the backlog", async ({ page }) => {
    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const title = `Groom task ${Date.now()}`;
    created.push(title); // afterEach removes it, pass or fail

    // Create through the backlog's create row (rest = a button, then a field).
    await page.locator("#new-task").getByRole("button").click();
    const createInput = page.locator("#new-task input");
    await createInput.fill(title);
    await createInput.press("Enter");
    const row = page.locator('[data-slot="table-row"]', { hasText: title });
    await expect(row).toBeVisible({ timeout: 20_000 * SLOW });
    await createInput.press("Escape");

    // Priority: rest → select → HIGH commits on change.
    await row.getByTestId("backlog-priority").getByRole("button").click();
    await row.getByTestId("backlog-priority").locator("select").selectOption("HIGH");
    await expect(row.locator('[data-slot="priority-indicator"]')).toHaveAttribute(
      "data-value",
      "HIGH",
      { timeout: 20_000 * SLOW },
    );

    // Due date: the ISO value is locale-blind on both ends. The text here
    // is NOT a sync point — an empty due cell has no `display` node, so
    // `InlineEdit` falls back to the value the member just committed and
    // "2026" is on screen before the server has it. The estimate cell
    // below is the same shape; it only LOOKS safe because its optimistic
    // text is the typed "90m", which happens not to contain the asserted
    // "30". Both therefore wait for their own action. (Priority is a real
    // sync point: its indicator is a `display` node built from the server
    // row, so it cannot paint early.)
    // The id is only a usable filter once it is the SERVER's. A NUMBERED
    // key is that proof: the backlog renders the key cell unconditionally,
    // so an optimistic row would read `KEY-0` (`number: 0`) and a bare
    // `\d+` would accept it — hence `[1-9]\d*`. The backlog has no
    // optimistic create today (its reducer takes only a Move), so this is
    // a guard for the surface both `backlog-table.tsx` and `model.ts`
    // already anticipate getting one.
    await expect(
      row.getByRole("link", { name: new RegExp(`^${seed.projectKey}-[1-9]\\d*$`) }),
    ).toBeVisible({ timeout: 20_000 * SLOW });
    const rowId = (await row.getAttribute("data-item-id")) ?? "";
    expect(rowId).not.toBe("");
    const dueSaved = actionAnswered(page, { contains: [rowId, '"targetDate"'] });
    await row.getByTestId("backlog-due").getByRole("button").click();
    const dueInput = row.getByTestId("backlog-due").locator("input");
    await dueInput.fill("2026-09-15");
    await dueInput.press("Enter");
    await expect(row.getByTestId("backlog-due")).toContainText("2026", { timeout: 20_000 * SLOW });
    await dueSaved;

    // Estimate: the pinned grammar — "90m" in, and the edit seed reads
    // back as the locale-blind "1h 30m" text (normalization proof).
    const estimateSaved = actionAnswered(page, { contains: [rowId, '"estimateMinutes"'] });
    await row.getByTestId("backlog-estimate").getByRole("button").click();
    const estimateInput = row.getByTestId("backlog-estimate").locator("input");
    await estimateInput.fill("90m");
    await estimateInput.press("Enter");
    await expect(row.getByTestId("backlog-estimate")).toContainText("30", {
      timeout: 20_000 * SLOW,
    });
    await estimateSaved;

    // Everything survives a full reload.
    await page.reload();
    const fresh = page.locator('[data-slot="table-row"]', { hasText: title });
    await expect(fresh.locator('[data-slot="priority-indicator"]')).toHaveAttribute("data-value", "HIGH");
    await fresh.getByTestId("backlog-estimate").getByRole("button").click();
    await expect(fresh.getByTestId("backlog-estimate").locator("input")).toHaveValue("1h 30m");
    await page.keyboard.press("Escape");
    await fresh.getByTestId("backlog-due").getByRole("button").click();
    await expect(fresh.getByTestId("backlog-due").locator("input")).toHaveValue("2026-09-15");
    await page.keyboard.press("Escape");
  });

  test("2W-F: the view lives in the URL — chips, hide-done, grouping, and a peek that keeps them", async ({ page }) => {
    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const title = `Filter task ${Date.now()}`;
    created.push(title); // afterEach removes it, pass or fail

    // The chips are ALWAYS visible above the list — never behind a
    // drawer or a disclosure (UI.md §5.3: hidden filters are the top
    // complaint in the corpus this product was designed against).
    const bar = page.getByTestId("work-filter-bar");
    await expect(bar).toBeVisible();
    const summary = page.getByTestId("work-filter-summary");
    await expect(summary).toBeVisible();

    await page.locator("#new-task").getByRole("button").click();
    const createInput = page.locator("#new-task input");
    await createInput.fill(title);
    await createInput.press("Enter");
    const row = page.locator('[data-slot="table-row"]', { hasText: title });
    await expect(row).toBeVisible({ timeout: 20_000 * SLOW });
    await createInput.press("Escape");

    // Put it in a terminal category so hide-done has something to hide.
    // The owner is an approver, so the gated Done state is offered.
    await row.getByTestId("backlog-state").getByRole("button").click();
    await row.getByTestId("backlog-state").locator("select").selectOption({ label: "Done" });
    await expect(row).toContainText("Done", { timeout: 20_000 * SLOW });

    // Hide finished: the row goes, and the view is a LINK — a reload
    // restores exactly what was on screen, which is the whole point of
    // keeping the view in the URL rather than in component state.
    await page.getByTestId("work-filter-hide-done").click();
    await expect(row).toHaveCount(0);
    await expect(page).toHaveURL(/hideDone=true/);
    await expect(page.getByTestId("work-filter-hide-done")).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.locator('[data-slot="table-row"]', { hasText: title })).toHaveCount(0);
    await expect(page.getByTestId("work-filter-hide-done")).toHaveAttribute("aria-pressed", "true");

    // Clearing brings the work back — and takes the param with it, so a
    // view at rest is addressable as the bare path (`clearOnDefault`).
    await page.getByTestId("work-filter-clear").click();
    await expect(page.locator('[data-slot="table-row"]', { hasText: title })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${seed.projectKey}/backlog$`));

    // A filter that matches nothing is the THIRD empty state (UI.md
    // §5.8): things exist, none match, and the verb is to clear it —
    // never "create the first task", which would lie about the list.
    await page.getByTestId("work-filter-state").click();
    const doneOption = page.getByRole("menuitemcheckbox", { name: "Done" });
    await doneOption.click();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-slot="table-row"]', { hasText: title })).toBeVisible();
    await page.getByTestId("work-filter-hide-done").click();
    await expect(page.locator('[data-variant="filtered"]')).toBeVisible();
    await page.getByTestId("backlog-filtered-clear").click();
    await expect(page.locator('[data-variant="filtered"]')).toHaveCount(0);

    // Grouping is a view, not a filter: it survives a Clear and shows
    // header rows the ungrouped list does not have.
    await page.goto(`/projects/${seed.projectKey}/backlog?group=assignee`);
    await expect(page.getByTestId("backlog-group").first()).toBeVisible();

    // THE REGRESSION GUARD for the double-'?': open an item's peek while
    // a filter is on. The link must carry both, with ONE question mark,
    // and closing the peek must land back on the FILTERED list — the old
    // hand-built `${listHref}${archived ? "&" : "?"}item=` produced
    // `?group=assignee?item=…` the moment a second param existed.
    const grouped = page.locator('[data-slot="table-row"]', { hasText: title });
    await keyLink(grouped, seed.projectKey).click();
    await expect(page.getByTestId("item-peek")).toBeVisible();
    const peeked = new URL(page.url());
    expect(peeked.search.match(/\?/g)).toHaveLength(1);
    expect(peeked.searchParams.get("group")).toBe("assignee");
    expect(peeked.searchParams.get("item")).toMatch(new RegExp(`^${seed.projectKey}-\\d+$`));
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("item-peek")).toHaveCount(0);
    await expect(page).toHaveURL(/group=assignee/);
    await expect(page).not.toHaveURL(/item=/);
  });

  test("2W-P: the item panel is ONE component in two places, and an archived item still opens", async ({ page }) => {
    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const title = `Panel task ${Date.now()}`;
    created.push(title); // afterEach removes it, pass or fail

    await page.locator("#new-task").getByRole("button").click();
    const createInput = page.locator("#new-task input");
    await createInput.fill(title);
    await createInput.press("Enter");
    const row = page.locator('[data-slot="table-row"]', { hasText: title });
    await expect(row).toBeVisible({ timeout: 20_000 * SLOW });

    // Peek → full page: the same panel, the same properties.
    await keyLink(row, seed.projectKey).click();
    const peek = page.getByTestId("item-peek");
    await expect(peek).toBeVisible();
    await expect(peek.getByTestId("item-properties")).toBeVisible();
    await peek.getByTestId("item-full-page").click();
    await page.waitForURL(new RegExp(`/projects/${seed.projectKey}/items/\\d+$`), { timeout: 20_000 * SLOW });
    const itemUrl = page.url();
    const number = itemUrl.split("/").pop()!;
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    await expect(page.getByTestId("item-properties")).toBeVisible();
    // The project shell is still around it — the panel is a tab-level
    // page, not a screen of its own — and the strip says WHERE you are:
    // an item page is a Backlog sub-view, so that tab is current. A strip
    // with nothing current reads as "this page has no tabs".
    await expect(page.getByRole("link", { name: "Backlog" })).toHaveAttribute("aria-current", "page");

    // THE REGRESSION GUARD for reading the panel's item out of a list:
    // the board never loads archived rows, so before the scoped single
    // read an archived item could be addressed and simply not open.
    await page.goto(`/projects/${seed.projectKey}/backlog`);
    await page
      .locator('[data-slot="table-row"]', { hasText: title })
      .getByTestId("backlog-select-row")
      .click();
    await page.getByTestId("bulk-archive").click();
    await expect(page.locator('[data-slot="table-row"]', { hasText: title })).toHaveCount(0, {
      timeout: 20_000 * SLOW,
    });
    await page.goto(`/projects/${seed.projectKey}/board?item=${seed.projectKey}-${number}`);
    await expect(page.getByTestId("item-peek")).toBeVisible({ timeout: 20_000 * SLOW });
    await expect(page.getByTestId("item-peek")).toContainText(title);
    await page.goto(itemUrl);
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  });

  test("2W-F: the description saves itself, twice, and the checklist counts what it stores", async ({ page }) => {
    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const title = `Described task ${Date.now()}`;
    created.push(title); // afterEach removes it, pass or fail

    await page.locator("#new-task").getByRole("button").click();
    const createInput = page.locator("#new-task input");
    await createInput.fill(title);
    await createInput.press("Enter");
    const row = page.locator('[data-slot="table-row"]', { hasText: title });
    await expect(row).toBeVisible({ timeout: 20_000 * SLOW });
    await keyLink(row, seed.projectKey).click();
    await page.getByTestId("item-full-page").click();
    await page.waitForURL(new RegExp(`/projects/${seed.projectKey}/items/\\d+$`), { timeout: 20_000 * SLOW });
    const itemUrl = page.url();

    const editor = () => page.getByTestId("description-editor");
    await expect(editor()).toBeVisible();
    // Wait on the autosave's own round trip rather than on the status
    // text beside it. The POST is the event that certainly happened; the
    // label is state that a later re-render can move on from. It is still
    // asserted once below, because "Saved" appearing at all is the only
    // proof the member is ever told the field is safe.
    const saveLands = () =>
      page.waitForResponse((r) => r.request().method() === "POST" && r.url().startsWith(itemUrl), {
        timeout: 20_000 * SLOW,
      });

    // Blur commits immediately, so nothing here waits on the 2 s idle timer.
    let landed = saveLands();
    await editor().click();
    await page.keyboard.type("The stack is behind the shed.");
    await editor().blur();
    await landed;
    await expect(page.getByTestId("description").getByText("Saved", { exact: true })).toBeVisible({
      timeout: 20_000 * SLOW,
    });

    // THE REGRESSION GUARD, and the reason this test exists. A save hands
    // the editor the token its NEXT save must present, and that token has
    // to be a hash of what POSTGRES stored rather than of what the server
    // sent: jsonb re-orders object keys, so a token taken from the
    // outgoing document matches nothing a later read computes, and the
    // SECOND save of every editing session is refused as stale. One save
    // proves nothing here — two do, and the reload proves the second one
    // reached a column.
    landed = saveLands();
    await editor().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Key is with Ana.");
    await editor().blur();
    await landed;
    // A refusal is a toast, never a silent revert.
    await expect(page.getByText(/Someone else saved this description/)).toHaveCount(0);

    await page.reload();
    await expect(editor()).toContainText("The stack is behind the shed.");
    await expect(editor()).toContainText("Key is with Ana.");

    // The checklist lives IN the description and is counted by the
    // server, so the properties rail reads back what the document says.
    landed = saveLands();
    await editor().click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("[ ] buy sealant");
    await page.keyboard.press("Enter");
    await page.keyboard.type("bleed the radiator");
    await editor().blur();
    await landed;
    // The refusal path is a toast, never a silent revert — and an
    // INVALID_INPUT here is how the attrs-serialisation bug showed up.
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

    await page.reload();
    // Which half failed, if it fails: the document, or the counters the
    // server derives from it.
    await expect(editor()).toContainText("buy sealant");
    await expect(page.getByTestId("item-properties")).toContainText("0 of 2 done");
    // And the checkbox is named in the workspace's language, not in
    // Tiptap's built-in English.
    await expect(page.getByRole("checkbox", { name: /buy sealant/ })).toBeVisible();
  });

  test("2W-F: the backlog reorders — by the row menu and by drag — and the order sticks", async ({ page }) => {
    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const title = `Reorder task ${Date.now()}`;
    created.push(title); // afterEach removes it, pass or fail

    await page.locator("#new-task").getByRole("button").click();
    const createInput = page.locator("#new-task input");
    await createInput.fill(title);
    await createInput.press("Enter");
    const row = page.locator('[data-testid="backlog-row"]', { hasText: title });
    await expect(row).toBeVisible({ timeout: 20_000 * SLOW });
    await createInput.press("Escape");

    // Everything below moves only THIS task, which afterEach then deletes,
    // so the project order the visual sweep photographs is left as found.
    const ids = () => page.locator('[data-testid="backlog-row"]').evaluateAll(
      (rows) => rows.map((r) => r.getAttribute("data-item-id") ?? ""),
    );
    const mine = (await row.getAttribute("data-item-id")) ?? "";
    expect(mine).not.toBe("");
    // A title-only create lands at the BOTTOM of the project order.
    expect((await ids()).at(-1)).toBe(mine);

    // The keyboard/touch twin (UI.md §7.1 wants one; §5.12 puts it in the
    // menu). At the bottom there is no "Move down" to offer — a verb that
    // cannot act is left out, not rendered inert.
    await row.getByRole("button", { name: /Actions for/ }).click();
    // Prove the menu is actually OPEN before asserting what it lacks: a
    // toHaveCount(0) against a portal that has not rendered yet passes
    // whether or not the guard works, which is the vacuous-assertion
    // shape a previous review caught on this suite.
    await expect(page.getByRole("menuitem", { name: "Move to top" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Move down" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Move to bottom" })).toHaveCount(0);
    // THE POLL IS NOT ENOUGH: the list is `useOptimistic` over the
    // server's rows, so it can be satisfied by the optimistic order alone
    // while the rank write is still in flight, and the reload then reads
    // the server's older order. Armed before the click, awaited before the
    // reload — the description test's pattern. (The drag below is where CI
    // run 35002303147 actually caught it.)
    // "Move to top" anchors BEFORE the first row (`rowAnchors`), so the
    // body carries `beforeId` — the field half of the filter.
    const movedToTop = actionAnswered(page, { contains: [mine, '"beforeId"'] });
    await page.getByRole("menuitem", { name: "Move to top" }).click();
    await expect
      .poll(async () => (await ids())[0], { timeout: 20_000 * SLOW })
      .toBe(mine);
    await movedToTop;

    // It is a rank change, not a state change, so it survives a reload —
    // the server wrote a real rank, not an optimistic guess.
    await page.reload();
    expect((await ids())[0]).toBe(mine);

    // And now the top row has no "Move up" either.
    const first = page.locator('[data-testid="backlog-row"]').first();
    await first.getByRole("button", { name: /Actions for/ }).click();
    await expect(page.getByRole("menuitem", { name: "Move down" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Move up" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Move to top" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Drag (desktop): onto the LOWER half of the last row, which the
    // hitbox reads as "after it".
    const before = await ids();
    const lastId = before.at(-1)!;
    const target = page.locator(`[data-testid="backlog-row"][data-item-id="${lastId}"]`);
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    // THE FLAKE CI RUN 35002303147 HIT, at the assertion after this
    // reload: the poll below had already passed on the same expression.
    const draggedToBottom = actionAnswered(page, { contains: [mine, '"afterId"'] });
    await page
      .locator(`[data-testid="backlog-row"][data-item-id="${mine}"]`)
      .dragTo(target, { targetPosition: { x: Math.round(box!.width / 2), y: box!.height - 2 } });
    await expect
      .poll(async () => (await ids()).at(-1), { timeout: 20_000 * SLOW })
      .toBe(mine);
    await draggedToBottom;
    await page.reload();
    expect((await ids()).at(-1)).toBe(mine);
  });

  test("2W-F: the selection bar edits several tasks at once, and says how many it changed", async ({ page }) => {
    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const stamp = Date.now();
    const titles = [`Bulk one ${stamp}`, `Bulk two ${stamp}`];
    for (const title of titles) {
      created.push(title);
      await page.locator("#new-task").getByRole("button").click();
      const input = page.locator("#new-task input");
      await input.fill(title);
      await input.press("Enter");
      await expect(page.locator('[data-slot="table-row"]', { hasText: title })).toBeVisible({
        timeout: 20_000 * SLOW,
      });
      await input.press("Escape");
    }

    // No selection, no bar: it appears on the first checkbox and not before.
    await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
    const rowsFor = (title: string) => page.locator('[data-testid="backlog-row"]', { hasText: title });
    for (const title of titles) {
      await rowsFor(title).getByTestId("backlog-select-row").click();
    }
    const bar = page.getByTestId("bulk-bar");
    await expect(bar).toBeVisible();
    await expect(page.getByTestId("bulk-count")).toContainText("2");

    // One verb, both rows.
    await page.getByTestId("bulk-priority").click();
    await page.getByRole("menuitem", { name: "Urgent" }).click();
    for (const title of titles) {
      await expect(
        rowsFor(title).locator('[data-slot="priority-indicator"]'),
      ).toHaveAttribute("data-value", "URGENT", { timeout: 20_000 * SLOW });
    }
    // Acting clears the selection, so the bar goes with it.
    await expect(page.getByTestId("bulk-bar")).toHaveCount(0);

    // It really wrote: a reload shows the same two.
    await page.reload();
    for (const title of titles) {
      await expect(rowsFor(title).locator('[data-slot="priority-indicator"]')).toHaveAttribute(
        "data-value",
        "URGENT",
      );
    }

    // Select-all takes every row that is SHOWN, so it selects MORE than
    // the two this test made — which is exactly why no destructive verb
    // runs while it is on. This project is the one the visual sweep
    // photographs, and `afterEach` can only clean up what this test
    // created; archiving a stranger's row would leave it archived.
    const shown = await page.locator('[data-testid="backlog-row"]').count();
    expect(shown).toBeGreaterThan(titles.length);
    await page.getByTestId("backlog-select-all").click();
    await expect(page.getByTestId("bulk-count")).toContainText(String(shown));
    // Clicking it again clears, rather than selecting all a second time.
    await page.getByTestId("backlog-select-all").click();
    await expect(page.getByTestId("bulk-bar")).toHaveCount(0);

    // Archive ONLY the two rows this test owns.
    for (const title of titles) {
      await rowsFor(title).getByTestId("backlog-select-row").click();
    }
    await expect(page.getByTestId("bulk-count")).toContainText("2");
    await page.getByTestId("bulk-archive").click();
    for (const title of titles) {
      await expect(rowsFor(title)).toHaveCount(0, { timeout: 20_000 * SLOW });
    }
    // And they are archived, not deleted — the archived view still has them.
    await page.goto(`/projects/${seed.projectKey}/backlog?archived=1`);
    for (const title of titles) {
      await expect(page.locator('[data-slot="table-row"]', { hasText: title })).toBeVisible();
    }
  });
});

/**
 * 2W-F slice 3 — THE ONLY PLACE THE WINDOWED PATH EVER RUNS.
 *
 * Virtualisation is inert at or below 200 rows, so the standing fixture
 * (five tasks) and all 43 visual stops exercise the unwindowed path.
 * Without this describe block the feature would ship having never
 * executed once. The project is made and dropped here, so no other spec
 * and no screenshot ever sees it.
 */
test.describe("a backlog past the virtualisation threshold", () => {
  const SIZE = 250;
  let big: { projectId: string; key: string; size: number };

  /**
   * Scroll to the end UNTIL the target is visible — never once and then
   * wait. A single `scrollTo` straight after a reload left the page at
   * its TOP in CI (run 34907609420, both attempts: scrollY 0 after 60 s,
   * the SSR page already at full height when the scroll fired, no
   * console or page error recorded) while the same test passed six
   * times locally, throttled to 8× included. What moved the scroll back
   * is unproven (PLAN §0), so this retries the scroll — which is
   * idempotent, unlike the key `fixtures/keys.ts`'s `pressUntil` guards —
   * and RECORDS every retry as a test annotation: a scroll that had to
   * be repeated is exactly the reset this cannot otherwise distinguish
   * from a pass, and it must stay visible in the report. A window that
   * never follows a scroll still fails here: a repeat `scrollTo` to the
   * same offset scrolls nothing and dispatches no event.
   */
  const scrollToEndUntil = async (page: Page, target: Locator) => {
    let attempts = 0;
    await expect(async () => {
      attempts += 1;
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(target).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 * SLOW });
    if (attempts > 1) {
      const scrollY = await page.evaluate(() => Math.round(window.scrollY));
      test.info().annotations.push({
        type: "scroll-retried",
        description: `scrollToEndUntil needed ${attempts} attempts (final scrollY ${scrollY})`,
      });
    }
  };

  test.beforeAll(async () => {
    big = await createBigProject(seed.tenantId, SIZE);
  });

  test.afterAll(async () => {
    if (big) await dropProject(big.projectId);
  });

  test("renders a window, not the list — and every row is still reachable, editable and countable", async ({ page }) => {
    await page.goto(`/projects/${big.key}/backlog`);
    const rows = page.locator('[data-testid="backlog-row"]');
    await expect(rows.first()).toBeVisible();

    // THE POINT: the DOM holds a fraction of the list.
    const mounted = await rows.count();
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(SIZE);

    // The page is nevertheless its FULL height — the spacers pay for
    // what is not mounted, so the scrollbar tells the truth and the
    // position never jumps when the window refines.
    await expect(page.getByTestId("backlog-pad-bottom")).toBeAttached();
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(pageHeight).toBeGreaterThan(SIZE * 30);

    // The count above the table reports the WHOLE list, not the window.
    await expect(page.getByTestId("work-filter-summary")).toContainText(String(SIZE));

    // The first rows are mounted, the last are not.
    await expect(page.locator('[data-testid="backlog-row"]', { hasText: "Row 0001" })).toBeVisible();
    await expect(page.locator('[data-testid="backlog-row"]', { hasText: `Row ${String(SIZE).padStart(4, "0")}` })).toHaveCount(0);

    // Scroll to the end: the far rows mount, the near ones are released,
    // and the top spacer appears in their place.
    await scrollToEndUntil(
      page,
      page.locator('[data-testid="backlog-row"]', { hasText: `Row ${String(SIZE).padStart(4, "0")}` }),
    );
    await expect(page.getByTestId("backlog-pad-top")).toBeAttached();
    await expect(page.locator('[data-testid="backlog-row"]', { hasText: "Row 0001" })).toHaveCount(0);

    // A row deep in the list is fully live, not a read-only placeholder:
    // rename the last one and see it survive a reload.
    //
    // The row is pinned by its id FIRST. An <InlineEdit> swaps the
    // display text for an <input>, so the title stops being text content
    // the moment the editor opens — a `hasText` locator would stop
    // matching the very row it just opened, and wait for it forever.
    const lastId = await page
      .locator('[data-testid="backlog-row"]', { hasText: `Row ${String(SIZE).padStart(4, "0")}` })
      .getAttribute("data-item-id");
    expect(lastId).toBeTruthy();
    const last = page.locator(`[data-testid="backlog-row"][data-item-id="${lastId}"]`);
    const renamed = `Renamed ${Date.now()}`;
    await last.getByRole("button", { name: new RegExp(`Row ${String(SIZE).padStart(4, "0")}`) }).first().click();
    const field = last.locator("input").first();
    await field.fill(renamed);
    await field.press("Enter");
    await expect(
      page.locator('[data-testid="backlog-row"]', { hasText: renamed }),
    ).toBeVisible({ timeout: 20_000 * SLOW });
    await page.reload();
    await scrollToEndUntil(page, page.locator('[data-testid="backlog-row"]', { hasText: renamed }));

    // Put it back. These three tests share one project (it is made once
    // in beforeAll), so a mutation left behind here is a mutation the
    // next test inherits — which is exactly how this test first broke
    // its sibling: the sibling looked for "Row 0250" and found a row
    // this one had renamed.
    await last.getByRole("button", { name: new RegExp(renamed) }).first().click();
    const restore = last.locator("input").first();
    await restore.fill(`Row ${String(SIZE).padStart(4, "0")}`);
    await restore.press("Enter");
    await expect(
      page.locator('[data-testid="backlog-row"]', { hasText: `Row ${String(SIZE).padStart(4, "0")}` }),
    ).toBeVisible({ timeout: 20_000 * SLOW });
  });

  test("the whole list is still selectable and countable, though most of it is not in the DOM", async ({ page }) => {
    await page.goto(`/projects/${big.key}/backlog`);
    await expect(page.locator('[data-testid="backlog-row"]').first()).toBeVisible();

    // Select-all reads the LIST, not the window — and is capped at what
    // one bulk action can carry, which is the cap the toast names.
    await page.getByTestId("backlog-select-all").click();
    await expect(page.getByTestId("bulk-count")).toContainText("50");

    // The bar acts on rows that are not mounted at all.
    await page.getByTestId("bulk-priority").click();
    await page.getByRole("menuitem", { name: "Low" }).click();
    await expect(page.getByTestId("bulk-bar")).toHaveCount(0, { timeout: 20_000 * SLOW });
    await expect(
      page.locator('[data-testid="backlog-row"]').first().locator('[data-slot="priority-indicator"]'),
    ).toHaveAttribute("data-value", "LOW", { timeout: 20_000 * SLOW });
  });

  test("a filter that empties the list, then clears, does not strand the rows it hid", async ({ page }) => {
    // The bug this pins: with the window kept in component state, a
    // filter down to a handful of rows and back out left a stale window
    // with no bottom spacer — the page could not scroll, so no scroll
    // event could fire, and the rest of the list was unreachable for
    // good. Deriving the window in render is what makes this pass.
    await page.goto(`/projects/${big.key}/backlog?hideDone=true&priority=URGENT`);
    await expect(page.locator('[data-variant="filtered"]')).toBeVisible();
    await expect(page.locator('[data-testid="backlog-row"]')).toHaveCount(0);

    await page.getByTestId("backlog-filtered-clear").click();
    await expect(page.locator('[data-testid="backlog-row"]').first()).toBeVisible();
    // Full height again, and the far end still reachable. Asserted on
    // POSITION rather than on a title: `aria-rowindex` is the row's place
    // in the WHOLE list (set only while windowed), so this cannot be
    // broken by a sibling test renaming something, and it checks the
    // windowing metadata at the same time.
    // ARIA counts the header as row 1, so the last task of 250 is 251.
    await scrollToEndUntil(page, page.locator(`[data-testid="backlog-row"][aria-rowindex="${SIZE + 1}"]`));
  });

  test("`J` walks past the window's edge: each next row is mounted as focus reaches it, and the window follows", async ({ page }) => {
    // The window is the viewport (~20 rows at 720px) plus eight of
    // overscan each side, so the first row is released once focus has
    // pushed the viewport ~9 rows in, around step 30; 40 leaves a margin
    // over that at every configured device. Each `focus()` scroll pulls
    // the window down behind the focus, and the overscan (or, if a scroll
    // event were ever dropped, the focus pin) has the next row mounted
    // before the next press. A press is asserted before the next: React
    // commits a discrete event synchronously, but a press that raced a
    // commit would land on the row it had just left and walk one short.
    const STEPS = 40;
    await page.goto(`/projects/${big.key}/backlog`);
    const rows = backlogRows(page);
    await expect(rows.first()).toBeVisible();
    const focused = focusedBacklogRow(page);
    const link = keyLink(rows.first(), big.key);

    // The header is ARIA row 1 and the first task row 2, so the first
    // press lands on 3.
    await pressUntil(page, "j", focused, { from: link });
    await expect(focused).toHaveAttribute("aria-rowindex", "3");
    for (let i = 1; i < STEPS; i++) {
      await page.keyboard.press("j");
      await expect(focused).toHaveAttribute("aria-rowindex", String(3 + i));
    }
    // The window came along: the first row is released (which is also
    // what the top spacer's presence would say), the focused row is on
    // screen, and `X` has a subject there — then put it back.
    await expect(page.locator('[data-testid="backlog-row"]', { hasText: "Row 0001" })).toHaveCount(0);
    await expect(focused).toBeInViewport();
    await page.keyboard.press("x");
    await expect(page.getByTestId("bulk-count")).toContainText("1");
    await page.keyboard.press("x");
    await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  });
});

test.describe("project board (employee)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill(seed.employeeEmail);
    await page.locator("#password").fill(seed.employeePassword);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("**/home", { timeout: 30_000 });
  });

  test("the approval gate (2W-R): Done offers a non-approver neither a create field nor a picker target", async ({ page }) => {
    await page.goto(`/projects/${seed.projectKey}/board`);
    await expect(page.getByTestId("board")).toBeVisible();
    const done = column(page, "DONE");
    await expect(done).toBeVisible();
    // The employee can create — but not into the gated column.
    await expect(column(page, "TODO").getByTestId("board-create")).toBeVisible();
    await expect(done.getByTestId("board-create")).toHaveCount(0);
    // The keyboard twin agrees: `S` offers In review, never Done.
    const anyCard = page.locator('[data-testid="board-card"]').first();
    await anyCard.focus();
    await page.keyboard.press("s");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("move-top-IN_PROGRESS").first()).toBeVisible();
    await expect(dialog.getByTestId("move-top-DONE")).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("the item page obeys scope: the assigned project's item renders, and everything else is the same 404", async ({ page }) => {
    // Control first, so the denials below are scoping and not a broken page.
    await page.goto(`/projects/${seed.projectKey}/items/1`);
    await expect(page.getByTestId("item-properties")).toBeVisible();
    // An item of a project this employee is not assigned to…
    await page.goto(`/projects/${seed.completedProjectKey}/items/1`);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(page.getByTestId("item-properties")).toHaveCount(0);
    // …and a number that exists nowhere answer identically (AUTHZ §4).
    await page.goto(`/projects/${seed.projectKey}/items/999999`);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });

  test("a project outside the employee's scope has no board — the in-shell 404, not a forbidden screen", async ({ page }) => {
    await page.goto(`/projects/${seed.completedProjectKey}/board`);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(page.getByTestId("board")).toHaveCount(0);
    // The freshness poll carries no content, and it denies exactly the way
    // the page does (AUTHZ.md §4): a project in scope answers with one
    // opaque token; a project that is NOT this member's and a project that
    // does not exist answer identically, so the poll cannot be used to ask
    // whether a project exists. Probed from inside the page — Playwright's
    // Node-side request does not carry the Secure member cookie over
    // http://127.0.0.1.
    const probe = async (projectId: string) =>
      page.evaluate(async (id: string) => {
        const res = await fetch(`/api/version?scope=project:${id}`, { cache: "no-store" });
        return { status: res.status, body: await res.text() };
      }, projectId);

    const mine = await probe(seed.projectId);
    expect(mine.status).toBe(200);
    expect(typeof (JSON.parse(mine.body) as { version?: string }).version).toBe("string");

    const notMine = await probe(seed.completedProjectId);
    const missing = await probe("00000000-0000-4000-8000-000000000000");
    expect(notMine.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(notMine.body).toBe(missing.body);
    expect(notMine.body).not.toContain(seed.completedProjectId);
  });
});
