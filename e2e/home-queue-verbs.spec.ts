import { expect, test, type Locator, type Page } from "@playwright/test";

import { actionAnswered } from "./fixtures/actions";
import { createOwnTask, deleteOwnTasks, overlaySection, picker, pressUntil, rail, searchField } from "./fixtures/keys";
import { requireSeed, type E2ESeed } from "./fixtures/tenant";
import { acknowledgeNoticeIfShown, idlePill, keepAsStopped, listIdle, pill, stopIfRunning } from "./fixtures/timer";

/**
 * The `/home` queue's row verbs (UI.md rule 8, §6 `home`; slice 24):
 * `J K` roving focus between the rows, and `T` / the row's button
 * starting or stopping the member's timer on THAT task. The queue's
 * contents are `home.spec.ts`'s; this file only walks and presses.
 *
 * Its own file, not a describe in `home.spec.ts`: that spec resets the
 * fixture's notifications before every test, which this one has no use
 * for, and the timer tests here need `/time` — a page whose first visit
 * may show the staff notice — before the queue.
 */

let seed!: E2ESeed;

// A navigation to a task's peek compiles and renders the backlog; on CI
// (US runner, EU database) the same waits get three times the leash.
const SLOW = process.env["CI"] ? 3 : 1;

test.beforeAll(() => {
  seed = requireSeed();
});

const queue = (page: Page): Locator => page.getByTestId("home-queue");
const rows = (page: Page): Locator => queue(page).getByTestId("home-queue-row");
const rowOf = (page: Page, title: string): Locator => rows(page).filter({ hasText: title });
/** The row that holds focus — the link or the button inside it. */
const focusedRow = (page: Page): Locator =>
  queue(page).locator('[data-testid="home-queue-row"]:has(:focus)');

/**
 * Wait until the queue's `T` is registered, without pressing anything
 * that acts: the `?` overlay is a projection of the live key registry, so
 * once it lists the queue's timer row the list has hydrated (the
 * `time.spec.ts` rule — a `T` retried until something changes is unsafe
 * on a toggle).
 */
