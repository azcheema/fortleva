import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { CONTACT_STORAGE_STATE, STORAGE_STATE, requireSeed } from "./fixtures/tenant";
import { SLOW } from "./fixtures/keys";

/** The one toast that says `text` — never the whole stack (see the note at the first use). */
const toast = (page: Page, text: string | RegExp): Locator => page.locator("[data-sonner-toast]", { hasText: text });

/**
 * PROGRESS UPDATES, ACROSS BOTH PLANES (Phase 3, DATA_MODEL §6.16).
 *
 * A member writes a post in the composer, publishes it to the client,
 * and the contact reads it on their portal — the health chip, the title,
 * the summary — then the member archives it and it is gone from the
 * portal again. The seed has already published update #1 (AT_RISK), so
 * this one is #2, and archiving it in the same test leaves the seeded
 * post the newest for the visual sweep that runs after this file.
 *
 * WHAT ONLY A BROWSER CAN MEASURE: that five Tiptap editors, the publish
 * dialog's audience choice and the server action agree on ONE
 * document — `updates.dbtest.ts` calls the service with a body an
 * assertion built; this types into the editor and reads the row back
 * off a client's screen.
 */

const seed = requireSeed();

test.use({ storageState: STORAGE_STATE, locale: "en-US" });

async function portalShows(browser: Browser, text: string, present: boolean): Promise<void> {
  const contact = await browser.newContext({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });
  try {
    const page = await contact.newPage();
    await page.goto("/portal");
    await expect(page.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 });
    // The seeded post is always there, so the card has rendered before
    // the count below is read — an absence must not be a page still loading.
    await expect(page.locator('[data-slot="portal-update"]').first()).toBeVisible({ timeout: 30_000 });
    const hit = page.locator('[data-slot="portal-update"]', { hasText: text });
    await expect(hit).toHaveCount(present ? 1 : 0, { timeout: 20_000 * SLOW });
  } finally {
    await contact.close();
  }
}

test.describe("progress updates", () => {
  test("a member publishes an update, the client reads it, and archiving takes it back", async ({ page, browser }) => {
    const title = `Sprint review ${Date.now()}`;
    const summary = `The homepage is live on staging ${Date.now()}`;

    await page.goto(`/projects/${seed.projectKey}/updates`);
    // The seeded post is pinned as the latest, with its health.
    await expect(page.locator('[data-slot="update-view"][data-health="AT_RISK"]').first()).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId("new-update").click();
    await expect(page.getByTestId("update-composer")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("health-OFF_TRACK").click();
    await page.getByLabel("Title").fill(title);
    const editor = page.getByTestId("update-section-SUMMARY");
    await editor.click();
    await page.keyboard.type(summary);
    // The live preview draws the same component the portal does.
    await expect(page.getByTestId("update-preview")).toContainText(summary);
    await expect(page.getByTestId("update-preview").locator('[data-slot="health-chip"]')).toHaveAttribute(
      "data-value",
      "OFF_TRACK",
    );

    await page.getByTestId("open-publish").click();
    await expect(page.getByRole("dialog", { name: "Publish update" })).toBeVisible();
    // The portal is on for the seeded project, so the client is the default audience.
    await expect(page.getByTestId("publish-audience-CLIENT_VISIBLE")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("publish-confirm").click();

    // Every toast assertion in this file filters by its TEXT: on a fast
    // machine the previous toast is still on screen when the next one
    // appears, and a bare `[data-sonner-toast]` then matches two
    // elements, which strict mode refuses (CI run 36169282318 — the
    // archive had succeeded; the locator had not).
    await expect(toast(page, /Update #\d+ published\. Your client can read it\./)).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/updates\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const detail = page.getByTestId("update-detail");
    await expect(detail).toContainText(title);
    await expect(detail.locator('[data-slot="health-chip"]')).toHaveAttribute("data-value", "OFF_TRACK");
    await expect(detail).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");

    await portalShows(browser, summary, true);

    // The all-updates page lists the seeded post too, newest first.
    const contact = await browser.newContext({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });
    try {
      const portal = await contact.newPage();
      await portal.goto(`/portal/projects/${seed.projectKey}/updates`);
      const posts = portal.locator('[data-slot="update-view"]');
      await expect(posts).toHaveCount(2, { timeout: 30_000 });
      await expect(posts.first().locator('[data-slot="health-chip"]')).toHaveAttribute("data-value", "OFF_TRACK");
      await expect(posts.nth(1).locator('[data-slot="health-chip"]')).toHaveAttribute("data-value", "AT_RISK");
    } finally {
      await contact.close();
    }

    // Archive from the detail page: a danger verb, so it asks first
    // (`InlineConfirm` swaps the button for the question and Yes / No).
    await page.getByTestId("published-actions").getByRole("button", { name: "Archive" }).click();
    await page.getByTestId("published-actions").getByRole("button", { name: "Yes" }).click();
    await expect(toast(page, "Update archived.")).toBeVisible({ timeout: 30_000 });
    await portalShows(browser, summary, false);
  });

  test("a saved draft shows in the list as a draft and never reaches the client", async ({ page, browser }) => {
    const summary = `Only the team reads this ${Date.now()}`;
    await page.goto(`/projects/${seed.projectKey}/updates/new`);
    await expect(page.getByTestId("update-composer")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("update-section-SUMMARY").click();
    await page.keyboard.type(summary);
    await page.getByTestId("save-draft").click();
    await expect(toast(page, "Draft saved.")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/updates\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    await page.goto(`/projects/${seed.projectKey}/updates`);
    const row = page.getByTestId("updates-list").locator("li", { hasText: summary });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("Draft");
    await portalShows(browser, summary, false);

    // Discard it, so the list is as the seed left it.
    await row.getByRole("link").click();
    await expect(page.getByTestId("update-composer")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Discard draft" }).click();
    await page.getByTestId("update-composer").getByRole("button", { name: "Yes" }).click();
    await expect(toast(page, "Draft discarded.")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`/projects/${seed.projectKey}/updates$`), { timeout: 30_000 });
  });
});
