import { expect, test, type Locator, type Page } from "@playwright/test";

import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * THE KEYBOARD, IN A REAL BROWSER (UI.md §6, §5.2).
 *
 * Everything here exists because a browser is the only instrument that
 * can see it. The unit suite owns the precedence table (`decide()` is
 * pure, and this repo's vitest has no jsdom), but four things in this
 * slice live in the wire between libraries and are invisible to both
 * code reading and a table test:
 *
 *  · the Escape LADDER — Radix's dismissable-layer stack deciding that
 *    the picker is above the peek;
 *  · `RemoveScroll` — whether a popover's list can be wheel-scrolled
 *    inside a sheet that has locked scrolling with `shards`;
 *  · `defaultPrevented` — cmdk preventing arrows and Enter without ever
 *    stopping propagation, while a window listener sits above it;
 *  · focus — where it is when a layer opens, closes, or hands over.
 *
 * Slice 4 learned this the expensive way: 78 review agents missed a bug
 * that one browser found in a minute.
 *
 * Everything runs inside the throwaway `e2e-` tenant. Only the State
 * picker's own describe block mutates anything, and it creates and
 * removes the single task it drives — the rest of this file reads.
 */

let seed!: E2ESeed;

const SLOW = process.env["CI"] ? 3 : 1;

test.beforeAll(() => {
  seed = requireSeed();
});

/** Open the first board card's peek through its row menu (no `?item=` guessing). */
async function openFirstPeek(page: Page): Promise<void> {
  await page.goto(`/projects/${seed.projectKey}/board?group=assignee`);
  await expect(page.getByTestId("board")).toBeVisible();
  const card = page.locator('[data-testid="board-card"]').first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: /Open/ }).click();
  await expect(page.getByTestId("item-peek")).toBeVisible();
}

const picker = (page: Page) => page.locator('[data-slot="popover-content"]');

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
 */
