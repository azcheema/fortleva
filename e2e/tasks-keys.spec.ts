import { expect, test, type Locator, type Page } from "@playwright/test";

import { SLOW, createOwnTask, deleteOwnTasks, overlaySection, pressUntil } from "./fixtures/keys";
import { requireSeed, type E2ESeed } from "./fixtures/tenant";
import { acknowledgeNoticeIfShown, idlePill, keepAsStopped, listIdle, pill, stopIfRunning } from "./fixtures/timer";

/**
 * THE TASKS PAGE'S ROW KEYS, AND A REFUSAL IN THE ADDRESS (slice 137).
 *
 * `J K` walk the Tasks page's rows and `T` starts or stops the member's timer
 * on the focused row's task — Home's queue's verbs (`home-queue-verbs.spec.ts`,
 * which this follows). And `?error=` is a CODE the page looks up: a sentence
 * written into the address draws nothing, a code of ours draws its message —
 * in the task panel beside the list and on Files.
 *
 * In the SHARED workspace, unlike `tasks.spec.ts`: the timer test needs `/time`
 * and its staff notice, which only this workspace's harness prepares. The walk
 * reads the seeded rows and writes nothing; the timer test makes its own task.
 */

let seed!: E2ESeed;

test.beforeAll(() => {
  seed = requireSeed();
});

const WAIT = { timeout: 20_000 * SLOW };
const list = (page: Page): Locator => page.getByTestId("tasks-list");
const rows = (page: Page): Locator => list(page).getByTestId("tasks-row");
/** The row that holds focus. */
const focusedRow = (page: Page): Locator => list(page).locator('[data-testid="tasks-row"]:has(:focus)');

/** A start from a row may open the staff notice first: acknowledge it, and the start follows. */
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

