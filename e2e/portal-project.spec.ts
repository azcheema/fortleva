import { expect, test } from "@playwright/test";

import { CONTACT_STORAGE_STATE, requireSeed } from "./fixtures/tenant";

/**
 * THE ONE-SCREEN PROJECT PAGE, through a real contact session (Phase 3,
 * the Client Timeline slice; UI.md §4).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT. `portal-timeline.dbtest.ts`
 * calls the two projections with a principal an assertion built and
 * reads their JSON. This drives the whole vertical — a contact cookie,
 * `requirePortalContext()`, five reads under the contact principal — and
 * reads the RENDER: that the header names the phase the seed put in
 * progress and the milestone it dated next, that the meter counts the
 * three shared milestones and not the INTERNAL fourth, that the rail
 * carries every kind of entry in date order, and that the one name the
 * seed planted as a negative control ("Lansering", INTERNAL, due in
 * three weeks) is on no part of the page.
 *
 * It sorts before `updates.spec.ts` (workers: 1, alphabetical), so the
 * seeded post is the only published update when it runs.
 */

const seed = requireSeed();

test.use({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });

test.describe("portal project page", () => {
  test("header, rail and tasks — and nothing internal", async ({ page }) => {
    await page.goto(`/portal/projects/${seed.projectKey}`);
    await expect(page.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 });

    // ── The header ───────────────────────────────────────────────────
    const header = page.locator('[data-slot="page-header"]');
    await expect(header.locator("h1")).toContainText("E2E Project");
    // The health is the seeded post's, human-chosen: AT_RISK.
    await expect(header.locator('[data-slot="health-chip"]')).toHaveAttribute("data-value", "AT_RISK");
    const facts = header.locator('[data-slot="portal-project-facts"]');
    await expect(facts).toContainText(`Phase: ${seed.datedMilestoneName}`);
    await expect(facts).toContainText(`Next milestone: ${seed.upcomingMilestoneName}`);
    // Sidmallar reached; Designgranskning and Innehållsinläsning open;
    // Lansering INTERNAL and therefore not a milestone this reader has.
    await expect(facts).toContainText("1 of 3 milestones");

    // ── The rail ─────────────────────────────────────────────────────
    const rail = page.locator('[data-slot="portal-timeline"]');
    await expect(rail).toBeVisible();
    const events = rail.locator('[data-slot="portal-event"]');
    // Newest first: the upcoming due (+7 d), the post (today), the
    // reached milestone (today, before the post in the seed), the ship
    // (−7 d), the in-progress phase's own due (−14 d).
    await expect(events).toHaveCount(5);
    await expect(events.nth(0)).toHaveAttribute("data-kind", "milestone_due");
    await expect(events.nth(0)).toContainText(seed.upcomingMilestoneName);
    await expect(events.nth(1)).toHaveAttribute("data-kind", "update");
    await expect(events.nth(1).locator('[data-slot="health-chip"]')).toHaveAttribute("data-value", "AT_RISK");
    await expect(events.nth(2)).toHaveAttribute("data-kind", "milestone_done");
    await expect(events.nth(2)).toContainText(seed.reachedMilestoneName);
    await expect(events.nth(3)).toHaveAttribute("data-kind", "version_shipped");
    await expect(events.nth(3)).toContainText(`Version ${seed.shippedVersion}`);
    await expect(events.nth(3)).toContainText("Sidmallar och navigation på plats");
    await expect(events.nth(4)).toHaveAttribute("data-kind", "milestone_due");
    await expect(events.nth(4)).toContainText(seed.datedMilestoneName);

    // ── THE NEGATIVE CONTROL ─────────────────────────────────────────
    // The INTERNAL milestone is on no part of the page. Checked on the
    // whole surface, not the rail alone: the header's facts and the
    // meter are the other places a milestone name could reach.
    // (The seeded post's summary says "Lanseringen flyttas…" — the
    // WORD, in the agency's own prose to the client; the exact name as
    // its own token is what must be absent, so the rail and the header
    // are checked rather than the post's body.)
    await expect(rail).not.toContainText("Lansering");
    await expect(facts).not.toContainText("Lansering");

    // ── The latest update and the shared tasks are on the page too ──
    await expect(page.locator('[data-slot="portal-update"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="portal-group"]').first()).toBeVisible();

    // ── The post's entry links to the updates page, at its anchor ────
    await events.nth(1).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/portal/projects/${seed.projectKey}/updates#update-`), {
      timeout: 30_000,
    });
    // …whose back link returns to the project page.
    await page.getByRole("link", { name: /^Back to E2E Project/ }).click();
    await expect(page).toHaveURL(new RegExp(`/portal/projects/${seed.projectKey}$`), { timeout: 30_000 });
  });

  test("the home's project card leads to the page", async ({ page }) => {
    await page.goto("/portal");
    await expect(page.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 });
    const card = page.locator('[data-slot="section-card"]', { hasText: "E2E Project" }).first();
    await card.locator("h2").getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/portal/projects/${seed.projectKey}$`), { timeout: 30_000 });
    await expect(page.locator('[data-slot="page-header"] h1')).toContainText("E2E Project");
  });
});
