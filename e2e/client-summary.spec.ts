import { expect, test, type Page } from "@playwright/test";

import { CONTACT_STORAGE_STATE, clientSummaryLink, requireSeed } from "./fixtures/tenant";

/**
 * THE CLIENTS' WEEKLY SUMMARY — the link that stops it, and the workspace's
 * switch (Phase 5 slice 101; founder decision C69).
 *
 * The link is the fixture contact's own, minted by the fixture CLI with the
 * server's key (`client-summary-link`, which also sets their summary back on).
 * Stopping takes the link alone — signed in as nobody, or by a mail
 * provider's RFC 8058 POST; starting again takes the person's own portal
 * session, because the mail carries the agency's reply address and a quoted
 * link could reach the agency's mailbox (C69: nobody at the agency may start
 * it for them). The mail itself is the dbtest's (`client-digests.dbtest.ts`):
 * a summary is due only on Monday morning.
 */

const seed = requireSeed();

const stoppedHeading = "Your weekly summary is stopped";
const onHeading = "You get a weekly summary";

test.describe.serial("the clients' weekly summary (C69)", () => {
  let token = "";

  test.beforeAll(async () => {
    token = await clientSummaryLink(seed.tenantId, seed.contactEmail);
  });

  test.afterAll(async () => {
    await clientSummaryLink(seed.tenantId, seed.contactEmail);
  });

  test.describe("signed in as nobody", () => {
    test.use({ storageState: { cookies: [], origins: [] }, locale: "en-US" });

    test("stops in one press and names nobody; starting again sends the reader to sign in", async ({ page }) => {
      await page.goto(`/portal/unsubscribe/${token}`);
      await expect(page.getByRole("heading", { name: onHeading, level: 1 })).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("body")).not.toContainText(seed.contactName);
      await expect(page.locator("body")).not.toContainText(seed.contactEmail);
      await page.getByRole("button", { name: "Stop these emails" }).click();
      await expect(page.getByRole("heading", { name: stoppedHeading, level: 1 })).toBeVisible({ timeout: 30_000 });

      await page.getByRole("button", { name: "Start them again" }).click();
      await expect(page.getByText("Only you can start them again")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute(
        "href",
        `/portal/login?next=${encodeURIComponent(`/portal/unsubscribe/${token}`)}`,
      );
      await page.reload();
      await expect(page.getByRole("heading", { name: stoppedHeading, level: 1 })).toBeVisible({ timeout: 30_000 });
    });

    test("a mail provider's one-click POST stops it; its GET only leads to the page; a stray POST does nothing", async ({
      page,
      request,
    }) => {
      await clientSummaryLink(seed.tenantId, seed.contactEmail);
      const address = `/api/client-summary/unsubscribe/${token}`;
      expect((await request.post(address, { form: { other: "x" } })).status()).toBe(400);
      const get = await request.get(address, { maxRedirects: 0 });
      expect(get.status()).toBe(303);
      expect(get.headers()["location"]).toContain(`/portal/unsubscribe/${token}`);
      await page.goto(`/portal/unsubscribe/${token}`);
      await expect(page.getByRole("heading", { name: onHeading, level: 1 })).toBeVisible({ timeout: 30_000 });

      expect((await request.post(address, { form: { "List-Unsubscribe": "One-Click" } })).status()).toBe(200);
      // Again: idempotent, and still a 200.
      expect((await request.post(address, { form: { "List-Unsubscribe": "One-Click" } })).status()).toBe(200);
      await page.reload();
      await expect(page.getByRole("heading", { name: stoppedHeading, level: 1 })).toBeVisible({ timeout: 30_000 });
    });

    test("a forged link opens nothing", async ({ page, request }) => {
      const forged = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
      await page.goto(`/portal/unsubscribe/${forged}`);
      await expect(page.getByRole("heading", { name: "This link doesn't work", level: 1 })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByRole("button")).toHaveCount(0);
      const post = await request.post(`/api/client-summary/unsubscribe/${forged}`, {
        form: { "List-Unsubscribe": "One-Click" },
      });
      expect(post.status()).toBe(404);
    });
  });

  test.describe("signed in as the person", () => {
    test.use({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });

    test("stops it and starts it again", async ({ page }) => {
      await clientSummaryLink(seed.tenantId, seed.contactEmail);
      await page.goto(`/portal/unsubscribe/${token}`);
      await page.getByRole("button", { name: "Stop these emails" }).click();
      await expect(page.getByRole("heading", { name: stoppedHeading, level: 1 })).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Start them again" }).click();
      await expect(page.getByRole("heading", { name: onHeading, level: 1 })).toBeVisible({ timeout: 30_000 });
      await page.reload();
      await expect(page.getByRole("heading", { name: onHeading, level: 1 })).toBeVisible({ timeout: 30_000 });
    });
  });

  test.describe("the workspace's switch", () => {
    test.use({ locale: "en-US" });

    const box = (page: Page) => page.getByLabel("Send a weekly summary every Monday morning");
    /**
     * Set the box and wait until a fresh page agrees. `AutoForm`'s success is
     * its quiet inline "Saved", never a toast (the code review's medium), and a
     * reload before the action lands would cancel it — so the reload is the
     * poll, as `settings.spec.ts`'s `savedWeekly` does.
     */
    const saved = async (page: Page, on: boolean) => {
      await box(page).setChecked(on);
      await expect
        .poll(
          async () => {
            await page.reload();
            return box(page).isChecked();
          },
          { timeout: 30_000 },
        )
        .toBe(on);
    };

    test.afterEach(async ({ page }) => {
      // On again, pass or fail: it is the workspace's default (C69 (d)).
      await page.goto("/settings/preferences");
      if (!(await box(page).isChecked())) await saved(page, true);
    });

    test("an owner switches the clients' summary off and on again in Settings", async ({ page }) => {
      await page.goto("/settings/preferences");
      await expect(box(page)).toBeChecked({ timeout: 30_000 });
      await saved(page, false);
      await saved(page, true);
    });
  });
});
