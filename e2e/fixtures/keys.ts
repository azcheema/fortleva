import { expect, type Locator, type Page } from "@playwright/test";

import type { E2ESeed } from "./tenant";

/**
 * Shared browser helpers for the keyboard and property-picker specs
 * (`keymap.spec.ts`, `item-properties.spec.ts`).
 *
 * The task helpers exist so no spec ever drives the SEEDED fixture's
 * tasks: a mutated seeded card lands in a different column for every
 * later spec — including the visual sweep, which photographs this very
 * project and would bake the change into 192 new shots without failing
 * anything.
 */

/** A server action plus a refresh; on CI the same waits get three times the leash. */
export const SLOW = process.env["CI"] ? 3 : 1;

/** The open property picker — or, for the calendar, the popover it lives in. */
export const picker = (page: Page): Locator => page.locator('[data-slot="popover-content"]');

/** The backlog's item rows (never its group headers or the create row). */
export const backlogRows = (page: Page): Locator => page.locator('[data-testid="backlog-row"]');

/** The item row that holds DOM focus itself — the subject of `J K` and `X`. */
export const focusedBacklogRow = (page: Page): Locator =>
  page.locator('[data-testid="backlog-row"]:focus');

/** A backlog row's key link ("ACME-12"), the one control every row has at rest. */
export const keyLink = (row: Locator, projectKey: string): Locator =>
  row.getByRole("link", { name: new RegExp(`^${projectKey}-\\d+$`) });

/** The `?` overlay's section for one scope, by its heading. */
export const overlaySection = (page: Page, name: string): Locator =>
  page
    .getByRole("dialog", { name: /shortcut/i })
    .locator("section")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });

/**
 * Press a key until it takes, then stop.
 *
 * `useScopeKeys` registers in an EFFECT, so a keypress fired the instant
 * a surface finishes rendering can land before that surface's keys
 * exist — on CI, where hydration is slower than the keystroke, this was
 * the difference between green and flaky (run 34713766519). The guard
 * matters as much as the retry: `?` toggles and `c` types into the field
 * it opened, so pressing blindly a second time would undo the first.
 *
 * It still fails if the binding is genuinely dead — it just stops
 * calling a race a regression.
 *
 * `from` is for a key that ACTIVATES a focused control rather than a
 * registry binding (Enter on a button whose handler hydration attaches):
 * it is focused before every press, so each press lands on that control
 * whatever happened to focus since the last one.
 */
export async function pressUntil(
  page: Page,
  key: string,
  target: Locator,
  opts: { from?: Locator } = {},
): Promise<void> {
  await expect(async () => {
    if ((await target.count()) === 0) {
      if (opts.from) await opts.from.focus();
      await page.keyboard.press(key);
    }
    await expect(target.first()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

/** Open one of the test's own tasks in the backlog peek, through its key link. */
export async function openOwnTaskPeek(page: Page, seed: E2ESeed, title: string): Promise<void> {
  const row = page.locator('[data-slot="table-row"]', { hasText: title });
  await expect(row).toBeVisible({ timeout: 20_000 * SLOW });
  await keyLink(row, seed.projectKey).click();
  await expect(page.getByTestId("item-peek")).toBeVisible();
}

/** A task a test created: its title, its human key ("ACME-12") and its number. */
export type OwnTask = { title: string; key: string; number: number };

/**
 * Create a task of the test's own through the backlog's create row and
 * open its peek. The title is recorded in `created` BEFORE the first
 * browser step, so an `afterEach` removes it even when creation fails
 * half-way. The key and number are read off the peek's URL here, once,
 * beside the navigation that produced it — the peek IS its URL
 * (`?item=KEY-N`), so a spec that needs to reopen the task elsewhere,
 * or address it in the database, never scrapes the URL itself.
 */
export async function createOwnTask(
  page: Page,
  seed: E2ESeed,
  prefix: string,
  created: string[],
): Promise<OwnTask> {
  const title = `${prefix} ${Date.now()}`;
  created.push(title);
  await page.goto(`/projects/${seed.projectKey}/backlog`);
  // The backlog's create row: at rest a button, then a field (work.spec).
  await page.locator("#new-task").getByRole("button").click();
  const createInput = page.locator("#new-task input");
  await createInput.fill(title);
  await createInput.press("Enter");
  await expect(page.locator('[data-slot="table-row"]', { hasText: title })).toBeVisible({
    timeout: 20_000 * SLOW,
  });
  await createInput.press("Escape");
  await openOwnTaskPeek(page, seed, title);
  await expect(page).toHaveURL(/[?&]item=/);
  const key = new URL(page.url()).searchParams.get("item") ?? "";
  expect(key).toMatch(/^[A-Za-z][A-Za-z0-9]*-\d+$/);
  return { title, key, number: Number(key.slice(key.lastIndexOf("-") + 1)) };
}

/**
 * Delete the given tasks through the row menu, pass or fail. Archived
 * rows are not on the board, so the sweep runs with the backlog's
 * archived view open — every task a test made is reachable there
 * whatever state it was left in.
 */
export async function deleteOwnTasks(page: Page, seed: E2ESeed, titles: readonly string[]): Promise<void> {
  for (const title of titles) {
    await page.goto(`/projects/${seed.projectKey}/backlog?archived=1`);
    const row = page.locator('[data-slot="table-row"]', { hasText: title });
    if ((await row.count()) === 0) continue;
    await row.first().getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Yes" }).click();
    await expect(page.locator('[data-slot="table-row"]', { hasText: title })).toHaveCount(0, {
      timeout: 20_000 * SLOW,
    });
  }
}
