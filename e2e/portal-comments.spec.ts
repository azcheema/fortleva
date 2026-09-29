import { expect, test } from "@playwright/test";

import { SLOW } from "./fixtures/keys";
import { CONTACT_STORAGE_STATE, STORAGE_STATE, requireSeed } from "./fixtures/tenant";

/**
 * THE PORTAL'S TASK PAGE AND ITS CONVERSATION, through a real contact
 * session (Phase 3 slice 75; founder decisions C41–C43).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT. `portal-comment.dbtest.ts`
 * calls the writer and the projection with a principal an assertion
 * built. This drives the whole vertical: a contact cookie, the task
 * title on the project page as the way in, `requirePortalContext()`,
 * the read under the contact principal, the RENDER of a thread signed
 * two ways — the client's own person by name, the agency as "Your
 * agency", never a member — the composer's server action writing under
 * the contact's principal, and the revalidated page drawing the words.
 * Then the other plane: the team opens the same task and reads the
 * client's comment under the client's name.
 *
 * THE NEGATIVE CONTROLS are the seed's: an INTERNAL note on this very
 * task, and the owner's name ("E2E Owner"), which wrote the agency's
 * reply — neither may be anywhere on the client's surface.
 *
 * The new comment STAYS (a contact cannot delete one, by design), and
 * every later spec tolerates it: the View-as comparison renders both
 * planes from the same rows, and the visual walk only photographs.
 */

const seed = requireSeed();

test.use({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });

test.describe("portal task page", () => {
  test("the title opens the task; the thread is signed by the client and by the agency; nothing internal", async ({
    page,
  }) => {
    await page.goto(`/portal/projects/${seed.projectKey}`);
    await expect(page.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 });
    // THE WAY IN is the task's own title, on the project page's list.
    await page.locator('[data-slot="portal-task-link"]', { hasText: seed.sharedTaskTitle }).first().click();
    await page.waitForURL(`**/portal/tasks/${seed.sharedTaskId}`, { timeout: 30_000 });

    const header = page.locator('[data-slot="page-header"]');
    await expect(header.locator("h1")).toHaveText(seed.sharedTaskTitle);
    // BACKLOG in the agency's vocabulary; "Planned" in the client's.
    await expect(header.locator('[data-slot="portal-category"]')).toHaveAttribute("data-value", "PLANNED");
    await expect(header.locator('[data-slot="portal-task-facts"]')).toContainText("E2E Project");

    const comments = page.locator('[data-slot="portal-comment"]');
    // Oldest first: the client's question, then the agency's reply.
    await expect(comments.nth(0)).toContainText(seed.portalCommentText);
    await expect(comments.nth(0)).toHaveAttribute("data-author", "contact");
    await expect(comments.nth(0)).toContainText(`${seed.contactName} (you)`);
    await expect(comments.nth(1)).toContainText(seed.portalReplyText);
    await expect(comments.nth(1)).toHaveAttribute("data-author", "agency");
    await expect(comments.nth(1)).toContainText("Your agency");

    // ── THE NEGATIVE CONTROLS ────────────────────────────────────────
    const surface = page.locator("[data-portal-surface]");
    await expect(surface).not.toContainText(seed.internalNoteText);
    await expect(surface).not.toContainText("E2E Owner");
  });

  test("a comment is written as the client, drawn in place, and read by the team under the client's name", async ({
    page,
    browser,
  }) => {
    await page.goto(`/portal/tasks/${seed.sharedTaskId}`);
    await expect(page.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 });

    const composer = page.locator('[data-slot="portal-comment-composer"]');
    // The two facts the reader needs BEFORE sending.
    await expect(composer).toContainText("Your agency will see this.");
    await expect(composer).toContainText("can't be edited or deleted");
    const input = page.getByTestId("portal-comment-input");
    const send = page.getByTestId("portal-comment-send");
    // Nothing typed, nothing to send.
    await expect(send).toBeDisabled();

    const words = `Går det bra att vi ses på fredag? ${Date.now()}`;
    await input.fill(words);
    await expect(send).toBeEnabled();
    await send.click();

    const comments = page.locator('[data-slot="portal-comment"]');
    const mine = comments.filter({ hasText: words });
    await expect(mine).toHaveCount(1, { timeout: 30_000 * SLOW });
    await expect(mine).toHaveAttribute("data-author", "contact");
    await expect(mine).toContainText(`${seed.contactName} (you)`);
    // The newest is last, and the box emptied only on the server's yes.
    await expect(comments.last()).toContainText(words);
    await expect(input).toHaveValue("");
    await expect(composer.locator('[role="status"]')).toHaveText("Comment sent.");
    await expect(page.getByTestId("portal-comment-error")).toHaveCount(0);

    // ⌘Enter / Ctrl+Enter sends from inside the box, as the member's does.
    const second = `Och en sak till ${Date.now()}`;
    await input.fill(second);
    await input.press("ControlOrMeta+Enter");
    await expect(comments.filter({ hasText: second })).toHaveCount(1, { timeout: 30_000 * SLOW });

    // ── THE TEAM'S SIDE: the same task, the client's words, the client's name.
    const member = await browser.newContext({ storageState: STORAGE_STATE, locale: "en-US" });
    try {
      const team = await member.newPage();
      await team.goto(`/projects/${seed.projectKey}/backlog?item=${seed.sharedTaskKey}`);
      const peek = team.getByTestId("item-peek");
      await expect(peek).toBeVisible({ timeout: 30_000 * SLOW });
      const row = peek.getByTestId("item-comment").filter({ hasText: words });
      await expect(row).toHaveCount(1, { timeout: 20_000 * SLOW });
      await expect(row).toContainText(seed.contactName);
      // A client's comment is one the client can see — its own chip says so.
      await expect(row.locator('[data-slot="visibility-badge"]')).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");
      // The seeded internal note is there for the team, and only for them.
      await expect(peek.getByTestId("item-comment").filter({ hasText: seed.internalNoteText })).toHaveCount(1);
    } finally {
      await member.close();
    }
  });

  test("a task the client cannot see is the plane's one empty page", async ({ page }) => {
    // Not a task id at all, and one that could be — the same answer.
    for (const id of ["not-a-task", "0199aaaa-0000-7000-8000-000000000000"]) {
      await page.goto(`/portal/tasks/${id}`);
      await expect(page.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-slot="empty-state"]')).toBeVisible();
      await expect(page.locator('[data-slot="portal-comment-composer"]')).toHaveCount(0);
    }
  });
});
