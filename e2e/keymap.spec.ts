import { expect, test, type Page } from "@playwright/test";

import { SLOW, createOwnTask, deleteOwnTasks, picker, pressUntil } from "./fixtures/keys";
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
 * removes the single task it drives — the rest of this file reads. The
 * P, E and D pickers WRITE, so they live in `item-properties.spec.ts`.
 */

let seed!: E2ESeed;

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

test.describe("the backlog's `X`", () => {
  test("toggles the focused row's selection, is advertised, and types into a row's editor instead", async ({
    page,
  }) => {
    // Selecting writes nothing, so this reads the SEEDED rows and creates
    // none — and no bulk verb runs here (work.spec owns those).
    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const row = page.locator('[data-testid="backlog-row"]').first();
    await expect(row).toBeVisible({ timeout: 20_000 * SLOW });
    const link = row.getByRole("link", { name: new RegExp(`^${seed.projectKey}-\\d+$`) });
    const box = row.getByTestId("backlog-select-row");
    const checked = row.locator('[data-testid="backlog-select-row"][data-state="checked"]');

    // The handler is React's, attached at hydration, so the first press
    // races it exactly as a registry key does. The guard matters as much:
    // `X` TOGGLES, so a blind second press would undo the first.
    await pressUntil(page, "x", checked, { from: link });
    await expect(page.getByTestId("bulk-count")).toContainText("1");
    await expect(page.getByTestId("bulk-live")).toHaveText("1 task selected");
    // Selecting is not navigating: focus stays on the row.
    await expect(link).toBeFocused();

    // The overlay names it, under the backlog's own heading.
    const overlay = page.getByRole("dialog", { name: /shortcut/i });
    await page.keyboard.press("?");
    const section = overlay
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Backlog", exact: true }) });
    await expect(section.locator("li", { hasText: "Select or deselect task" }).locator("kbd")).toHaveText([
      "X",
    ]);
    await page.keyboard.press("?");
    await expect(overlay).toHaveCount(0);

    // Again, and the bar leaves with the selection.
    await link.focus();
    await page.keyboard.press("x");
    await expect(box).toHaveAttribute("data-state", "unchecked");
    await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
    // An emptied polite region is silent, so a member who empties the
    // selection is told so in words.
    await expect(page.getByTestId("bulk-live")).toHaveText("0 tasks selected");

    // The row's inline delete question renders IN the row, so `X` from its
    // Yes would find the row — and must not change the selection under an
    // open destructive question. Left with Escape: nothing here ever
    // clicks near Yes on a seeded task.
    await row.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const yes = row.getByRole("button", { name: "Yes" });
    await expect(yes).toBeVisible();
    await yes.focus();
    await page.keyboard.press("x");
    await expect(yes).toBeVisible();
    await expect(box).toHaveAttribute("data-state", "unchecked");
    await page.keyboard.press("Escape");
    await expect(yes).toHaveCount(0);

    // Inside a row's editor the key is the letter. The ESTIMATE cell, on
    // purpose: a stray commit there fails the parser and writes nothing,
    // where a title would rename a seeded task.
    await row.getByTestId("backlog-estimate").getByRole("button").click();
    const estimate = row.getByTestId("backlog-estimate").locator("input");
    await expect(estimate).toBeFocused();
    await page.keyboard.press("x");
    await expect(estimate).toHaveValue(/x$/);
    await expect(box).toHaveAttribute("data-state", "unchecked");
    await page.keyboard.press("Escape");
    await expect(estimate).toHaveCount(0);

    // Below `sm` the select column drops and a row has no selected cue of
    // its own, so `X` selects nothing and the overlay does not offer it.
    // The same key on the same row works again once the column is back —
    // the positive control that makes the absence mean the gate, not a
    // dead key.
    const overlayHeading = (name: string) => overlay.getByRole("heading", { name, exact: true });
    await page.setViewportSize({ width: 600, height: 900 });
    await expect(box).toBeHidden();
    await link.focus();
    await page.keyboard.press("x");
    await page.keyboard.press("?");
    // Presence first, in the same overlay, so the absence is not an
    // overlay that has not rendered its sections yet.
    await expect(overlayHeading("Global")).toBeVisible();
    await expect(overlayHeading("Backlog")).toHaveCount(0);
    await page.keyboard.press("?");
    await expect(overlay).toHaveCount(0);
    await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 720 });
    await link.focus();
    await page.keyboard.press("x");
    await expect(box).toHaveAttribute("data-state", "checked");
    await page.keyboard.press("x");
    await expect(box).toHaveAttribute("data-state", "unchecked");
    // …and the overlay offers it again: the media query reported the way
    // BACK, not only the way down.
    await page.keyboard.press("?");
    await expect(overlayHeading("Backlog")).toBeVisible();
    await page.keyboard.press("?");
    await expect(overlay).toHaveCount(0);

    // Under the peek focus is trapped in the sheet, so `X` cannot act —
    // and the overlay, which says what a key would do NOW, drops the row
    // while it lists the Task section.
    await link.click();
    await expect(page.getByTestId("item-peek")).toBeVisible();
    await pressUntil(page, "?", overlay);
    await expect(overlayHeading("Task")).toBeVisible();
    await expect(overlayHeading("Backlog")).toHaveCount(0);
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

  test("with the peek open, the Task section lists S A P E D V M L then ⌘⇧O, and J or K is spoken as such", async ({
    page,
  }) => {
    // Nine islands register the item scope's keys, and the overlay must
    // read them in the order the rail shows them — not backwards, which
    // is what a precedence-ordered walk alone would produce. The
    // description's `⌘⇧O` comes last because the description comes after
    // the rail, and it is the one row whose key is a CHORD: it is
    // registered `run: null` (ProseMirror owns the keystroke) purely so
    // the overlay can advertise it.
    await openFirstPeek(page);
    const overlay = page.getByRole("dialog", { name: /shortcut/i });
    await pressUntil(page, "?", overlay);
    const section = (name: string) =>
      overlay.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });

    // Presence first: the section is there before its rows are counted.
    await expect(section("Task")).toBeVisible();
    await expect(section("Task").locator("li > span:not([data-slot])")).toHaveText([
      "Change state",
      "Assign",
      "Change priority",
      "Set estimate",
      "Set due date",
      "Change visibility",
      "Set milestone",
      "Set labels",
      "Convert checklist item to subtask",
    ]);

    // The chord row prints three keys, the first of them the platform's
    // modifier — the registry holds ONE key per binding, so this is the
    // `hint` talking, not `b.key`.
    const convert = section("Task").locator("li", { hasText: "Convert checklist item" });
    await expect(convert.locator("kbd")).toHaveText([/Ctrl|⌘/, "Shift", "O"]);

    // `["J", "or", "K"]`: two keys and a separator whose word is there
    // for a screen reader, not a third key.
    const navigate = section("Board").locator("li", { hasText: "Move between cards" });
    await expect(navigate).toBeVisible();
    await expect(navigate.locator("kbd")).toHaveCount(2);
    await expect(navigate.locator('[data-slot="keyboard-hint"]')).toContainText("or");

    await page.keyboard.press("?");
    await expect(overlay).toHaveCount(0);
  });

  test("rule 7: a single key also has a ⌘K entry, and choosing it does what the key does", async ({
    page,
  }) => {
    await openFirstPeek(page);
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: /command palette/i });
    await expect(palette).toBeVisible();
    await expect(palette.getByText("On this page")).toBeVisible();
    // Every rail picker, not just the first one, arrives as a palette row
    // without being registered twice.
    for (const name of [
      /^Assign/,
      /Change priority/,
      /Set estimate/,
      /Set due date/,
      /Change visibility/,
      /Set milestone/,
      /Set labels/,
    ]) {
      await expect(palette.getByRole("option", { name })).toBeVisible();
    }
    await palette.getByRole("option", { name: /Change state/ }).click();
    await expect(palette).toHaveCount(0);
    await expect(picker(page)).toBeVisible();
    await expect(picker(page).locator('[data-slot="command-input"]')).toBeFocused();
  });

  test("Escape from the palette over Move to… hands focus back to the picker, and no key lands behind it", async ({
    page,
  }) => {
    // Neither dialog has a DialogTrigger, so Radix returned focus to
    // nothing and it fell to <body>, where every single key acts. The
    // board's `C` then opened a create field behind the modal. Ctrl+K
    // reaches the palette from inside the picker only because the
    // `Command` wrapper turns cmdk's vim bindings off. Nothing is moved:
    // the picker is closed with Escape.
    await page.goto(`/projects/${seed.projectKey}/board`);
    await expect(page.getByTestId("board")).toBeVisible();
    const firstCard = page.locator('[data-testid="board-card"]').first();
    await expect(firstCard).toBeVisible();
    const cardId = (await firstCard.getAttribute("data-board-card")) ?? "";
    expect(cardId).not.toBe("");
    const card = page.locator(`[data-board-card="${cardId}"]`);

    const movePicker = page.getByRole("dialog", { name: /^Move / });
    const moveInput = movePicker.locator('[data-slot="command-input"]');
    await card.focus();
    // `S` is the board's own handler on the focused card, which exists
    // only once the board has hydrated.
    await pressUntil(page, "s", movePicker);
    await expect(moveInput).toBeFocused();

    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: /command palette/i });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect(movePicker).toBeVisible();
    await expect(moveInput).toBeFocused();

    // The key lands in the picker's own field, which is the proof that
    // nothing behind the modal received it.
    await page.keyboard.press("c");
    await expect(moveInput).toHaveValue("c");
    await expect(page.getByTestId("board-create-input")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(movePicker).toHaveCount(0);
    await expect(card).toBeFocused();
  });
});

