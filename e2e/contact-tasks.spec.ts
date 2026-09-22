import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { SLOW, createOwnTask, deleteOwnTasks, picker, pressUntil, rail, searchField } from "./fixtures/keys";
import { CONTACT_STORAGE_STATE, requireSeed } from "./fixtures/tenant";

/**
 * A TASK THE AGENCY HANDS TO THE CLIENT (Phase 3 slice 6c) — the member
 * half of the round trip, in a real browser.
 *
 * WHAT ONLY A BROWSER CAN SAY HERE, and it is the reason the file
 * exists rather than a case bolted onto `item-properties.spec.ts`:
 *
 *  · **The `A` picker now has GROUPS.** cmdk owns the highlight, the
 *    steering keys and `aria-selected` for every descendant of
 *    `<Command>`, and this repo has a standing note that its behaviour
 *    is measured and never read off the source — two review verifiers
 *    once traced it to the opposite of what a headless browser showed.
 *    Whether a second group leaves "Unassign" reachable by `End`, and
 *    whether typing still narrows to one row across two groups, are
 *    facts about a rendered list.
 *  · **One pick changes TWO properties.** Handing an INTERNAL task over
 *    publishes it (`work_item_contact_assignee_visible` admits no third
 *    answer), and the visibility chip is a DIFFERENT island with its own
 *    canonical prop — so the flip reaching it depends on the refresh
 *    that `usePanelCommit` fires, which no unit or database test runs.
 *  · **The agency's own list must stop saying "Unassigned."** That was
 *    the state of the board between this slice's two commits.
 *  · **The client really can see it.** `contact-tasks.dbtest.ts` proves
 *    the row is CLIENT_VISIBLE and `portal.dbtest.ts` proves the
 *    projection returns such a row; only this shows one member's pick
 *    arriving on a screen behind a different cookie, a different table
 *    and a different secret.
 *
 * TWO BROWSER CONTEXTS, never two cookies in one jar — `triage.spec.ts`
 * records why: the planes are separate tables with separate secrets, and
 * a browser holding both is a state no real surface produces.
 *
 * EVERY TASK IS THIS FILE'S OWN and is deleted in `afterEach`, pass or
 * fail. Never a seeded one: the visual sweep photographs this project,
 * and a task left assigned to a contact would put a row on the portal's
 * stop in the 204-shot walk whose presence depended on whether the whole
 * suite or one file had been run.
 *
 * THE CONTACT'S DONE TICK IS NOT HERE — it ships with the portal half of
 * the slice, and this file grows the second half of the round trip with it.
 */

const seed = requireSeed();

/** The rail's assignee trigger, and the element carrying its value. */
const assignee = (page: Page): Locator => rail(page).getByTestId("item-assignee");
const assigneeValue = (page: Page): Locator => assignee(page).locator("[data-value]");
const said = (page: Page, text: string): Locator =>
  rail(page).locator('[role="status"]', { hasText: text });

/** What the contact's own portal shows, under the contact plane's jar. */
async function portalSays(browser: Browser, title: string, present: boolean): Promise<void> {
  const contact = await browser.newContext({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });
  try {
    const page = await contact.newPage();
    await page.goto("/portal");
    // The heading first: it proves the page RENDERED, so an absence below
    // is an absence in the list rather than a page that never arrived —
    // the difference between "the client cannot see it" and "the test
    // asked too early", which is the whole value of the assertion.
    await expect(page.getByRole("heading", { name: "Shared with you" })).toBeVisible({
      timeout: 30_000 * SLOW,
    });
    if (present) await expect(page.getByText(title)).toBeVisible({ timeout: 30_000 * SLOW });
    else await expect(page.getByText(title)).toHaveCount(0);
  } finally {
    await contact.close();
  }
}

