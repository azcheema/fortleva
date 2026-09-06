import { expect, test } from "@playwright/test";

/**
 * The ⌘K command palette, opened — which nothing in the estate did
 * before this file.
 *
 * `CommandDialog` deliberately leaves cmdk's `<Command>` root to its
 * caller (the root owns `shouldFilter`, which both filters and re-sorts,
 * so the surface has to choose). Of its two callers, `MovePicker`
 * rendered one and `command-palette.tsx` did not — so the palette threw
 * `Cannot read properties of undefined (reading 'subscribe')` from
 * cmdk's `useSyncExternalStore` the instant it opened. It shipped that
 * way because `MovePicker` is the only `CommandDialog` any test had ever
 * opened (`e2e/work.spec.ts`), and that one works.
 *
 * UI.md rule 7 makes this load-bearing beyond itself: every single-key
 * binding owes a ⌘K entry, so the palette is the surface two other
 * slices deferred their hotkeys to.
 */
test("the ⌘K hotkey opens the palette, and it renders its items", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto("/home");
  // THE HOTKEY, not the header button. The binding carries live
  // conditions of its own — it ignores Alt, fires even inside inputs,
  // and TOGGLES rather than opens (src/components/shell/use-hotkeys.ts)
  // — and AGENTS.md already records one hotkey guard that regressed
  // unseen. The button is exercised below.
  await page.keyboard.press("ControlOrMeta+k");

  const dialog = page.getByRole("dialog");
  // This is the assertion that catches a missing cmdk root: its children
  // throw during render, the error boundary replaces the page, and no
  // dialog ever appears.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("option").first()).toBeVisible();
  // And this is what tells "crashed" apart from "never opened" in the
  // failure report — the distinction that cost a whole investigation.
  expect(errors, `page errors after opening the palette: ${errors.join(" | ")}`).toEqual([]);

  // It toggles shut, and the shell's own control opens it again. The
  // label is rendered twice (`hidden md:inline-flex` and `md:hidden`),
  // so the VISIBLE one is chosen rather than the first in the DOM —
  // otherwise this hangs on actionability if a phone project is added.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(dialog).toBeHidden();
  await page
    .getByRole("button", { name: "Open command palette" })
    .locator("visible=true")
    .first()
    .click();
  await expect(dialog).toBeVisible();
  expect(errors, `page errors after reopening the palette: ${errors.join(" | ")}`).toEqual([]);
});

test("typing finds an entity, and the nav rows still filter without cmdk's scorer", async ({
  page,
}) => {
  // `shouldFilter={false}` switched cmdk's own matching off, because it
  // re-sorts by fuzzy score and the entity rows arrive ranked by
  // ts_rank_cd. That made nav matching this component's job, so both
  // halves are asserted here.
  await page.goto("/home");
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // A subsequence, not a substring: "prj" must still reach Projects.
  await dialog.getByRole("combobox").fill("prj");
  await expect(dialog.getByRole("option", { name: /Projects/ })).toBeVisible();

  // An entity row, from the server, debounced.
  await dialog.getByRole("combobox").fill("Designgranskning");
  const hit = dialog.getByRole("option").filter({ hasText: "Designgranskning" });
  await expect(hit.first()).toBeVisible({ timeout: 20_000 });

  // Selecting it navigates to the address the server resolved.
  await hit.first().click();
  await expect(page).toHaveURL(/\/projects\/.+\/backlog\?item=/);
});

test("ENTER OPENS THE RESULT, never the action row the query happened to match", async ({
  page,
}) => {
  // The bug this pins: cmdk moves its highlight on a SEARCH change only,
  // and entity rows mount 200 ms later — so the highlight stayed on
  // whatever the keystroke had selected. A query matching exactly one
  // ACTION row therefore left "Sign out" (sv: "Logga ut") selected, and
  // Enter signed the member out while they waited for results.
  await page.goto("/home");
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").fill("Designgranskning");

  const hit = dialog.getByRole("option").filter({ hasText: "Designgranskning" });
  await expect(hit.first()).toBeVisible({ timeout: 20_000 });
  // The result takes the highlight the moment it exists.
  await expect(hit.first()).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Enter");
  // Still signed in, and on the task — not on /login.
  await expect(page).toHaveURL(/\/projects\/.+\/backlog\?item=/);
});

test("closing the palette forgets the query — reopening never shows the last search", async ({
  page,
}) => {
  await page.goto("/home");
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").fill("Designgranskning");
  await expect(dialog.getByRole("option").filter({ hasText: "Designgranskning" }).first()).toBeVisible({
    timeout: 20_000,
  });

  // ⌘K toggles it shut, which does NOT go through onOpenChange — the
  // reason the reset is a render-time adjustment rather than a handler.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(dialog).toBeHidden();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox")).toHaveValue("");
  await expect(dialog.getByRole("option").filter({ hasText: "Designgranskning" })).toHaveCount(0);
});
