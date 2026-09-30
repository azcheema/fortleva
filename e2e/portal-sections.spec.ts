import { expect, test, type Page } from "@playwright/test";

import { portalSurface } from "./fixtures/portal-surface";
import {
  CONTACT_STORAGE_STATE,
  STORAGE_STATE,
  clearPortalRequests,
  requireSeed,
  resetPortalSections,
} from "./fixtures/tenant";

/**
 * THE PER-SECTION PORTAL SWITCHES, END TO END (Phase 3 slice 80, founder
 * decision C47 and its home answer of 2026-09-30).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT. `portal-sections.dbtest.ts`
 * asks each projection whether it follows the switches. This drives the
 * whole loop a member and a client actually see: the member presses a
 * switch on the Portal tab; the client's real session reloads its project
 * page and its home and finds exactly that section gone; the client's own
 * REQUEST is still listed with Tasks hidden (C47c); an ask on "Waiting on
 * you" still leads to its control, on the Files page now that the project
 * page draws no files (C47b); and the View-as twin of each page is the
 * same bytes as the client's.
 *
 * ONE SWITCH AT A TIME, with the client's page read after each, so a
 * switch wired to the wrong section fails on the step that pressed it
 * rather than being hidden by the other three.
 *
 * THE FIXTURE IS HANDED BACK IN `afterAll`, NOT A `finally` — the reason
 * `portal-requests.spec.ts` gives: a test TIMEOUT abandons the body. This
 * spec hides every section of the shared seeded project and sorts before
 * `portal-signoff`, `view-as`, `visual` and the Swedish width walk, each
 * of which reads that project's page with its sections drawn. The undo
 * writes the columns directly (`reset-portal-sections`), so it does not
 * depend on the UI this test may have failed in, and it also leaves
 * View-as if the test died inside it.
 */

const seed = requireSeed();

test.use({ locale: "en-US" });

const PORTAL_TAB = `/projects/${seed.projectKey}/portal`;
const PROJECT_PAGE = `/portal/projects/${seed.projectKey}`;

async function openClientPage(client: Page, path = PROJECT_PAGE): Promise<void> {
  await client.goto(path);
  await expect(client.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 });
}

/** Press one section's switch on the Portal tab and wait for the SERVER's answer — the control is not optimistic. */
async function hide(member: Page, section: "tasks" | "updates" | "milestones" | "files"): Promise<void> {
  const control = member.locator(`#p-section-${section}`);
  await expect(control).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  // The four share one pending state, so the previous press's switches
  // can still be disabled when its own has already flipped.
  await expect(control).toBeEnabled({ timeout: 30_000 });
  await control.click();
  await expect(control).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });
}