async function waitForQueueTimerKey(page: Page): Promise<void> {
  const overlay = page.getByRole("dialog", { name: /shortcut/i });
  await pressUntil(page, "?", overlay);
  await expect(overlaySection(page, "Home").locator("li", { hasText: "Start or stop a timer on the focused task" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
}

/**
 * A start from a TASK may open the staff notice in its own dialog
 * (`item-timer-notice`). The owner acknowledges the `/time` gate first,
 * so the branch is defensive — it covers a notice re-published between the
 * two: acknowledge it, and the start the member pressed for follows.
 */
async function startedOrNotice(page: Page, title: string): Promise<void> {
  const notice = page.getByTestId("item-timer-notice");
  const running = pill(page).filter({ hasText: title });
  await expect(notice.or(running)).toBeVisible({ timeout: 15_000 * SLOW });
  if (await notice.isVisible()) {
    await notice.getByTestId("item-timer-notice-acknowledge").click();
    await expect(notice).toHaveCount(0);
  }
  await expect(running).toBeVisible({ timeout: 15_000 * SLOW });
}

test.describe("the queue's row verbs (owner)", () => {
  test("`J K` walk the rows from a row's link, the ends are the ends, and the overlay lists them under Home", async ({ page }) => {
    // Reads the SEEDED rows and writes nothing.
    await page.goto("/home");
    await expect(queue(page)).toBeVisible();
    const first = rows(page).first();
    const firstLink = first.getByRole("link");
    // Rows are reachable by Tab through their link — the row IS its link,
    // so a queue of a hundred rows is a hundred stops, as any list of
    // links — and `J K` land on the link, so Enter opens the task from
    // wherever a `J` left the member.
    await expect(firstLink).toHaveAttribute("aria-keyshortcuts", /^J K( T)?$/);

    // From the first row's link, `J` lands on the second row's link. The
    // handler is React's, attached at hydration, so the first press races
    // it exactly as a registry key does.
    const second = rows(page).nth(1);
    await expect(second).toBeVisible();
    await pressUntil(page, "j", second.locator(":focus"), { from: firstLink });
    await expect(second.getByRole("link")).toBeFocused();

    // `K` walks back; at the top it does nothing, and focus stays put.
    await page.keyboard.press("k");
    await expect(firstLink).toBeFocused();
    await page.keyboard.press("k");
    await expect(firstLink).toBeFocused();
    // `↓ ↑` ON THE ROW are `J K`.
    await page.keyboard.press("ArrowDown");
    await expect(second.getByRole("link")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(firstLink).toBeFocused();
    // …and at the bottom `J` does nothing either — it must not reach the
    // registry's entry `J`, which would jump to the first row on screen.
    const lastLink = rows(page).last().getByRole("link");
    await lastLink.focus();
    await page.keyboard.press("j");
    await expect(lastLink).toBeFocused();

    // A `J` from OUTSIDE the list (focus on <body>) enters it at the first
    // row ON SCREEN — the registry's `J`, whose run is the entry. From the
    // top of the page, so that row is the first row: focusing the last link
    // above may have scrolled the top rows under the sticky header, where
    // the entry rightly skips them (review, slice 24).
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, 0);
    });
    await pressUntil(page, "j", focusedRow(page));
    await expect(firstLink).toBeFocused();

    // The overlay names both under the queue's own heading, `J K` with
    // two keys and a separator whose word is there for a screen reader;
    // the global `T` is still listed beneath the row's — a focus-handled
    // row hides nothing.
    const overlay = page.getByRole("dialog", { name: /shortcut/i });
    await page.keyboard.press("?");
    const navigate = overlaySection(page, "Home").locator("li", { hasText: "Move between tasks" });
    await expect(navigate.locator("kbd")).toHaveCount(2);
    await expect(navigate.locator('[data-slot="keyboard-hint"]')).toContainText("or");
    await expect(overlaySection(page, "Home").locator("li", { hasText: "Start or stop a timer on the focused task" })).toBeVisible();
    await expect(overlaySection(page, "Global").locator("li", { hasText: "Start or stop the timer" })).toBeVisible();
    await page.keyboard.press("?");
    await expect(overlay).toHaveCount(0);
  });

  test("`T` on a focused row starts THAT task's timer while another runs — never the global `T`'s stop — the row wears the badge and its button turns to Stop; the button stops through the confirm and starts again by click; a second `T` stops it with focus coming back; with no row focused `T` is the global one", async ({
    page,
  }) => {
    const created: string[] = [];
    try {
      await page.goto("/time");
      await expect(page.getByRole("heading", { name: "My time" })).toBeVisible();
      await acknowledgeNoticeIfShown(page);
      await stopIfRunning(page);
      // A timer running ELSEWHERE first. The global `T` would STOP it, so a
      // row that failed to claim the key would leave the pill idle — or
      // stopped and restarted — instead of on the row's task.
      await page.getByTestId("quick-start-description").fill("E2E before the queue");
      await page.getByTestId("quick-start-start").click();
      await expect(pill(page)).toContainText("E2E before the queue", { timeout: 15_000 * SLOW });

      // The queue lists ASSIGNED tasks: the test's own task, assigned to
      // the owner through the peek's `A` picker, so no seeded task gains
      // a time entry.
      const task = await createOwnTask(page, seed, "E2E queue timer", created);
      await pressUntil(page, "a", picker(page));
      await expect(searchField(page)).toBeFocused();
      await page.keyboard.type("Owner");
      const ownerRow = picker(page).getByRole("option", { name: /E2E Owner/ });
      await expect(ownerRow).toHaveAttribute("aria-selected", "true");
      // The SERVER's answer, not the optimistic value: a navigation the
      // instant the rail showed "E2E Owner" aborted the assignment's POST,
      // and the queue rendered without the task (the first run of this).
      const assigned = actionAnswered(page, { contains: "memberId" });
      await page.keyboard.press("Enter");
      await expect(picker(page)).toHaveCount(0);
      await assigned;
      await expect(rail(page).getByTestId("item-assignee").locator("[data-value]")).toHaveText("E2E Owner", {
        timeout: 20_000 * SLOW,
      });

      await page.goto("/home");
      const row = rowOf(page, task.title);
      await expect(row).toBeVisible({ timeout: 20_000 * SLOW });
      await waitForQueueTimerKey(page);
      const link = row.getByRole("link");
      const start = row.getByTestId("home-queue-row-start");
      const stop = row.getByTestId("home-queue-row-stop");
      await expect(start).toHaveAccessibleName(`Start a timer on ${task.title}`);
      await expect(link).toHaveAttribute("aria-keyshortcuts", "J K T");

      // ── `T` on the focused row ──
      await link.focus();
      await page.keyboard.press("t");
      await startedOrNotice(page, task.title);
      // The start stopped the other timer in the same transaction, so the toast offers Undo.
      await expect(page.getByText(/"E2E before the queue" was stopped/)).toBeVisible();
      await expect(row.getByTestId("home-queue-row-timer")).toBeVisible();
      await expect(page.getByTestId("home-queue-row-timer")).toHaveCount(1);
      // The link's NAME says the task first and its status after — measured
      // in the browser, never traced: a titled glyph with no text is named
      // by its `title`, at its DOM position before the title (fix review).
      await expect(link).toHaveAccessibleName(new RegExp(`^${task.key} ${task.title} Your timer is running on this task `));
      await expect(stop).toBeVisible();
      await expect(stop).toHaveAccessibleName(`Stop the timer on ${task.title}`);
      await expect(page).toHaveURL(/\/home$/);
      // Starting is not navigating: focus stays on the row.
      await expect(link).toBeFocused();

      // ── the button: stop, then start again ──
      await listIdle(page);
      await stop.click();
      await keepAsStopped(page);
      await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(row.getByTestId("home-queue-row-timer")).toHaveCount(0);
      await expect(start).toBeVisible();
      // The confirm hands focus back to the button it was opened from.
      await expect(start).toBeFocused();
      await listIdle(page);
      // No timer runs now, so a global `T` would NAVIGATE to /time: staying
      // on /home is the row's claim — by click here, by key below.
      await start.click();
      await startedOrNotice(page, task.title);
      await expect(stop).toBeVisible();
      await expect(page).toHaveURL(/\/home$/);

      // ── a second `T` stops it, and focus comes back to the link ──
      await link.focus();
      await listIdle(page);
      await page.keyboard.press("t");
      await keepAsStopped(page);
      await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(start).toBeVisible();
      await expect(link).toBeFocused();
      await expect(page).toHaveURL(/\/home$/);

      // ── with no row focused, `T` is the global one ──
      // The queue's `T` is `run: null`: it claims the key nowhere but in a
      // row. No timer runs, so the global `T` goes to /time's quick start.
      await listIdle(page);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("t");
      await expect(page).toHaveURL(/\/time/, { timeout: 20_000 * SLOW });
    } finally {
      await page.goto("/time");
      await stopIfRunning(page);
      await deleteOwnTasks(page, seed, created);
    }
  });
});