async function pressUntil(page: Page, key: string, target: Locator): Promise<void> {
  await expect(async () => {
    if ((await target.count()) === 0) await page.keyboard.press(key);
    await expect(target.first()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

test.describe("the scope registry", () => {
  test("`G S` navigates even with the item scope's bare `S` mounted — and then `S` opens the picker", async ({
    page,
  }) => {
    // THE collision this whole design exists to dissolve: `G S` (go to
    // Search) and item-scope `S` (the State picker) are not two
    // meanings of one key, they are two events in time.
    await openFirstPeek(page);

    await page.keyboard.press("g");
    await page.keyboard.press("s");
    await page.waitForURL("**/search", { timeout: 20_000 * SLOW });
    await expect(picker(page)).toHaveCount(0);

    await openFirstPeek(page);
    await page.keyboard.press("s");
    await expect(picker(page)).toBeVisible();
    // Focus lands in the search field, which is also what deadens every
    // other single key while the picker is open. Scoped to the picker:
    // the palette renders a command-input too.
    await expect(picker(page).locator('[data-slot="command-input"]')).toBeFocused();
  });

  test("the Escape ladder: the picker first, the peek second", async ({ page }) => {
    // The slice's own Escape contract, and there is no hand-written
    // handler behind it: Radix dismisses the highest layer, which is the
    // picker, and the peek beneath it survives untouched.
    await openFirstPeek(page);
    await page.keyboard.press("s");
    await expect(picker(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(picker(page)).toHaveCount(0);
    await expect(page.getByTestId("item-peek")).toBeVisible();
    await expect(page).toHaveURL(/item=/);

    // Focus is back on the trigger — which is why it must be a real
    // <button> — so the key reopens the picker rather than doing nothing.
    await expect(page.getByTestId("item-state")).toBeFocused();
    await page.keyboard.press("s");
    await expect(picker(page)).toBeVisible();

    // The second rung. Closing the peek is a server navigation
    // (`PeekShell` pushes the list URL), so it takes seconds, not
    // frames — poll for it. A fixed wait here reads as "Escape is
    // broken on the board", which is precisely the false conclusion an
    // earlier diagnostic of mine drew from a 1.5 s sleep.
    await page.keyboard.press("Escape");
    await expect(picker(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("item-peek")).toHaveCount(0, { timeout: 30_000 * SLOW });
    await expect(page).not.toHaveURL(/item=/);
    await expect(page).toHaveURL(/group=assignee/);
  });

  test("the same ladder on the backlog peek, which is a different mount", async ({ page }) => {
    // The board's peek and the backlog's are two mounts of one panel;
    // the ladder is asserted on both so a change to either surface's
    // layering cannot pass on the strength of the other.
    await page.goto(`/projects/${seed.projectKey}/backlog`);
    // The key cell is the link (2W-B). Located on the page rather than
    // inside "the first row", which need not be an item row.
    const keyLink = page
      .getByRole("link", { name: new RegExp(`^${seed.projectKey}-\\d+$`) })
      .first();
    await expect(keyLink).toBeVisible();
    await keyLink.click();
    await expect(page.getByTestId("item-peek")).toBeVisible();

    await page.keyboard.press("s");
    await expect(picker(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker(page)).toHaveCount(0);
    await expect(page.getByTestId("item-peek")).toBeVisible();

    await page.keyboard.press("Escape");
    // A server navigation, as above — poll, do not sleep.
    await expect(page.getByTestId("item-peek")).toHaveCount(0, { timeout: 30_000 * SLOW });
    await expect(page).not.toHaveURL(/item=/);
  });

  test("the picker's list can be WHEEL-scrolled inside the peek", async ({ page }) => {
    // The sheet's overlay mounts RemoveScroll with `shards:[content]`,
    // which preventDefaults every wheel event outside the lock. A
    // NON-modal popover inside it would have a list a mouse could not
    // reach. This is the one claim in the slice that cannot be settled
    // by reading source.
    await openFirstPeek(page);
    await page.keyboard.press("s");
    const list = page.locator('[data-slot="command-list"]');
    await expect(list).toBeVisible();

    const scrollable = await list.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    test.skip(!scrollable, "this project's state list fits — nothing to scroll");
    await list.hover();
    await page.mouse.wheel(0, 300);
    await expect
      .poll(() => list.evaluate((el) => el.scrollTop), { timeout: 5_000 })
      .toBeGreaterThan(0);
  });

  test("a key does not leak through an open menu", async ({ page }) => {
    // Radix traps FOCUS, not events, so before the registry a window
    // listener still fired behind an open menu — pressing `t` with a
    // RowActions menu open stopped the running timer. The suppression
    // is target-based: the menu item IS the event target.
    await page.goto(`/projects/${seed.projectKey}/board`);
    await expect(page.getByTestId("board")).toBeVisible();
    const card = page.locator('[data-testid="board-card"]').first();
    await card.getByRole("button", { name: /Actions for/ }).click();
    await expect(page.getByRole("menu")).toBeVisible();

    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: /shortcut/i })).toHaveCount(0);
  });

  test("the board's own keys survive the migration off a capture-phase listener", async ({
    page,
  }) => {
    await page.goto(`/projects/${seed.projectKey}/board`);
    await expect(page.getByTestId("board")).toBeVisible();

    // `C` still creates in context.
    await pressUntil(page, "c", page.getByTestId("board-create-input"));
    await expect(page.getByTestId("board-create-input").first()).toBeFocused();
    await page.keyboard.press("Escape");

    // `G C` still navigates — the sequence the deleted capture phase existed for.
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    await page.waitForURL("**/clients", { timeout: 20_000 * SLOW });

    // `C` with the peek open creates nothing behind the scrim.
    await openFirstPeek(page);
    await page.keyboard.press("c");
    await expect(page.getByTestId("board-create-input")).toHaveCount(0);
  });

  test("single keys stay inert inside the description editor", async ({ page }) => {
    await openFirstPeek(page);
    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toBeVisible({ timeout: 20_000 * SLOW });
    await editor.click();
    await page.keyboard.press("s");
    await expect(picker(page)).toHaveCount(0);
    await expect(editor).toContainText("s");
    // Leave the description as it was — the editor autosaves on a debounce.
    await page.keyboard.press("Backspace");
  });
});

test.describe("the `?` overlay and the palette", () => {
  test("is scope-aware, toggles, and owns the keyboard while open", async ({ page }) => {
    await page.goto(`/projects/${seed.projectKey}/board`);
    await expect(page.getByTestId("board")).toBeVisible();

    // The BOARD section only exists once the board's scope has
    // registered, so this press races hydration exactly as `c` does.
    const overlay = page.getByRole("dialog", { name: /shortcut/i });
    await pressUntil(page, "?", overlay);
    // The board section, with keys that used to ship un-advertised.
    await expect(overlay.getByRole("heading", { name: "Board", exact: true })).toBeVisible();

    // Exclusive: nothing beneath the overlay fires.
    await page.keyboard.press("c");
    await expect(page.getByTestId("board-create-input")).toHaveCount(0);

    // `?` TOGGLES now — it could only ever open the overlay before.
    await page.keyboard.press("?");
    await expect(overlay).toHaveCount(0);

    // Not on a surface that has no board scope.
    await page.goto("/home");
    const home = page.getByRole("dialog", { name: /shortcut/i });
    await pressUntil(page, "?", home);
    await expect(home.getByRole("heading", { name: "Board", exact: true })).toHaveCount(0);
  });

  test("rule 7: a single key also has a ⌘K entry, and choosing it does what the key does", async ({
    page,
  }) => {
    await openFirstPeek(page);
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: /command palette/i });
    await expect(palette).toBeVisible();
    await expect(palette.getByText("On this page")).toBeVisible();
    await palette.getByRole("option", { name: /Change state/ }).click();
    await expect(palette).toHaveCount(0);
    await expect(picker(page)).toBeVisible();
    await expect(picker(page).locator('[data-slot="command-input"]')).toBeFocused();
  });
});

test.describe("the State picker (owner)", () => {
  // This spec creates the ONE task it mutates, and removes it pass or
  // fail. The rest of the file only reads. Driving the picker against
  // the seeded fixture's first card would leave it in a different column
  // for every later spec — including the visual sweep, which
  // photographs this very project and would simply bake the moved card
  // into 192 new shots without failing anything.
  let created: string[] = [];

  test.afterEach(async ({ page }) => {
    const titles = created;
    created = [];
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
  });

  test("commits from the peek and from the full page, and survives a reload", async ({ page }) => {
    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const title = `Keymap picker ${Date.now()}`;
    created.push(title);
    // The backlog's create row: at rest a button, then a field (work.spec).
    await page.locator("#new-task").getByRole("button").click();
    const createInput = page.locator("#new-task input");
    await createInput.fill(title);
    await createInput.press("Enter");
    const row = page.locator('[data-slot="table-row"]', { hasText: title });
    await expect(row).toBeVisible({ timeout: 20_000 * SLOW });
    await createInput.press("Escape");
    await row.getByRole("link", { name: new RegExp(`^${seed.projectKey}-\\d+$`) }).click();
    await expect(page.getByTestId("item-peek")).toBeVisible();

    const rail = page.getByTestId("item-properties");
    const before = (await rail.getByTestId("item-state").textContent())?.trim() ?? "";

    await page.keyboard.press("s");
    await expect(picker(page)).toBeVisible();
    // `.last()` of the IN_PROGRESS category is "In review" by rank — the
    // seed has TWO states in that category, so the category-keyed test id
    // is not unique (the same property `MovePicker` carries, recorded as
    // a slice-6 follow-up). It is never the default and never gated.
    await picker(page).getByTestId("item-state-IN_PROGRESS").last().click();
    await expect(picker(page)).toHaveCount(0);

    // AWAIT the server-derived text before navigating — a reload that
    // races the POST is the exact failure the grooming slice shipped.
    await expect(rail.getByTestId("item-state")).not.toHaveText(before, {
      timeout: 20_000 * SLOW,
    });
    const after = (await rail.getByTestId("item-state").textContent())?.trim() ?? "";

    await page.reload();
    await expect(page.getByTestId("item-properties").getByTestId("item-state")).toHaveText(after);

    // The same control on the full page, which has no poll and no list.
    await page.getByTestId("item-full-page").click();
    await page.waitForURL(/\/items\/\d+$/, { timeout: 20_000 * SLOW });
    // The trigger being present is the sync point: `useScopeKeys`
    // registers in an effect, so a keypress fired the instant the URL
    // settles can land before the island has hydrated.
    await expect(page.getByTestId("item-state")).toBeVisible();
    await page.keyboard.press("s");
    await expect(picker(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker(page)).toHaveCount(0);
  });
});

test.describe("the State picker (employee)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("no approval, no gated target — and the current state is still shown", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill(seed.employeeEmail);
    await page.locator("#password").fill(seed.employeePassword);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("**/home", { timeout: 30_000 });

    await openFirstPeek(page);
    await page.keyboard.press("s");
    await expect(picker(page)).toBeVisible();
    // The seeded Done carries requiresApproval, and an employee holds no
    // work_item:approve — `enterableStates` keeps it out of the list.
    await expect(picker(page).getByTestId("item-state-DONE")).toHaveCount(0);
    // …while the states they CAN reach are there.
    await expect(picker(page).getByTestId("item-state-TODO").first()).toBeVisible();
  });
});
