import { expect, test, type Page } from "@playwright/test";

import {
  clearPlantedNotifications,
  plantNotifications,
  readNotifications,
  requireSeed,
  resetNotifications,
  type E2ESeed,
} from "./fixtures/tenant";

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
  // The planted rows first (slice 104): the rail badge counts ONE unread in
  // every screenshot, and a planted row left behind would make it three.
  await clearPlantedNotifications(seed.tenantId);
  await resetNotifications(seed.tenantId);
});

/** The focused element's notification id — or its name or tag, to say where focus went instead. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) return null;
    return el.dataset["notificationId"] ?? el.getAttribute("aria-label") ?? el.tagName;
  });

/**
 * `J` is the registry's ENTRY into the list — it acts only when no row holds
 * focus. Clicking the page heading puts focus nowhere in particular (a
 * heading is not focusable), and the loop covers hydration: a press before
 * the scope mounts does nothing.
 */
const enterList = async (page: Page, first: string) => {
  await expect(async () => {
    await page.getByRole("heading", { level: 1, name: "Inbox" }).click();
    await page.keyboard.press("j");
    expect(await focused(page)).toBe(first);
  }).toPass({ timeout: 30_000 * SLOW });
};

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
    // The row's own CLOCK, not `⋯` (slice 104).
    await page.getByTestId("inbox-row").getByRole("button", { name: /^Snooze:/ }).click();
    await page.getByRole("menuitem", { name: "Snooze until tomorrow morning" }).click();
    // The only row left the tab through a MENU: focus is on the list, never
    // on the page — where every single key would act (Radix would have
    // returned it to a trigger that no longer exists).
    await expect.poll(() => focused(page)).toBe("Notifications");

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

  test("day headings, and why each row reached you", async ({ page }) => {
    const planted = await plantNotifications(seed.tenantId, seed.memberId);
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-row")).toHaveCount(3);

    // The 40-day-old row is under "Older" whatever the hour — no assertion
    // here depends on which side of midnight the run is.
    const olderRow = page.locator(`[data-notification-id="${planted.older}"]`);
    const olderGroup = page.getByTestId("inbox-group").filter({ has: olderRow });
    await expect(olderGroup).toHaveAttribute("data-group", "older");
    await expect(olderGroup.getByRole("heading", { level: 2 })).toHaveText("Older");
    // …and it is the LAST group: the list stays newest first.
    await expect(page.getByTestId("inbox-group").last()).toHaveAttribute("data-group", "older");

    // The reason tag — and none where it would repeat the row's own label.
    await expect(page.locator(`[data-notification-id="${planted.today}"]`).getByTestId("inbox-reason")).toHaveText(
      "You lead this project",
    );
    await expect(olderRow.getByTestId("inbox-reason")).toHaveText("Assigned to you");
    const standing = page.getByTestId("inbox-row").filter({ hasText: "A task was assigned to you" });
    await expect(standing).toHaveCount(1);
    await expect(standing.getByTestId("inbox-reason")).toHaveCount(0);
  });

  test("J and K walk the rows; E archives the focused one and focus moves to the next", async ({ page }) => {
    const planted = await plantNotifications(seed.tenantId, seed.memberId);
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-row")).toHaveCount(3);
    const standingId = await page
      .getByTestId("inbox-row")
      .filter({ hasText: "A task was assigned to you" })
      .getAttribute("data-notification-id");

    // Newest first: the planted "now" row, the standing one, the old one.
    await enterList(page, planted.today);
    await page.keyboard.press("j");
    await expect.poll(() => focused(page)).toBe(standingId);
    await page.keyboard.press("j");
    await expect.poll(() => focused(page)).toBe(planted.older);
    // The end is the end — a letter there is consumed, never a jump to the top.
    await page.keyboard.press("j");
    await expect.poll(() => focused(page)).toBe(planted.older);
    await page.keyboard.press("k");
    await page.keyboard.press("k");
    await expect.poll(() => focused(page)).toBe(planted.today);

    await page.keyboard.press("e");
    await expect(page.locator(`[data-notification-id="${planted.today}"]`)).toHaveCount(0);
    await expect.poll(() => focused(page)).toBe(standingId);
    await expect
      .poll(async () => (await readNotifications(seed.tenantId)).find((n) => n.id === planted.today)?.archived, {
        timeout: 20_000 * SLOW,
      })
      .toBe(true);
  });

  test("U toggles read; S opens the snooze choices, and the keyboard alone snoozes", async ({ page }) => {
    // In All, neither verb takes the row away.
    await page.goto("/inbox?filter=all");
    const row = page.getByTestId("inbox-row");
    await expect(row).toHaveCount(1);
    const id = await row.getAttribute("data-notification-id");
    await enterList(page, id!);

    await page.keyboard.press("u");
    await expect
      .poll(async () => (await readNotifications(seed.tenantId))[0]?.read, { timeout: 20_000 * SLOW })
      .toBe(true);
    await expect(row).toHaveAttribute("data-read", "1");
    await page.keyboard.press("u");
    await expect
      .poll(async () => (await readNotifications(seed.tenantId))[0]?.read, { timeout: 20_000 * SLOW })
      .toBe(false);

    // S opens the clock's menu; Escape puts focus back INSIDE the row, so
    // the row's keys still work.
    await page.keyboard.press("s");
    await expect(page.getByRole("menuitem", { name: "Snooze for 3 hours" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest("[data-inbox-row]") !== null))
      .toBe(true);

    await page.keyboard.press("s");
    await expect(page.getByRole("menuitem", { name: "Snooze for 3 hours" })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await readNotifications(seed.tenantId))[0]?.snoozed, { timeout: 20_000 * SLOW })
      .toBe(true);
    // A snoozed row stays in All, and its clock now offers to bring it back.
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: /^Snooze:/ }).click();
    await expect(page.getByRole("menuitem", { name: "Bring it back now" })).toBeVisible();
    await page.keyboard.press("Escape");
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
