import { expect, test } from "@playwright/test";

import { readNotifications, requireSeed, resetNotifications, type E2ESeed } from "./fixtures/tenant";

/**
 * `/inbox` in a browser (UI.md §3.1 — "Core; unread badge").
 *
 * The fixture's one notification is REAL: the employee assigned a task
 * to the owner, so `notify.emit` produced it inside the assignment's
 * own transaction. This suite signs in as the owner (the standing
 * storage state) and drives the surface that notification lands on.
 *
 * EVERY READ-STATE ASSERTION IS AGAINST THE STORED ROW, never a toast.
 * The one assertion in this whole harness whose timing depends on
 * render scheduling rather than a server answer is a sonner toast, and
 * it has flaked twice (PLAN.md §0). Read state IS a stored fact, so the
 * fixture reads it back.
 *
 * The notification is put back unread after every test, pass or fail:
 * the rail badge is in all 180 screenshots the visual sweep takes, and
 * a run that left it read would silently change tomorrow's shots.
 */

let seed!: E2ESeed;

// A verb is a server action plus a refresh of the shell; on CI (US
// runner, EU database) the same waits get three times the leash.
const SLOW = process.env["CI"] ? 3 : 1;

test.beforeAll(() => {
  seed = requireSeed();
});

test.afterEach(async () => {
  await resetNotifications(seed.tenantId);
});

test.describe("inbox (owner)", () => {
  test("the rail badge counts it, the row says what it is about, and the subject is a link to the task", async ({
    page,
  }) => {
    await page.goto("/home");
    // The badge is an accessible fact, not only a coloured pill: the
    // rail's Inbox link announces the count.
    const inboxLink = page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: /Inbox/ });
    await expect(inboxLink.first()).toContainText("1 unread");

    await page.goto("/inbox");
    const row = page.getByTestId("inbox-row");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-read", "0");
    await expect(row).toContainText("A task was assigned to you");

    // The subject resolved: the owner holds the project, so the row
    // carries the task's real title and a link to its peek.
    const subject = row.getByRole("link", { name: "Designgranskning med kunden" });
    await expect(subject).toBeVisible();
    await subject.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${seed.projectKey}/backlog\\?item=${seed.projectKey}-`));
    await expect(page.getByTestId("item-peek")).toBeVisible({ timeout: 20_000 * SLOW });
  });

  test("mark as read empties the Unread tab and clears the badge — asserted in the database", async ({
    page,
  }) => {
    await page.goto("/inbox");
    await page.getByTestId("inbox-row").getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Mark as read" }).click();

    // The stored fact first, then the surface.
    await expect
      .poll(async () => (await readNotifications(seed.tenantId))[0]?.read, {
        timeout: 20_000 * SLOW,
      })
      .toBe(true);

    await expect(page.getByTestId("inbox-row")).toHaveCount(0, { timeout: 20_000 * SLOW });
    // Unread is a bucket, not a delete: the row is still in All.
    await page.goto("/inbox?filter=all");
    await expect(page.getByTestId("inbox-row")).toHaveCount(1);
    await expect(page.getByTestId("inbox-row")).toHaveAttribute("data-read", "1");

    // And the badge is gone from the rail on the next render.
    await page.goto("/home");
    const inboxLink = page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: /Inbox/ });
    await expect(inboxLink.first()).not.toContainText("unread");
  });

  test("archive files it out of All and into Archived, and restoring brings it back", async ({
    page,
  }) => {
    await page.goto("/inbox");
    await page.getByTestId("inbox-row").getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();

    await expect
      .poll(async () => (await readNotifications(seed.tenantId))[0]?.archived, {
        timeout: 20_000 * SLOW,
      })
      .toBe(true);

    await page.goto("/inbox?filter=all");
    await expect(page.getByTestId("inbox-row")).toHaveCount(0);
    await page.goto("/inbox?filter=archived");
    const archived = page.getByTestId("inbox-row");
    await expect(archived).toHaveCount(1);

    await archived.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Move back to inbox" }).click();
    await expect
      .poll(async () => (await readNotifications(seed.tenantId))[0]?.archived, {
        timeout: 20_000 * SLOW,
      })
      .toBe(false);
  });

  test("a snooze parks it in the Snoozed tab and out of the unread count", async ({ page }) => {
    await page.goto("/inbox");
    await page.getByTestId("inbox-row").getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Snooze until tomorrow morning" }).click();

    await expect
      .poll(async () => (await readNotifications(seed.tenantId))[0]?.snoozed, {
        timeout: 20_000 * SLOW,
      })
      .toBe(true);

    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-row")).toHaveCount(0);
    await page.goto("/inbox?filter=snoozed");
    await expect(page.getByTestId("inbox-row")).toHaveCount(1);
    // The badge follows the bucket: a parked row is not unread work.
    await page.goto("/home");
    const inboxLink = page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: /Inbox/ });
    await expect(inboxLink.first()).not.toContainText("unread");
  });

  test("empty buckets are `filtered`, not dead ends — each offers the bucket next to it", async ({
    page,
  }) => {
    await page.goto("/inbox?filter=archived");
    // `[data-slot="empty-state"]`, never a bare `[data-variant]`: every
    // Button carries that attribute too, and the bare selector matched
    // ten elements.
    const empty = page.locator('[data-slot="empty-state"]');
    await expect(empty).toHaveAttribute("data-variant", "filtered");
    // UI.md §5.8: a filtered empty state's verb is to widen the view.
    await empty.getByRole("link", { name: "See all notifications" }).click();
    await expect(page).toHaveURL(/\/inbox\?filter=all/);
    await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  });

  test("a page past the end does not claim the inbox is empty", async ({ page }) => {
    // The keyset walks `id` descending, so the all-zero UUID is a cursor
    // nothing can sort below — a stale or shared link, deterministically.
    // The nothing-yet copy here would tell a member with a full inbox
    // that they have none.
    await page.goto("/inbox?cursor=00000000-0000-0000-0000-000000000000");
    const empty = page.locator('[data-slot="empty-state"]');
    await expect(empty).toHaveAttribute("data-variant", "filtered");
    await expect(empty).toContainText("Nothing further back");
    await empty.getByRole("link", { name: "Back to the newest" }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  });

  test("a MALFORMED cursor is the first page, and says so in the bucket's own words", async ({
    page,
  }) => {
    // The mirror of the test above, and the lie it would tell pointed
    // the other way: `listInbox` answers a cursor it cannot parse with
    // the FIRST page, so an empty bucket reached that way is empty
    // because it is empty — not because the reader paged past the end.
    for (const cursor of ["", "garbage", "0000"]) {
      await page.goto(`/inbox?filter=archived&cursor=${cursor}`);
      const empty = page.locator('[data-slot="empty-state"]');
      await expect(empty, cursor).toContainText("Nothing archived");
      await expect(empty, cursor).not.toContainText("Nothing further back");
    }
  });
});