test.describe("focus goes back where it came from", () => {
  // Radix returns focus to a dialog's TRIGGER. These dialogs have none, so
  // without `useFocusReturn` each one dropped focus on <body>, where every
  // single key acts. Nothing here mutates anything.

  test("the phone's More sheet hands focus back to the More tab", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/home");
    const more = page.locator('[data-slot="tab-bar"]').getByRole("button", { name: "More", exact: true });
    const sheet = page.locator('[data-slot="sheet-content"]');
    await expect(more).toBeVisible();

    // The keyboard's way in: the tab focused, then Enter.
    await pressUntil(page, "Enter", sheet, { from: more });
    // Presence first: Radix has moved focus INTO the sheet, so the return
    // asserted below is the hook's doing, not focus that never left.
    await expect.poll(() => sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(more).toBeFocused();
  });

  test("closing the `?` overlay hands focus back to the help button and opens no tooltip", async ({ page }) => {
    await page.goto("/home");
    const url = page.url();
    const help = page.getByRole("button", { name: "Show keyboard shortcuts", exact: true });
    const overlay = page.getByRole("dialog", { name: /shortcut/i });
    const tooltip = page.locator('[data-slot="tooltip-content"]');
    await expect(help).toBeVisible();

    // The keyboard, not a click. A click also HOVERS the button, and a hover
    // opening the tooltip is correct behaviour this test must not mistake
    // for the defect.
    await pressUntil(page, "Enter", overlay, { from: help });
    await expect.poll(() => overlay.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    // Presence first: focus is back on the button. That return must not
    // open the tooltip. Radix opens one on any focus no pointer caused, and
    // its layer then took the member's next Escape.
    await expect(help).toBeFocused();
    await expect(tooltip).toHaveCount(0);

    // So the next Escape has nothing to close, and nothing else goes with it.
    // (The count below only catches a tooltip still open once the Escape has
    // been handled; one that opened late would take that Escape and close,
    // and pass everything here — the check above is the one that counts.)
    await page.keyboard.press("Escape");
    await expect(help).toBeFocused();
    await expect(page).toHaveURL(url);
    await expect(tooltip).toHaveCount(0);

    // The instrument works: a focus the member causes still opens the
    // tooltip. So the absence above was the guard working, not a tooltip
    // that never opens on focus.
    await help.evaluate((el) => (el as HTMLElement).blur());
    await help.focus();
    await expect(tooltip).toBeVisible();
  });

  test("⌘K over the open `?` overlay: Escape closes the palette and puts focus back INSIDE the overlay", async ({
    page,
  }) => {
    // A dialog opened over one that stays OPEN returns focus into it.
    // Inheriting the overlay's own origin instead would hand focus to
    // wherever the overlay came from (here <body>), behind a modal that is
    // still open.
    await page.goto("/home");
    const overlay = page.getByRole("dialog", { name: /shortcut/i });
    const palette = page.getByRole("dialog", { name: /command palette/i });
    const focusInOverlay = () => overlay.evaluate((el) => el.contains(document.activeElement));

    await pressUntil(page, "?", overlay);
    await expect.poll(focusInOverlay).toBe(true);

    // ⌘K is answered before any scope, the overlay's exclusive one included.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(palette).toBeVisible();
    await expect(palette.locator('[data-slot="command-input"]')).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    // One layer per Escape: the overlay is still open, and has the focus back.
    await expect(overlay).toBeVisible();
    await expect.poll(focusInOverlay).toBe(true);

    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
  });
});

test.describe("the State picker (owner)", () => {
  // This spec creates the ONE task it mutates, and removes it pass or
  // fail (`e2e/fixtures/keys.ts`). The rest of the file only reads.
  let created: string[] = [];

  test.afterEach(async ({ page }) => {
    const titles = created;
    created = [];
    await deleteOwnTasks(page, seed, titles);
  });

  test("commits from a typed filter and from a click, survives a reload, and opens on the full page", async ({
    page,
  }) => {
    await createOwnTask(page, seed, "Keymap picker", created);

    const rail = page.getByTestId("item-properties");
    const state = rail.getByTestId("item-state");
    const search = picker(page).locator('[data-slot="command-input"]');
    // The rail's live region speaks only once the server has answered, so
    // it is the sync point before the next step. The trigger is not: its
    // optimistic text is there before the POST has left, and a reload that
    // races the POST is the exact failure the grooming slice shipped.
    const said = (name: string) => rail.locator('[role="status"]', { hasText: `State changed to ${name}` });
    // "In review" and "In progress": the SECOND and FIRST states of the
    // IN_PROGRESS category by rank. The test id carries a per-category
    // ordinal over the project's full state list (`statePickerTargets`
    // numbers it before filtering), so each names one row whoever is
    // looking. Neither is ever the default, and neither is gated.
    const inReview = picker(page).getByTestId("item-state-IN_PROGRESS-2");
    const inProgress = picker(page).getByTestId("item-state-IN_PROGRESS-1");

    // TYPE, then Enter. A keystroke in the search field is steering, so
    // the one row the query leaves (lit by cmdk itself) is the member's
    // pick, and the Enter guard, which refuses a highlight nobody steered
    // to, must let it through.
    await pressUntil(page, "s", picker(page));
    await expect(search).toBeFocused();
    await expect(inReview).toBeVisible();
    // Names are read off the rows (an aria-hidden icon and the name; a row
    // that is not the current one carries no "(current)"), and the query is
    // the name's last word. The count below fails loudly if it matches more.
    const reviewName = ((await inReview.textContent()) ?? "").trim();
    expect(reviewName).not.toBe("");
    await page.keyboard.type(reviewName.split(/\s+/).at(-1) ?? reviewName);
    // Presence first: the row is lit, so the count runs against the
    // filtered list rather than one that has not re-rendered yet.
    await expect(inReview).toHaveAttribute("aria-selected", "true");
    await expect(picker(page).locator("[cmdk-item]")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(picker(page)).toHaveCount(0);
    await expect(said(reviewName)).toHaveCount(1, { timeout: 20_000 * SLOW });
    await expect(state).toHaveText(reviewName);

    // A CLICK, from the trigger Radix handed focus back to. A click is
    // aimed, so nothing stands in its way.
    await expect(state).toBeFocused();
    await page.keyboard.press("s");
    await expect(inProgress).toBeVisible();
    const progressName = ((await inProgress.textContent()) ?? "").trim();
    expect(progressName).not.toBe(reviewName);
    await inProgress.click();
    await expect(picker(page)).toHaveCount(0);
    await expect(said(progressName)).toHaveCount(1, { timeout: 20_000 * SLOW });

    await page.reload();
    await expect(page.getByTestId("item-properties").getByTestId("item-state")).toHaveText(progressName, {
      timeout: 20_000 * SLOW,
    });

    // The same control on the full page, which has no poll and no list.
    await page.getByTestId("item-full-page").click();
    await page.waitForURL(/\/items\/\d+$/, { timeout: 20_000 * SLOW });
    // `useScopeKeys` registers in an effect, so a keypress fired the
    // instant the page renders can land before the island has hydrated.
    await expect(page.getByTestId("item-state")).toBeVisible();
    await pressUntil(page, "s", picker(page));
    await page.keyboard.press("Escape");
    await expect(picker(page)).toHaveCount(0);
  });
});

test.describe("the State picker (employee)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  /** The seeded task in the approval-gated Done (`e2e/fixtures/seed-cli.ts`). Read, never moved. */
  const GATED_DONE_TITLE = "Migrera DNS till ny leverantör";

  async function signInAsEmployee(page: Page): Promise<void> {
    await page.goto("/login");
    await page.locator("#email").fill(seed.employeeEmail);
    await page.locator("#password").fill(seed.employeePassword);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("**/home", { timeout: 30_000 });
  }

  test("no approval, no gated target", async ({ page }) => {
    await signInAsEmployee(page);

    await openFirstPeek(page);
    await pressUntil(page, "s", picker(page));
    // Presence FIRST: the states they CAN reach are there. An absence
    // assertion against a list that has not rendered yet passes vacuously.
    await expect(picker(page).getByTestId("item-state-TODO-1")).toBeVisible();
    // The seeded Done carries requiresApproval, and an employee holds no
    // work_item:approve — `statePickerTargets` keeps every DONE row out
    // unless the item is already there.
    await expect(picker(page).locator('[data-testid^="item-state-DONE-"]')).toHaveCount(0);
  });

  test("on a gated Done the current state is shown, disabled, and lights nothing for Enter to commit", async ({
    page,
  }) => {
    // The disabled current row is SEEDED as "no highlight". Seeding `""`
    // let cmdk light the first enabled row by itself, and a bare Enter
    // then reopened a Done task nobody chose to reopen. No Enter is ever
    // pressed here: a regression would move a SEEDED task, and the
    // visual sweep photographs this project.
    await signInAsEmployee(page);
    await page.goto(`/projects/${seed.projectKey}/board`);
    await expect(page.getByTestId("board")).toBeVisible();
    const card = page.locator('[data-testid="board-card"]', { hasText: GATED_DONE_TITLE });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: /Open/ }).click();
    await expect(page.getByTestId("item-peek")).toBeVisible();
    await expect(page.getByTestId("item-state")).toHaveText(/Done/);

    await pressUntil(page, "s", picker(page));
    const combobox = picker(page).locator('[data-slot="command-input"]');
    await expect(combobox).toBeFocused();

    // Presence first: the list is there, with the item's own state in it,
    // shown and refused.
    const done = picker(page).getByTestId("item-state-DONE-1");
    await expect(done).toBeVisible();
    await expect(done).toHaveAttribute("aria-disabled", "true");
    const firstEnabled = picker(page).getByTestId("item-state-BACKLOG-1");
    await expect(firstEnabled).toBeVisible();

    // Nothing lit, so nothing announced and nothing for Enter to dispatch.
    await expect(picker(page).locator('[cmdk-item][aria-selected="true"]')).toHaveCount(0);
    await expect(combobox).not.toHaveAttribute("aria-activedescendant");

    // The first ArrowDown walks from "no row" to the first ENABLED row,
    // and names it.
    await page.keyboard.press("ArrowDown");
    await expect(firstEnabled).toHaveAttribute("aria-selected", "true");
    const id = await firstEnabled.getAttribute("id");
    expect(id, "a cmdk row always carries an id").toBeTruthy();
    await expect(combobox).toHaveAttribute("aria-activedescendant", id ?? "");

    await page.keyboard.press("Escape");
    await expect(picker(page)).toHaveCount(0);
    await expect(page.getByTestId("item-state")).toHaveText(/Done/);
  });
});
