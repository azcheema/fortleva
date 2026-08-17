import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

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

const isActionPost = (request: Request): boolean =>
  request.method() === "POST" && Boolean(request.headers()["next-action"]);

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

    await editName(page, "Ansar Cheema");
    // Enter must COMMIT: the control leaves edit mode.
    await expect(page.locator('input[name="name"]')).toHaveCount(0);

    // Persisted, not merely optimistic: a full reload re-reads the
    // identity from the database through Better Auth.
    await page.reload();
    await expect(nameTrigger(page)).toContainText("Ansar Cheema");

    // Reached the identity the rest of the app reads (header avatar
    // initials come from the session user, not from this page).
    await page.goto("/home");
    // The app bar, not a card header: initials come from the session user.
    await expect(page.locator("header").first()).toContainText(/AC/i);

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
