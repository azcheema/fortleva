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
