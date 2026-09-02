import { expect, test, type Locator, type Page } from "@playwright/test";

import { requireSeed, type E2ESeed } from "./fixtures/tenant";

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
 * The title this run created, so teardown can remove it EVEN IF the test
 * failed — a failing run is exactly when a leftover row would poison the
 * project the visual sweep photographs.
 */
let created: string | null = null;

// A move is a server action plus a refresh of the whole board; on CI
// (US runner, EU database) the same waits get three times the leash.
const SLOW = process.env["CI"] ? 3 : 1;

test.beforeAll(() => {
  seed = requireSeed();
});

test.afterEach(async ({ page }) => {
  if (!created) return;
  const title = created;
  created = null;
  await page.goto(`/projects/${seed.projectKey}/board`);
  const card = cardIn(page, title);
  if ((await card.count()) === 0) return;
  await card.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Yes" }).click();
  await expect(cardIn(page, title)).toHaveCount(0, { timeout: 20_000 * SLOW });
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
    created = title; // afterEach removes it, pass or fail
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

    // Drag to In progress (Pragmatic: native HTML5 drag, desktop only).
    await card.dragTo(inProgress);
    await expect(cardIn(inProgress, title)).toBeVisible({ timeout: 20_000 * SLOW });
    await page.reload();
    await expect(cardIn(inProgress, title)).toBeVisible();
    await expect(cardIn(todo, title)).toHaveCount(0);

    // Keyboard twin: focus the card, S opens "Move to…", pick Top of Done.
    await cardIn(inProgress, title).focus();
    await page.keyboard.press("s");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("move-top-DONE").click();
    await expect(cardIn(done, title)).toBeVisible({ timeout: 20_000 * SLOW });
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
    created = title; // afterEach removes it via the board, pass or fail

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

    // Due date: the ISO value is locale-blind on both ends. The display
    // span appears only after the server round trip — the sync point
    // before any navigation (the priority step's indicator plays the
    // same role above).
    await row.getByTestId("backlog-due").getByRole("button").click();
    const dueInput = row.getByTestId("backlog-due").locator("input");
    await dueInput.fill("2026-09-15");
    await dueInput.press("Enter");
    await expect(row.getByTestId("backlog-due")).toContainText("2026", { timeout: 20_000 * SLOW });

    // Estimate: the pinned grammar — "90m" in, and the edit seed reads
    // back as the locale-blind "1h 30m" text (normalization proof).
    await row.getByTestId("backlog-estimate").getByRole("button").click();
    const estimateInput = row.getByTestId("backlog-estimate").locator("input");
    await estimateInput.fill("90m");
    await estimateInput.press("Enter");
    await expect(row.getByTestId("backlog-estimate")).toContainText("30", {
      timeout: 20_000 * SLOW,
    });

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
    created = title; // afterEach removes it via the board, pass or fail

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
    await grouped.getByRole("link", { name: new RegExp(`^${seed.projectKey}-\\d+$`) }).click();
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

  test("2W-F: the backlog reorders — by the row menu and by drag — and the order sticks", async ({ page }) => {
    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const title = `Reorder task ${Date.now()}`;
    created = title; // afterEach removes it via the board, pass or fail

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
    await page.getByRole("menuitem", { name: "Move to top" }).click();
    await expect
      .poll(async () => (await ids())[0], { timeout: 20_000 * SLOW })
      .toBe(mine);

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
    await page
      .locator(`[data-testid="backlog-row"][data-item-id="${mine}"]`)
      .dragTo(target, { targetPosition: { x: Math.round(box!.width / 2), y: box!.height - 2 } });
    await expect
      .poll(async () => (await ids()).at(-1), { timeout: 20_000 * SLOW })
      .toBe(mine);
    await page.reload();
    expect((await ids()).at(-1)).toBe(mine);
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
