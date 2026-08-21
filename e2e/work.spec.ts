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

// A move is a server action plus a refresh of the whole board; on CI
// (US runner, EU database) the same waits get three times the leash.
const SLOW = process.env["CI"] ? 3 : 1;

test.beforeAll(() => {
  seed = requireSeed();
});

const column = (page: Page, category: string): Locator =>
  page.locator(`[data-testid="board-column"][data-state-category="${category}"]`);
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

    // One list, two surfaces: the backlog row shows the same state — by
    // the tenant's own name for it (the e2e tenant is Swedish: "Klar"),
    // read from the column header rather than assumed.
    const doneName = (await done.locator("h3").textContent())?.trim() ?? "";
    expect(doneName).not.toBe("");
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

  test("a project outside the employee's scope has no board — the in-shell 404, not a forbidden screen", async ({ page }) => {
    await page.goto(`/projects/${seed.completedProjectKey}/board`);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(page.getByTestId("board")).toHaveCount(0);
    // The freshness poll carries no content: for a project in scope
    // (the assigned client's) it is one opaque string, never a list.
    // Probed from inside the page — Playwright's Node-side request does
    // not carry the Secure member cookie over http://127.0.0.1.
    const probe = await page.evaluate(async (projectId: string) => {
      const res = await fetch(`/api/version?scope=project:${projectId}`, { cache: "no-store" });
      return { status: res.status, body: (await res.json()) as { version?: string } };
    }, seed.projectId);
    expect(probe.status).toBe(200);
    expect(typeof probe.body.version).toBe("string");
  });
});
