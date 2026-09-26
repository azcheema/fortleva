import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { actionAnswered } from "./fixtures/actions";
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
 * **AND SINCE THE THIRD COMMIT, THE ROUND TRIP CLOSES HERE.** The client
 * ticks "I've done my part" on the portal, and the agency sees it on
 * `/home` — two planes, two cookies, two tables, one row. That sentence
 * is the whole of the founder's 2026-09-22 decision, and no unit or
 * database test can say it: the dbtest proves the column and the
 * projection, and only a browser proves that a button on one plane puts a
 * line on a page behind the other.
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

/**
 * Press the client's own "I've done my part" on a task, under the contact
 * plane's jar, and hand back nothing — the assertion is what the AGENCY
 * then sees. `expect` on the button's own `data-done` first, so a failure
 * further on is about the member plane rather than about a click that
 * never landed.
 */
async function tickOnPortal(browser: Browser, title: string, done: boolean): Promise<void> {
  const contact = await browser.newContext({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });
  try {
    const page = await contact.newPage();
    await page.goto("/portal");
    const row = page.locator("li", { hasText: title }).last();
    await expect(row).toBeVisible({ timeout: 30_000 * SLOW });
    const tick = row.getByTestId("portal-task-done");
    await expect(tick).toHaveAttribute("data-done", done ? "false" : "true");
    // **ARMED BEFORE THE CLICK, AWAITED AFTER IT** — `actionAnswered`'s
    // own contract, and this test needed it for the reason that helper
    // exists. The tick is OPTIMISTIC: `data-done` flips the instant the
    // button is pressed, so asserting on it proves the paint and nothing
    // about the write, and the first cut of this helper then handed
    // control back to a test that immediately read `/home` on the member
    // plane. It found the old value and reported a missing card.
    //
    // NO `contains` FILTER, and that is safe on THIS plane specifically.
    // The helper asks for a subject because the member shell's timer pill
    // posts actions of its own that would resolve the wait early — and
    // the portal has no shell, no timer pill and no ⌘K (UI.md §11), so
    // the only action POST a contact's page can make is this one.
    const answered = actionAnswered(page);
    await tick.click();
    await answered;
    // The paint, and then the absence of a refusal — which unwinds it.
    await expect(tick).toHaveAttribute("data-done", done ? "true" : "false", {
      timeout: 30_000 * SLOW,
    });
    await expect(row.getByTestId("portal-task-done-error")).toHaveCount(0);
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

  test("the client ticks 'done', the agency sees it on /home, and the untick takes it back", async ({
    page,
    browser,
  }) => {
    const { title } = await createOwnTask(page, seed, "Round trip", created);
    await pressUntil(page, "a", picker(page));
    await page.keyboard.type("Astrid");
    await page.keyboard.press("Enter");
    await expect(assigneeValue(page)).toHaveText(seed.contactName);
    // **WAIT ON THE LIVE REGION, NOT ON THE TRIGGER, BEFORE NAVIGATING.**
    // The picker is OPTIMISTIC: the trigger shows the name the instant
    // the row is picked, so the assertion above is satisfied before the
    // server has been asked — and the first cut of this test then left
    // for `/home` mid-flight and found no card, which read as a missing
    // feature. `usePanelCommit` announces only after it has ADOPTED the
    // canonical row, so this is the one signal on the page that means
    // the write landed. Exactly the race the slice-6b reviews found in
    // the triage lane's spec, in a new file.
    await expect(said(page, `Assigned to ${seed.contactName}`)).toHaveCount(1, {
      timeout: 20_000 * SLOW,
    });

    // BEFORE THE TICK: the task is on /home under "still with them", and
    // NOT under the group that means the agency is the hold-up. Asserting
    // both is what makes the move below a move rather than an appearance.
    await page.goto("/home");
    const still = page.getByTestId("home-waiting-still");
    await expect(still).toContainText(title, { timeout: 20_000 * SLOW });
    await expect(page.getByTestId("home-waiting-ticked").filter({ hasText: title })).toHaveCount(0);

    // THE CLIENT'S OWN PRESS, behind their own cookie.
    await tickOnPortal(browser, title, true);

    // AND THE AGENCY SEES IT MOVE — the whole point of the slice, and the
    // one claim only a browser can make. `reload`, not `goto`: /home is
    // already the current URL and a `goto` to the same address can be a
    // no-op navigation.
    await page.reload();
    await expect(page.getByTestId("home-waiting-ticked")).toContainText(title, {
      timeout: 20_000 * SLOW,
    });
    // **`filter().toHaveCount(0)`, NEVER `not.toContainText`**: a group
    // with no rows is not rendered at all (the card draws each group only
    // if it has one), and `not.toContainText` on a locator that matches
    // nothing fails with "element(s) not found" rather than passing. The
    // first cut asserted the negation and went red on a working feature —
    // the row really had moved out of this group.
    await expect(page.getByTestId("home-waiting-still").filter({ hasText: title })).toHaveCount(0);

    // **THE RETRACTION IS NOT A NICETY** (the service's own note): nothing
    // on the member plane can clear a claim except answering it, so
    // without an untick a mis-tick would stand as a falsehood only the
    // agency could remove — by finishing work that is not finished.
    await tickOnPortal(browser, title, false);
    await page.reload();
    await expect(page.getByTestId("home-waiting-still")).toContainText(title, {
      timeout: 20_000 * SLOW,
    });
    await expect(page.getByTestId("home-waiting-ticked").filter({ hasText: title })).toHaveCount(0);
  });

  test("the View-as preview draws the client's control and refuses to let a member press it", async ({
    page,
  }) => {
    const { title } = await createOwnTask(page, seed, "Look dont touch", created);
    await pressUntil(page, "a", picker(page));
    await page.keyboard.type("Astrid");
    await page.keyboard.press("Enter");
    await expect(assigneeValue(page)).toHaveText(seed.contactName);
    // The same wait, for the same reason — this test navigates too, and
    // it passed only because it happened to be slower.
    await expect(said(page, `Assigned to ${seed.contactName}`)).toHaveCount(1, {
      timeout: 20_000 * SLOW,
    });

    // The member-plane preview of the client's screen. It DRAWS the tick
    // — that is what "you see exactly what they see" means, and the
    // byte-comparison in `view-as.spec.ts` depends on it being the same
    // markup — but the surface is `inert`, so the control is not in the
    // focus order and cannot be pressed. Without that, a member pressing
    // it would reach `requirePortalContext()`, find no contact session and
    // be bounced to the client sign-in page (founder decision, 2026-09-22).
    await page.goto(`/projects/${seed.projectKey}/portal`);
    // The button names the contact (`viewAs.enter`), the locator
    // `view-as.spec.ts` already uses.
    // EXACT: since the Timeline slice the tab carries a second door,
    // "View this project as …", and a regex on the name matched both.
    await page.getByRole("button", { name: `View as ${seed.contactName}`, exact: true }).click();
    await expect(page).toHaveURL(/\/view-as/, { timeout: 30_000 * SLOW });
    const tick = page.locator("li", { hasText: title }).last().getByTestId("portal-task-done");
    await expect(tick).toBeVisible({ timeout: 30_000 * SLOW });

    // IT IS DRAWN, AND IT IS DEAD. Two probes, because neither alone says
    // it: the first is structural (the control sits inside an `inert`
    // subtree, the idiom `view-as.spec.ts` uses for the banner), the
    // second is the BEHAVIOUR that matters and is measured rather than
    // inferred from the attribute — an inert subtree is not focusable, so
    // a focus attempt leaves the active element elsewhere. Playwright's
    // `toBeEnabled` is no use here: it reads the `disabled` property and
    // knows nothing about `inert`.
    expect(await tick.evaluate((el) => el.closest("[inert]") !== null)).toBe(true);
    expect(
      await tick.evaluate((el) => {
        (el as HTMLElement).focus();
        return el.ownerDocument.activeElement === el;
      }),
    ).toBe(false);

    // **LEAVE THE MODE, and it is not politeness.** `Session.viewAsContactId`
    // is SERVER-side state on the member session, behind the storage
    // state every spec in the suite shares — so a test that enters
    // View-as and walks away leaves the next file to find the member
    // inside it. `view-as.spec.ts` treats being outside the mode as a
    // precondition it restores for exactly this reason. Found by a fresh
    // code review; the suite is `workers: 1, fullyParallel: false`, so
    // the damage would have been order-dependent rather than racy, which
    // is the kind that gets called flaky.
    await page.getByRole("button", { name: "Exit client view" }).click();
    await expect(page).toHaveURL(/\/home/, { timeout: 30_000 * SLOW });
  });
});