test.describe("handing a task to the client", () => {
  const created: string[] = [];

  test.afterEach(async ({ page }) => {
    await deleteOwnTasks(page, seed, created);
    created.length = 0;
  });

  test("the A picker offers the client's people, the pick publishes the task, and the client sees it", async ({
    page,
    browser,
  }) => {
    const { title } = await createOwnTask(page, seed, "Hand over", created);

    // NOT YET THEIRS: a new task is INTERNAL, the product's default
    // everywhere, and nobody holds it.
    await expect(assigneeValue(page)).toHaveAttribute("data-value", "");
    await expect(rail(page).getByTestId("item-visibility")).toContainText("Private to team");
    await portalSays(browser, title, false);

    // TWO GROUPS, and the warning under them. The heading is what tells a
    // member the second list is not more colleagues; the line under it is
    // what tells them what picking one DOES, before they do it — §5.2 has
    // asked for that since the column existed.
    await pressUntil(page, "a", picker(page));
    // BY THE HEADING ATTRIBUTE, never by the words: a bare `getByText`
    // here matched the warning line as well as the heading and failed on
    // strict mode — which is the right failure, since "the words appear
    // somewhere in the popover" is not what this asserts.
    const heading = (text: string) => picker(page).locator("[cmdk-group-heading]", { hasText: text });
    await expect(heading("Your team")).toBeVisible();
    await expect(heading("At the client")).toBeVisible();
    await expect(picker(page).getByTestId("item-assignee-shares")).toBeVisible();

    // Typing narrows ACROSS both groups to the one contact.
    await page.keyboard.type("Astrid");
    const contactRow = picker(page).getByRole("option", { name: new RegExp(seed.contactName) });
    await expect(picker(page).getByRole("option")).toHaveCount(1);
    await expect(contactRow).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(picker(page)).toHaveCount(0);

    // ONE PICK, TWO PROPERTIES. The trigger names them, and the
    // visibility chip — a different island, fed by the refresh — says
    // the client can see it. A member must never learn that this was a
    // share by finding it on the client's screen.
    await expect(assigneeValue(page)).toHaveText(seed.contactName);
    await expect(said(page, `Assigned to ${seed.contactName}`)).toHaveCount(1, {
      timeout: 20_000 * SLOW,
    });
    await expect(rail(page).getByTestId("item-visibility")).toContainText("Client can see", {
      timeout: 20_000 * SLOW,
    });

    // It survives a reload, which an optimistic slice cannot fake.
    await page.reload();
    await expect(assigneeValue(page)).toHaveText(seed.contactName, { timeout: 20_000 * SLOW });

    // THE AGENCY'S OWN LIST STOPPED SAYING "Unassigned". Between this
    // slice's two commits it did not, which is a row that is assigned
    // saying it is not.
    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const row = page.locator('[data-slot="table-row"]', { hasText: title });
    await expect(row).toBeVisible({ timeout: 20_000 * SLOW });
    await expect(row).toContainText(seed.contactName);

    // AND THE BOARD CARD DRAWS IT — the surface where the first cut of
    // this slice failed and this spec did not look. A title-only task
    // has no checklist, no estimate, no logged time and no timer, so the
    // card's whole meta row was gated off and the assignee glyph never
    // rendered; the backlog assertion above passes either way. The
    // review that found it also found that this spec was why nothing
    // else would have.
    await page.goto(`/projects/${seed.projectKey}/board`);
    const card = page.locator('[data-testid="board-card"]', { hasText: title });
    await expect(card).toBeVisible({ timeout: 20_000 * SLOW });
    await expect(card.getByTestId("board-card-contact-assignee")).toBeVisible();

    // AND THE CLIENT CAN REALLY SEE IT — a different cookie, a different
    // table, a different secret.
    await portalSays(browser, title, true);
  });

  test("taking the task back leaves the client's copy shared and the picker empty", async ({ page }) => {
    await createOwnTask(page, seed, "Take back", created);

    await pressUntil(page, "a", picker(page));
    await page.keyboard.type("Astrid");
    await page.keyboard.press("Enter");
    await expect(assigneeValue(page)).toHaveText(seed.contactName);
    await expect(rail(page).getByTestId("item-visibility")).toContainText("Client can see", {
      timeout: 20_000 * SLOW,
    });

    // `End` still reaches "Unassign" WITH a second group above it — the
    // one thing a grouped cmdk list could quietly have broken, since the
    // clear row is the last row of the last group rather than of the only
    // one. Unassigning is how a task comes back from a client: the same
    // action a member picks a colleague with, because the row holds one
    // assignment and "nobody" is one answer.
    await pressUntil(page, "a", picker(page));
    await expect(searchField(page)).toBeFocused();
    await page.keyboard.press("End");
    await expect(picker(page).getByTestId("item-assignee-clear")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.keyboard.press("Enter");
    await expect(picker(page)).toHaveCount(0);
    await expect(assigneeValue(page)).toHaveAttribute("data-value", "");
    await expect(said(page, "Assignee removed")).toHaveCount(1, { timeout: 20_000 * SLOW });

    // AND THE TASK IS STILL SHARED, which is the founder-facing fact
    // worth pinning: taking work back is not a decision to hide it, and
    // nothing in `assignItem` reverses a visibility flip. A member who
    // wants it private again says so with `V` — which then ends any
    // assignment itself, the other direction of the same rule.
    await expect(rail(page).getByTestId("item-visibility")).toContainText("Client can see");
  });
});
