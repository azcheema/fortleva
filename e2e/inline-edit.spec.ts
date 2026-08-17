import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

import { readMilestone, requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * FOUNDER MANDATE 1 — the read-first editable value, proved.
 *
 * A screenshot shows that the timeline no longer looks like a form. It
 * cannot show that the thing which replaced the input is still a
 * control: reachable by Tab, opened by Enter, cancelled by Escape,
 * committed by Enter, and — the part that would have been catastrophic
 * to get wrong — that editing ONE field does not erase the others.
 *
 * That last one is hazard H1. `<AutoForm>` posts the whole FormData and
 * `updateMilestoneAction` used to read an absent field as an erase, so
 * a name edit that unmounted the date control would have silently
 * blanked the due date and reset the visibility to INTERNAL. Two
 * mitigations shipped — a hidden input at rest, and `has()` guards in
 * the action — and this spec is the regression gate for both.
 *
 * Every fixture row lives in the throwaway "e2e-" tenant, and the test
 * restores the name it borrowed so the sweep photographs the fixture as
 * it was provisioned.
 */

let seed!: E2ESeed;

test.beforeAll(() => {
  seed = requireSeed();
});

const isActionPost = (request: Request): boolean =>
  request.method() === "POST" && Boolean(request.headers()["next-action"]);

/** Every `next-action` POST the page made, so "nothing was saved" is provable. */
function countActionPosts(page: Page): () => number {
  let posts = 0;
  page.on("request", (r) => {
    if (isActionPost(r)) posts += 1;
  });
  return () => posts;
}

/**
 * The row, located by its ACTIONS trigger rather than by its text.
 *
 * `hasText` reads text content, and the whole point of an inline edit is
 * that the name stops being text content the moment it becomes an
 * `<input>` value — so a hasText filter loses the row exactly when the
 * test needs it most. The `⋯` trigger's accessible name is rendered from
 * the server's copy of the name and stays put while the control is open.
 */
const rowFor = (page: Page, name: string): Locator =>
  page
    .locator("[data-slot=timeline-item]")
    .filter({ has: page.getByRole("button", { name: `Actions for ${name}` }) })
    .first();

/** The name value's rest state: the row's first text inline edit. */
const nameTrigger = (row: Locator): Locator =>
  row.locator('[data-slot=inline-edit][data-kind="text"]').first();

const nameField = (row: Locator): Locator =>
  row.locator('input[name="name"]:not([type=hidden])');

/**
 * Walk the tab ring until the wanted control has focus — the point of
 * the test is that a keyboard alone can get there, so nothing here may
 * click. A value that no number of Tab presses reaches is not editable,
 * whatever the mouse can do with it.
 */
async function tabTo(page: Page, target: Locator, limit = 120): Promise<number> {
  // Check before pressing: a control that has just returned focus to
  // itself after a commit is already where we want to be, and tabbing
  // off it would send the walk all the way around the document.
  for (let i = 0; i <= limit; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return i;
    await page.keyboard.press("Tab");
  }
  throw new Error(`no tab stop reached the target within ${limit} presses`);
}

test.describe("inline edit", () => {
  test("a value can be edited with the keyboard alone, and it persists", async ({ page }) => {
    const posts = countActionPosts(page);
    await page.goto(`/projects/${seed.projectKey}/timeline`);

    const original = seed.datedMilestoneName;
    const edited = `${original} kb`;
    const before = await readMilestone(seed.datedMilestoneId);
    expect(before.name).toBe(original);
    // The premise of the H1 half: both other columns are non-default.
    expect(before.dueAt).not.toBeNull();
    expect(before.visibility).toBe("CLIENT_VISIBLE");

    const row = rowFor(page, original);
    const trigger = nameTrigger(row);
    // Rest state: a real button with a real accessible name, and the
    // value is TEXT — no control is mounted for it.
    await expect(trigger).toHaveJSProperty("tagName", "BUTTON");
    expect(((await trigger.getAttribute("aria-label")) ?? "").trim()).not.toBe("");
    await expect(nameField(row)).toHaveCount(0);

    await tabTo(page, trigger);
    await page.keyboard.press("Enter");

    // Exactly one control, carrying the field name the action reads —
    // and the hidden twin is gone, or FormData.get() would return it.
    const field = nameField(row);
    await expect(field).toHaveCount(1);
    await expect(field).toBeFocused();
    await expect(row.locator('input[type=hidden][name="name"]')).toHaveCount(0);

    const answered = page.waitForResponse((res) => isActionPost(res.request()));
    // The control opens with its text selected, so typing replaces it.
    await page.keyboard.type(edited);
    await page.keyboard.press("Enter");
    await answered;

    // It persisted — after a full reload, from the server's own render.
    await page.reload();
    await expect(nameTrigger(rowFor(page, edited))).toBeVisible();

    // HAZARD H1: the columns nobody touched still say what they said.
    //
    // The due date is compared as a CALENDAR DAY, not as an instant, and
    // that is the honest comparison rather than a weakened one: the
    // control is an `<input type="date">`, so the field's precision has
    // always been the day. The fixture seeds `Date.now() - 14d`, which
    // carries a time of day; the first save through this form normalises
    // it to midnight — exactly as the always-mounted date input did
    // before the pass. Losing the DAY, or the visibility, would be the
    // erase H1 is about, and neither happens.
    const after = await readMilestone(seed.datedMilestoneId);
    expect(after.name).toBe(edited);
    expect(after.dueAt?.slice(0, 10)).toBe(before.dueAt?.slice(0, 10));
    expect(after.visibility).toBe(before.visibility);
    expect(posts()).toBeGreaterThan(0);

    // Put the fixture back the way the sweep expects to photograph it —
    // and, because the value is now normalised, assert the second edit
    // leaves the other two columns BYTE-identical.
    const restored = page.waitForResponse((res) => isActionPost(res.request()));
    await tabTo(page, nameTrigger(rowFor(page, edited)));
    await page.keyboard.press("Enter");
    await page.keyboard.type(original);
    await page.keyboard.press("Enter");
    await restored;
    await expect.poll(async () => (await readMilestone(seed.datedMilestoneId)).name).toBe(original);

    const settled = await readMilestone(seed.datedMilestoneId);
    expect(settled.dueAt).toBe(after.dueAt);
    expect(settled.visibility).toBe(after.visibility);
  });

  test("Escape cancels without saving anything", async ({ page }) => {
    const posts = countActionPosts(page);
    // Read the name from the database rather than from the seed: if the
    // test above failed before it restored the fixture, this test is
    // still about Escape and not about that failure.
    const original = (await readMilestone(seed.datedMilestoneId)).name;
    await page.goto(`/projects/${seed.projectKey}/timeline`);

    const row = rowFor(page, original);

    await tabTo(page, nameTrigger(row));
    await page.keyboard.press("Enter");
    await expect(nameField(row)).toBeFocused();

    const posted = posts();
    await page.keyboard.type("this must never be saved");
    await page.keyboard.press("Escape");

    // Back at rest, focus returned to the trigger it came from.
    await expect(nameField(rowFor(page, original))).toHaveCount(0);
    await expect(nameTrigger(rowFor(page, original))).toBeFocused();

    // Nothing was sent. Not "nothing was persisted" — nothing was SENT.
    await page.waitForTimeout(500);
    expect(posts()).toBe(posted);
    expect((await readMilestone(seed.datedMilestoneId)).name).toBe(original);

    // And it survives a reload, because it never left the browser.
    await page.reload();
    await expect(nameTrigger(rowFor(page, original))).toBeVisible();
  });

  test("F2 opens the editor and every rest state is a named button", async ({ page }) => {
    await page.goto(`/projects/${seed.projectKey}/timeline`);

    // Every inline edit on the page, not just the one under test.
    const triggers = page.locator("[data-slot=inline-edit]");
    const count = await triggers.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const el = triggers.nth(i);
      await expect(el).toHaveJSProperty("tagName", "BUTTON");
      expect(((await el.getAttribute("aria-label")) ?? "").trim()).not.toBe("");
    }

    // F2 is the spreadsheet alias, and it must work from the rest button.
    const name = (await readMilestone(seed.datedMilestoneId)).name;
    const row = rowFor(page, name);
    await tabTo(page, nameTrigger(row));
    await page.keyboard.press("F2");
    await expect(nameField(row)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(nameTrigger(rowFor(page, name))).toBeFocused();
  });
});