test.describe("portal section switches", () => {
  test.afterAll(async ({ browser }) => {
    await resetPortalSections(seed.tenantId);
    await clearPortalRequests(seed.tenantId, seed.contactEmail);
    // Out of View-as, if the body died inside it: `/view-as` with no mode
    // sends the member home, and with one it draws the exit button.
    const ctx = await browser.newContext({ storageState: STORAGE_STATE });
    try {
      const page = await ctx.newPage();
      await page.goto("/view-as");
      const exit = page.getByRole("button", { name: "Exit client view" });
      if (await exit.isVisible().catch(() => false)) {
        await exit.click();
        await page.waitForURL("**/home", { timeout: 30_000 });
      }
    } finally {
      await ctx.close();
    }
  });

  test("each switch takes its section off the client's pages and the View-as twin; requests and asks stay", async ({
    page: member,
    browser,
  }) => {
    const portal = await browser.newContext({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });
    try {
      const client = await portal.newPage();

      // ── The client asks for something, so Tasks hidden has a row to keep ──
      const request = `Section switch request ${Date.now()}`;
      await client.goto("/portal/requests/new");
      await expect(client.getByLabel("What do you need?")).toBeVisible({ timeout: 30_000 });
      await client.locator("#request-project").selectOption(seed.projectId);
      await client.getByLabel("What do you need?").fill(request);
      await client.getByRole("button", { name: "Send request" }).click();
      await expect(client).toHaveURL(/\/portal$/, { timeout: 30_000 });

      // ── The baseline: every section drawn ──────────────────────────────
      await openClientPage(client);
      const header = client.locator('[data-slot="page-header"]');
      const events = client.locator('[data-slot="portal-timeline"] [data-slot="portal-event"]');
      const groups = client.locator('[data-slot="portal-group"]');
      await expect(header.locator('[data-slot="health-chip"]')).toBeVisible();
      await expect(header.locator('[data-slot="portal-project-facts"]')).toBeVisible();
      await expect(client.locator('[data-slot="portal-update"]')).toHaveCount(1);
      await expect(client.locator('[data-slot="portal-project-files"]')).toBeVisible();
      await expect(groups.filter({ hasText: "Tillgänglighetsgranskning" })).toHaveCount(1);
      await expect(events.and(client.locator('[data-kind="update"]'))).toHaveCount(1);

      await member.goto(PORTAL_TAB);
      const card = member.locator('[data-slot="portal-sections"]');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card.getByRole("switch")).toHaveCount(4);

      // ── Tasks: the section keeps the client's own request, nothing else ──
      await hide(member, "tasks");
      await openClientPage(client);
      await expect(client.getByRole("heading", { name: "Your requests" })).toBeVisible();
      await expect(groups).toHaveCount(1);
      await expect(groups.first()).toHaveAttribute("data-category", "REQUESTED");
      await expect(groups.first()).toContainText(request);
      await expect(groups.filter({ hasText: "Tillgänglighetsgranskning" })).toHaveCount(0);
      // Nothing else moved.
      await expect(client.locator('[data-slot="portal-update"]')).toHaveCount(1);
      await expect(client.locator('[data-slot="portal-project-files"]')).toBeVisible();

      // ── Updates: the card, the health chip and the rail's posts ───────
      await hide(member, "updates");
      await openClientPage(client);
      await expect(client.locator('[data-slot="portal-update"]')).toHaveCount(0);
      await expect(header.locator('[data-slot="health-chip"]')).toHaveCount(0);
      await expect(events.and(client.locator('[data-kind="update"]'))).toHaveCount(0);
      await expect(header.locator('[data-slot="portal-project-facts"]')).toBeVisible();

      // ── Milestones: the header's plan and the rail's milestones ───────
      await hide(member, "milestones");
      await openClientPage(client);
      await expect(header.locator('[data-slot="portal-project-facts"]')).toHaveCount(0);
      await expect(events.and(client.locator('[data-kind^="milestone_"]'))).toHaveCount(0);
      await expect(client.locator('[data-slot="portal-project-files"]')).toBeVisible();

      // ── Files: the section and the rail's deliveries ─────────────────
      await hide(member, "files");
      await openClientPage(client);
      await expect(client.locator('[data-slot="portal-project-files"]')).toHaveCount(0);
      await expect(events.and(client.locator('[data-kind="document_version"]'))).toHaveCount(0);
      // What no switch touches: the shipped versions, hours, the request.
      await expect(events.and(client.locator('[data-kind="version_shipped"]'))).toHaveCount(2);
      await expect(events).toHaveCount(2);
      await expect(client.locator('[data-slot="portal-hours"]')).toBeVisible();
      await expect(groups.first()).toContainText(request);

      // ── "Waiting on you" is not a section: the ask to sign the
      // deliverable off is still there, and leads to the Files page's row
      // — which carries the control — instead of an anchor this page no
      // longer draws. ─────────────────────────────────────────────────
      const ask = client.locator('[data-slot="portal-action-item"][data-kind="deliverable"]');
      await expect(ask).toHaveCount(1);
      const review = ask.getByRole("link", { name: "Review" });
      await expect(review).toHaveAttribute("href", `/portal/files#file-${seed.deliverableDocId}`);
      const projectHtml = await portalSurface(client);

      // ── The home's card follows the switches too (C47's home answer) ──
      await openClientPage(client, "/portal");
      const homeCard = client
        .locator('[data-slot="section-card"]')
        .filter({ has: client.locator(`h2 a[href="${PROJECT_PAGE}"]`) });
      await expect(homeCard).toHaveCount(1);
      await expect(homeCard.locator('[data-slot="portal-update"]')).toHaveCount(0);
      await expect(homeCard.locator('[data-slot="portal-group"]')).toHaveCount(1);
      await expect(homeCard).toContainText(request);
      await expect(homeCard).not.toContainText("Tillgänglighetsgranskning");
      const homeHtml = await portalSurface(client);

      // The ask's link lands on the row with its control.
      await openClientPage(client);
      await client.locator('[data-slot="portal-action-item"][data-kind="deliverable"]').getByRole("link", { name: "Review" }).click();
      await expect(client).toHaveURL(new RegExp(`/portal/files#file-${seed.deliverableDocId}$`), { timeout: 30_000 });
      await expect(client.locator(`[id="file-${seed.deliverableDocId}"]`)).toBeVisible();
      await expect(client.locator(`[id="file-${seed.deliverableDocId}"]`).getByTestId("portal-signoff-approve")).toBeVisible();

      // ── The member's preview is the home's card, as the client has it ──
      await member.goto(PORTAL_TAB);
      await expect(member.getByRole("heading", { name: "What the client sees" })).toBeVisible({ timeout: 30_000 });
      // The panel is the tab's one inert region (look, don't touch).
      const panel = member.locator("div[inert]");
      await expect(panel).toHaveCount(1);
      await expect(panel.locator('[data-slot="portal-group"]')).toHaveCount(1);
      await expect(panel).toContainText(request);
      await expect(panel.locator('[data-slot="portal-update"]')).toHaveCount(0);

      // ── The View-as twins: the same bytes as the client's pages ──────
      await member.getByRole("button", { name: `View as ${seed.contactName}`, exact: true }).click();
      await member.waitForURL("**/view-as", { timeout: 30_000 });
      expect(await portalSurface(member)).toBe(homeHtml);
      await member.goto(`/view-as/projects/${seed.projectKey}`);
      await expect(member.locator('[data-slot="view-as-banner"]')).toBeVisible();
      expect(await portalSurface(member)).toBe(projectHtml);
      await member.getByRole("button", { name: "Exit client view" }).click();
      await member.waitForURL("**/home", { timeout: 30_000 });
    } finally {
      await portal.close();
    }
  });
});
