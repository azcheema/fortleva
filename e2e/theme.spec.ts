import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * BUG 2 — "I select light mode but it went back to dark again."
 *
 * The theme has two writers: the server (which renders the class on
 * <html> from the fl_theme cookie) and the toggle (which flips it in
 * the browser). This spec pins the contract between them: an explicit
 * choice outlives navigation, reload, and — the actual regression —
 * every later MOUNT of a ThemeToggle, including the one that lives
 * inside the user menu and is re-created each time the menu opens.
 *
 * The OS preference is emulated in both directions, because a bug that
 * re-applies "system" is invisible on a machine whose system already
 * agrees with the choice.
 */

const isDark = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.classList.contains("dark"));

/** The class list of <html> as the SERVER wrote it — before any JS. */
async function serverRenderedClass(context: BrowserContext, path: string): Promise<string[]> {
  const res = await context.request.get(path);
  expect(res.status()).toBe(200);
  const html = await res.text();
  const match = /<html[^>]*\sclass="([^"]*)"/i.exec(html);
  return (match?.[1] ?? "").split(/\s+/).filter(Boolean);
}

const openUserMenu = async (page: Page): Promise<void> => {
  await page.locator('header [data-slot="dropdown-menu-trigger"]').click();
  await expect(page.locator('[data-slot="dropdown-menu-content"]')).toBeVisible();
};

const chooseTheme = async (page: Page, label: "System" | "Light" | "Dark"): Promise<void> => {
  await page
    .locator('[data-slot="dropdown-menu-content"] [data-slot="theme-toggle"]')
    .getByRole("radio", { name: label, exact: true })
    .click();
};

const closeMenu = async (page: Page): Promise<void> => {
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-slot="dropdown-menu-content"]')).toBeHidden();
};

test.describe("theme preference, OS set to dark", () => {
  test.use({ colorScheme: "dark" });

  test("Light survives navigation, reload and re-opening the menu", async ({ page, context }) => {
    await page.goto("/home");
    // No preference yet: "system" is honoured, so the emulated OS wins.
    expect(await isDark(page)).toBe(true);

    await openUserMenu(page);
    await chooseTheme(page, "Light");
    expect(await isDark(page)).toBe(false);
    await closeMenu(page);

    // …across a navigation
    await page.goto("/clients");
    expect(await isDark(page)).toBe(false);

    // …across a full reload
    await page.reload();
    expect(await isDark(page)).toBe(false);

    // …and across the NEXT mount of the toggle, which is the bug: the
    // menu re-creates it, and it used to re-apply "system" on mount.
    await openUserMenu(page);
    expect(await isDark(page)).toBe(false);
    // the control shows the stored choice, not its own default
    const toggle = page.locator('[data-slot="dropdown-menu-content"] [data-slot="theme-toggle"]');
    await expect(toggle.getByRole("radio", { name: "Light", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await closeMenu(page);

    // No flash: the first painted frame is already light, because the
    // server rendered it that way — nothing is left for hydration.
    expect(await serverRenderedClass(context, "/clients")).not.toContain("dark");

    // The design preview mounts a second ThemeToggle with no menu
    // around it. It 404s in production (dev-only page), so it is
    // asserted only where it exists.
    const design = await context.request.get("/settings/design");
    if (design.status() === 200) {
      await page.goto("/settings/design");
      expect(await isDark(page)).toBe(false);
      expect(await serverRenderedClass(context, "/settings/design")).not.toContain("dark");
    }
  });

  test("System follows the emulated scheme in both directions", async ({ page }) => {
    await page.goto("/home");
    await openUserMenu(page);
    await chooseTheme(page, "Dark");
    await chooseTheme(page, "System");
    await closeMenu(page);
    await page.reload();
    expect(await isDark(page)).toBe(true);

    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    expect(await isDark(page)).toBe(false);

    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    expect(await isDark(page)).toBe(true);
  });
});

test.describe("theme preference, OS set to light", () => {
  test.use({ colorScheme: "light" });

  test("Dark survives navigation, reload and re-opening the menu", async ({ page, context }) => {
    await page.goto("/home");
    expect(await isDark(page)).toBe(false);

    await openUserMenu(page);
    await chooseTheme(page, "Dark");
    expect(await isDark(page)).toBe(true);
    await closeMenu(page);

    await page.goto("/clients");
    expect(await isDark(page)).toBe(true);

    await page.reload();
    expect(await isDark(page)).toBe(true);

    await openUserMenu(page);
    expect(await isDark(page)).toBe(true);
    await closeMenu(page);

    expect(await serverRenderedClass(context, "/clients")).toContain("dark");
  });
});
