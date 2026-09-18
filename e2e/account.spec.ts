import { expect, test, type Locator, type Page } from "@playwright/test";

import { isActionPost } from "./fixtures/actions";
import { requireSeed } from "./fixtures/tenant";

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
 * The workspace picker (UI.md rule 8) — the OFFER and the SWITCH.
 *
 * The fixture owner belongs to TWO workspaces (`seed-cli.ts` provisions
 * an empty second one), which is what makes either half testable: with
 * one membership every assertion here could only ever have been an
 * absence. The switch itself could not be tested at all before
 * 2026-09-18 — nothing wrote the session's `activeTenantId` pointer and
 * every row linked to a bare `/home`, so a member of two active tenants
 * always landed back in the earliest-joined one.
 */
test.describe("the workspace picker", () => {
  /**
   * The pointer this file moves lives on the SESSION ROW, which every
   * spec shares (`workers: 1`, one storage state) — so a run that ends
   * pointed at the empty second workspace fails everything after it, and
   * this file runs first. An in-body `finally` is NOT enough: Playwright
   * abandons the test body on a TEST TIMEOUT, and a hook still runs.
   * Idempotent, so it costs one navigation after the other test too.
   */
  test.afterEach(async ({ page }) => {
    const seed = requireSeed();
    await page.goto("/dashboard");
    await page.getByRole("button", { name: `Open ${seed.tenantName}`, exact: true }).click();
    await page.waitForURL("**/home");
  });

  test("the account menu offers the switch above one membership", async ({ page }) => {
    await page.goto("/home");
    await page.getByRole("button", { name: "Account menu" }).click();

    const menu = page.locator('[data-slot="dropdown-menu-content"]');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Account" })).toBeVisible();
    // BOTH, and each covers the other's blind spot: a name match is a
    // substring match, so an English copy change would make the first
    // vacuously true forever; and a refactor that rendered the entry as
    // a bare link would keep the second correct while the role is gone.
    await expect(menu.getByRole("menuitem", { name: "Switch workspace" })).toBeVisible();
    await expect(menu.locator('a[href="/dashboard"]')).toHaveCount(1);
  });

  test("choosing the other workspace actually switches, and it sticks", async ({ page }) => {
    const seed = requireSeed();
    // The header carries the workspace name TWICE — the phone section
    // label falls back to it on a route no nav entry owns (/dashboard is
    // one), and the desktop span always shows it. Only one of the two is
    // ever on screen, so the visible filter is the whole selector: an
    // unfiltered getByText is a strict-mode violation on /dashboard.
    const inHeader = (name: string) =>
      page.locator("header").getByText(name, { exact: true }).filter({ visible: true });

    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();

    // The header names the workspace we are in before the switch.
    await expect(inHeader(seed.tenantName)).toBeVisible();

    // A submit, not a link: choosing a workspace WRITES the session
    // pointer, so a GET would fire on Next's link prefetch. EXACT,
    // because the second workspace's name is the first's plus " B" and a
    // substring match resolves to both rows — the same trap as the
    // header's two workspace names, a few lines up.
    await page
      .getByRole("button", { name: `Open ${seed.secondTenantName}`, exact: true })
      .click();

    // It lands on Home IN THE OTHER WORKSPACE — the assertion the old
    // bare-`/home` link would have failed, because it landed on Home in
    // the FIRST one and looked identical to a working switch.
    await page.waitForURL("**/home");
    await expect(inHeader(seed.secondTenantName)).toBeVisible();
    await expect(inHeader(seed.tenantName)).toHaveCount(0);

    // PERSISTED on the session row, not merely rendered once: a full
    // reload re-reads it through Better Auth.
    await page.reload();
    await expect(inHeader(seed.secondTenantName)).toBeVisible();
    // The afterEach above puts the fixture back.
  });

  /**
   * Only the OFFER is gated, never the ROUTE. `requireTenantContext`
   * redirects a member with NO active membership to `/dashboard`, so
   * gating it would loop them, and it is the only surface a SUSPENDED
   * membership's status shows on. A later "redirect `/dashboard` to
   * `/home`" must fail here first.
   *
   * WEAKER THAN IT LOOKS, and owed (PLAN §0): the fixture owner now has
   * two workspaces, so this cannot catch a redirect conditioned on
   * having FEWER than two. Proving that needs a signed-in
   * single-membership member — the seeded employee — and so a second
   * sign-in, on the path that already carries the suite's one recorded
   * flake.
   */
  test("the picker route is reachable by URL, never gated", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  });

  /**
   * THE STALE-TAB FENCE (`src/lib/workspace-watch.ts`).
   *
   * Switching became possible on 2026-09-18, and with it the hazard that
   * came free: the active workspace is a SESSION pointer, one tab moves
   * it, and every other tab of that browser goes on showing the old
   * workspace while everything it posts resolves the new one. An action
   * carrying an entity id fails safe; a create-shaped one lands in the
   * workspace the member is not looking at.
   *
   * Two real tabs in ONE context, which is what makes this testable at
   * all: the same cookie jar (so the session is genuinely shared) and
   * the same origin (so the `BroadcastChannel` between them is the one
   * the app uses). A single-page test could only ever have checked that
   * a dialog renders.
   */
  test("a tab whose workspace another tab moved says so, and cannot be used or dismissed", async ({
    page,
  }) => {
    const seed = requireSeed();
    const fence = page.locator("[data-testid=workspace-changed]");

    // Tab A, sitting on a page whose create form is exactly the shape
    // that has no entity id to fail safe on.
    await page.goto("/clients");
    await expect(page.getByRole("heading", { name: "Clients", level: 1 })).toBeVisible();
    await expect(fence).toBeHidden();

    // Tab B moves the session pointer.
    const other = await page.context().newPage();
    try {
      await other.goto("/dashboard");
      await other
        .getByRole("button", { name: `Open ${seed.secondTenantName}`, exact: true })
        .click();
      await other.waitForURL("**/home");

      // Tab A hears it, and names the workspace it is still showing —
      // not the one it would now write to. BOTH assertions, because the
      // second workspace's name is the first's plus " B": a substring
      // match on the first alone stays green even when the fence names
      // the wrong one, the trap this file already documents above.
      await expect(fence).toBeVisible();
      await expect(fence).toContainText(seed.tenantName);
      await expect(fence).not.toContainText(seed.secondTenantName);

      // It is not a notice. Escape and a click outside are how every
      // other layer in the product closes, and neither closes this one.
      await page.keyboard.press("Escape");
      await expect(fence).toBeVisible();
      await page.mouse.click(5, 5);
      await expect(fence).toBeVisible();

      // And it owns the keyboard: `?` is a global binding, so an overlay
      // opening here would mean the page behind is still live.
      await page.keyboard.press("?");
      await expect(page.getByRole("dialog", { name: /shortcut/i })).toHaveCount(0);

      // The way out that KEEPS this tab where it is: put the session
      // pointer back. It lands on Home in the first workspace, which is
      // also what the afterEach would have had to do.
      await page
        .getByRole("button", { name: `Go back to ${seed.tenantName}`, exact: true })
        .click();
      await page.waitForURL("**/home");
      await expect(fence).toBeHidden();
      await expect(
        page.locator("header").getByText(seed.tenantName, { exact: true }).filter({ visible: true }),
      ).toBeVisible();

      // And the fence is SYMMETRIC: the pointer is back in the first
      // workspace, so the tab still showing the second is now the stale
      // one and is fenced in its turn. Without the `at` stamp in the
      // watcher's key nothing would have told it — this tab's own
      // workspace never changed — and it would have gone on writing
      // into a workspace nobody is looking at, which is the hazard
      // pointing the other way (review, 2026-09-18).
      await expect(other.locator("[data-testid=workspace-changed]")).toBeVisible();
      await expect(other.locator("[data-testid=workspace-changed]")).toContainText(
        seed.secondTenantName,
      );
    } finally {
      await other.close();
    }
  });
});