test.describe("the Tasks page's row keys (owner)", () => {
  test("`J K` walk the rows from a row's link, the ends are the ends, a `J` from outside enters the list, and the overlay lists them under Tasks", async ({
    page,
  }) => {
    await page.goto(`/tasks?project=${seed.projectKey}`);
    await expect(rows(page).nth(1)).toBeVisible(WAIT);
    const firstLink = rows(page).first().getByRole("link");
    const secondLink = rows(page).nth(1).getByRole("link");
    await expect(firstLink).toHaveAttribute("aria-keyshortcuts", /^J K( T)?$/);

    // The handler is React's, attached at hydration, so the first press races it.
    await pressUntil(page, "j", rows(page).nth(1).locator(":focus"), { from: firstLink });
    await expect(secondLink).toBeFocused();
    await page.keyboard.press("k");
    await expect(firstLink).toBeFocused();
    await page.keyboard.press("k");
    await expect(firstLink).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(secondLink).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(firstLink).toBeFocused();
    // …and at the bottom `J` does nothing: it must not reach the registry's
    // entry `J`, which would jump to the first row on screen.
    const lastLink = rows(page).last().getByRole("link");
    await lastLink.focus();
    await page.keyboard.press("j");
    await expect(lastLink).toBeFocused();

    // From outside the list (focus on <body>, the page at its top) `J` enters it at the first row.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, 0);
    });
    await pressUntil(page, "j", focusedRow(page));
    await expect(firstLink).toBeFocused();

    const overlay = page.getByRole("dialog", { name: /shortcut/i });
    await page.keyboard.press("?");
    const navigate = overlaySection(page, "Tasks").locator("li", { hasText: "Move between tasks" });
    await expect(navigate.locator("kbd")).toHaveCount(2);
    await expect(overlaySection(page, "Tasks").locator("li", { hasText: "Start or stop a timer on the focused task" })).toBeVisible();
    await page.keyboard.press("?");
    await expect(overlay).toHaveCount(0);

    // Enter on a row opens its task beside the list; while it is open the
    // list's `J` is not the list's. Asked of the overlay, the live registry's
    // projection — a `J` pressed in the sheet would prove nothing, since the
    // sheet's focus trap pulls focus back from any row (the review's LOW-2).
    // It proves the `J` gate only: the panel's own `T` shadows the list's here
    // (the re-check's NIT-A), so the `T` gate rests on the backlog's precedent.
    await firstLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/[?&]item=/, WAIT);
    await expect(page.getByRole("dialog")).toBeVisible(WAIT);
    await pressUntil(page, "?", overlay);
    await expect(overlaySection(page, "Task")).toBeVisible();
    await expect(overlaySection(page, "Tasks")).toHaveCount(0);
    await page.keyboard.press("?");
    await expect(overlay).toHaveCount(0);
  });

  test("`T` on a focused row starts THAT task's timer, the row wears the glyph, a second `T` stops it, and with no row focused `T` is the global one", async ({
    page,
  }) => {
    const created: string[] = [];
    try {
      await page.goto("/time");
      await expect(page.getByRole("heading", { name: "My time" })).toBeVisible();
      await acknowledgeNoticeIfShown(page);
      await stopIfRunning(page);
      const task = await createOwnTask(page, seed, "E2E tasks timer", created);

      await page.goto(`/tasks?project=${seed.projectKey}`);
      const row = rows(page).filter({ hasText: task.title });
      await expect(row).toBeVisible(WAIT);
      // Wait for the list's `T` to be registered without pressing anything
      // that acts: the overlay is a projection of the live registry.
      const overlay = page.getByRole("dialog", { name: /shortcut/i });
      await pressUntil(page, "?", overlay);
      await expect(overlaySection(page, "Tasks").locator("li", { hasText: "Start or stop a timer on the focused task" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(overlay).toHaveCount(0);

      const link = row.getByRole("link");
      await expect(link).toHaveAttribute("aria-keyshortcuts", "J K T");
      await link.focus();
      await page.keyboard.press("t");
      await startedOrNotice(page, task.title);
      await expect(row.getByTestId("tasks-row-timer")).toBeVisible();
      await expect(page.getByTestId("tasks-row-timer")).toHaveCount(1);
      // The link's name says the task first and its status after.
      await expect(link).toHaveAccessibleName(new RegExp(`^${task.key} ${task.title} Your timer is running on this task `));
      // Starting is not navigating: no peek opened, focus stays on the row.
      await expect(page).not.toHaveURL(/[?&]item=/);
      await expect(link).toBeFocused();

      await listIdle(page);
      await page.keyboard.press("t");
      await keepAsStopped(page);
      await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(row.getByTestId("tasks-row-timer")).toHaveCount(0);
      await expect(link).toBeFocused();

      // With no row focused, `T` is the global one: no timer runs, so it goes to /time.
      await listIdle(page);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("t");
      await expect(page).toHaveURL(/\/time/, WAIT);
    } finally {
      await page.goto("/time");
      await stopIfRunning(page);
      await deleteOwnTasks(page, seed, created);
    }
  });
});

test.describe("a refusal in the address is a code, never a sentence", () => {
  const sentence = "Your session expired. Sign in again at example.invalid";

  test("the task panel beside the list draws a code's message and nothing for a sentence", async ({ page }) => {
    const base = `/tasks?item=${seed.sharedTaskKey}`;
    await page.goto(`${base}&error=${encodeURIComponent(sentence)}`);
    // The panel is drawn — its Attachments card, under which the callout sits — and says nothing.
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Attachments" })).toBeVisible(WAIT);
    await expect(page.getByText(sentence)).toHaveCount(0);
    await expect(page.getByRole("dialog").locator('[data-slot="callout"][data-tone="danger"]')).toHaveCount(0);

    await page.goto(`${base}&error=files.notFound`);
    await expect(page.getByRole("dialog").locator('[data-slot="callout"][data-tone="danger"]').filter({ hasText: "File not found." })).toBeVisible(WAIT);
  });

  test("Files draws a code's message and nothing for a sentence or an inherited name", async ({ page }) => {
    const heading = page.getByRole("heading", { name: "Files", level: 1 });
    const callout = page.locator('[data-slot="callout"][data-tone="danger"]');
    await page.goto(`/files?error=${encodeURIComponent(sentence)}`);
    await expect(heading).toBeVisible(WAIT);
    await expect(page.getByText(sentence)).toHaveCount(0);
    await expect(callout).toHaveCount(0);

    // `constructor` is a name every object inherits — never one of our messages.
    await page.goto("/files?error=files.constructor");
    await expect(heading).toBeVisible(WAIT);
    await expect(callout).toHaveCount(0);

    await page.goto("/files?error=domain.SIGNOFF_ALREADY_REQUESTED");
    await expect(callout.filter({ hasText: "Sign-off has already been requested from the client." })).toBeVisible(WAIT);
  });
});
