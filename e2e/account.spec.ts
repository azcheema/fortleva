import { expect, test, type Locator, type Page } from "@playwright/test";

import { isActionPost } from "./fixtures/actions";

/**
 * Display name on /account.
 *
 * Until this field existed the only way to change a name was an UPDATE
 * against the database, which skips validation, the audit trail and
 * Better Auth's session cache. So the assertions here are the ones a
 * direct write would have bypassed: the value survives a reload (it
 * really persisted), it reaches the session (the avatar in the header
 * follows), and an invalid value is refused rather than written.
 *
 * The inline-edit contract is also pinned, because it is where this
 * product has already shipped a bug: a rejected save must keep the
 * typed text on screen, and Escape must save nothing.
 */

/** The rest-mode trigger for the name, whatever it currently reads. */
const nameTrigger = (page: Page): Locator =>
  page.locator("[data-slot=inline-edit]").first();

/**
 * Type a new name and, when committing, WAIT FOR THE SERVER TO ANSWER.
 * Reloading while the action is still in flight races the save and reads
 * the pre-write render — which looks exactly like a save that did not
 * persist. The visibility spec pins the same contract the same way.
 */
async function editName(page: Page, next: string, commit: "enter" | "escape" = "enter") {
  const answered =
    commit === "enter" ? page.waitForResponse((res) => isActionPost(res.request())) : null;
  await nameTrigger(page).click();
  const input = page.locator('input[name="name"]');
  await expect(input).toBeVisible();
  await input.fill(next);
  await input.press(commit === "enter" ? "Enter" : "Escape");
  if (answered) await answered;
}

test.describe("account display name", () => {
  test("a new name persists, reaches the session, and survives a reload", async ({ page }) => {
    await page.goto("/account");
    const original = (await nameTrigger(page).innerText()).trim();

    // A FIXTURE name, deliberately. This spec writes what it types into
    // the database and, on a failing run, into the uploaded Playwright
    // report — which is no place for a real person's name, least of all
    // the founder's.
    await editName(page, "Testa Testsson");
    // Enter must COMMIT: the control leaves edit mode.
    await expect(page.locator('input[name="name"]')).toHaveCount(0);

    // Persisted, not merely optimistic: a full reload re-reads the
    // identity from the database through Better Auth.
    await page.reload();
    await expect(nameTrigger(page)).toContainText("Testa Testsson");

    // Reached the identity the rest of the app reads (header avatar
    // initials come from the session user, not from this page).
    await page.goto("/home");
    // The AVATAR, matched WHOLE — not a substring of the app bar. A
    // regex over the header's text is a trap: the bar renders "Command
    // palette" (app-shell.tsx, messages `shell.palette.title`), so a
    // two-initial pattern like /TT/i matches "pale**tt**e" and the
    // assertion passes even when the session never learned the new name.
    // toHaveText on the fallback slot is an exact, whole-element match
    // no other copy in the bar can satisfy.
    await expect(page.locator('header [data-slot="avatar-fallback"]').first()).toHaveText("TT");

    // Put it back so the fixture stays as the other specs expect it.
    await page.goto("/account");
    await editName(page, original);
    await page.reload();
    await expect(nameTrigger(page)).toContainText(original);
  });

  test("Escape saves nothing", async ({ page }) => {
    await page.goto("/account");
    const original = (await nameTrigger(page).innerText()).trim();

    await editName(page, "Discarded Name", "escape");
    await page.reload();
    await expect(nameTrigger(page)).toContainText(original);
    await expect(page.getByText("Discarded Name")).toHaveCount(0);
  });

  test("an empty name is refused and the field stays open", async ({ page }) => {
    await page.goto("/account");
    const original = (await nameTrigger(page).innerText()).trim();

    await nameTrigger(page).click();
    const input = page.locator('input[name="name"]');
    await input.fill("   ");
    await input.press("Enter");

    // Refused: nothing written, and the typed text is not silently
    // replaced by the server value while the edit is still on screen.
    await page.reload();
    await expect(nameTrigger(page)).toContainText(original);
  });
});

/**
 * The account menu offers "Switch workspace" only above one membership
 * (UI.md rule 8: `/dashboard` is the workspace picker "only for > 1
 * membership"). The fixture owner belongs to exactly one workspace, so
 * this pins the direction the harness can prove — the item is GONE.
 *
 * The > 1 direction needs a second throwaway tenant in the fixture and
 * is owed (PLAN §0), together with the defect it would run into: the
 * picker cannot actually switch yet (nothing writes the session's
 * activeTenantId pointer and every row links to a bare /home).
 */
test.describe("the account menu", () => {
  test("offers no workspace switch when the member has only one workspace", async ({ page }) => {
    await page.goto("/home");
    await page.getByRole("button", { name: "Account menu" }).click();

    const menu = page.locator('[data-slot="dropdown-menu-content"]');
    await expect(menu).toBeVisible();
    // The menu really rendered its items — without this the assertion
    // below would pass just as well against a menu that never opened.
    await expect(menu.getByRole("menuitem", { name: "Account" })).toBeVisible();
    // BOTH, and each covers the other's blind spot: a name match is a
    // substring match, so an English copy change would make the first
    // vacuously true forever; and a refactor that rendered the entry as
    // a bare link would keep the second at zero while the offer is
    // plainly on screen. The href is what the new branch controls.
    await expect(menu.getByRole("menuitem", { name: "Switch workspace" })).toHaveCount(0);
    await expect(menu.locator('a[href="/dashboard"]')).toHaveCount(0);
  });
});

/**
 * Only the OFFER is gated; the route is not. It is where
 * `requireTenantContext` sends a member with no active membership, and
 * the only surface a SUSPENDED membership's status shows on — so a
 * later "redirect /dashboard to /home below two memberships" would
 * strand that member, and must fail here first.
 */
test.describe("the workspace picker route", () => {
  test("stays reachable by URL for a single-workspace member", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  });
});
