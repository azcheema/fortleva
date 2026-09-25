import { expect, test, type Browser, type Page, type Route } from "@playwright/test";

import {
  CONTACT_STORAGE_STATE,
  STORAGE_STATE,
  clearPortalRequests,
  readPortalRequests,
  requireSeed,
} from "./fixtures/tenant";
import { isActionPost } from "./fixtures/actions";

/**
 * THE TRIAGE LANE, END TO END (Phase 3 slice 6b).
 *
 * WHAT THIS PROVES THAT NEITHER THE DBTEST NOR A UNIT TEST CAN: the
 * ROUND TRIP. `triage.dbtest.ts` proves the service writes the right
 * row; `portal.dbtest.ts` proves the projection returns it. Only a
 * browser can show that a client's own words reach a member's screen, a
 * member's reply reaches the client's, and that the two are the same
 * string after crossing two authentication planes, a server action, a
 * revalidation and a projection.
 *
 * **AND ONE PROPERTY THAT IS ONLY OBSERVABLE HERE**: the keyboard. The
 * `triage` scope has been declared and empty since 2W and this is the
 * first surface to mount it. Whether `A` actually answers the focused
 * request depends on the dispatcher's guard order, on `G` not being
 * armed, on no Radix layer holding the keyboard, and on the row being
 * the thing that has focus — none of which is visible from the source.
 * This repo has a standing note about exactly that: two review verifiers
 * once traced cmdk's source to the opposite of what a headless browser
 * showed.
 *
 * THE FIXTURE IS HANDED BACK IN `afterAll`, NOT IN A `finally`, for the
 * reason `portal-requests.spec.ts` records: a Playwright TIMEOUT
 * abandons the body and every await in a `finally` fails immediately, so
 * the undo would not run. This file sorts BEFORE `view-as.spec.ts`,
 * `visibility.spec.ts`, `visual.spec.ts` and the Swedish width walk, so
 * a leftover request would put a "Requested" — or worse, a "Declined" —
 * group into the portal's stop in the visual sweep, and its presence
 * would depend on whether the whole suite or one file had been run.
 *
 * TWO BROWSER CONTEXTS, never two cookies in one jar: the planes are
 * separate tables with separate secrets, and a browser holding both is a
 * state no real surface produces.
 */

const seed = requireSeed();

/** Submit a request as the contact, and hand back its title. */
async function submitRequest(browser: Browser, body: string): Promise<string> {
  const title = `Triage subject ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const contact = await browser.newContext({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });
  try {
    const page = await contact.newPage();
    await page.goto("/portal/requests/new");
    await page.getByLabel("What do you need?").fill(title);
    await page.getByLabel("More detail").fill(body);
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page).toHaveURL(/\/portal$/, { timeout: 30_000 });
  } finally {
    await contact.close();
  }
  return title;
}

/** What the contact's own portal shows for a task, by title. */
async function portalRow(browser: Browser, title: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const contact = await browser.newContext({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });
  const page = await contact.newPage();
  await page.goto("/portal");
  await expect(page.getByText(title)).toBeVisible({ timeout: 30_000 });
  return { page, close: () => contact.close() };
}

const laneRow = (page: Page, title: string) =>
  page.getByTestId("triage-row").filter({ hasText: title });

/**
 * One category's group on the contact's portal card. Asserting on the
 * GROUP rather than on a bare "Cancelled" somewhere on the page is what
 * makes "this request is under Cancelled and not under Declined" a
 * statement about the row (C31), and it stays true when another spec's
 * leftover puts a second answered request on the same card.
 *
 * BY THE GROUP'S OWN ATTRIBUTE, not by "a section holding the chip":
 * `SectionCard` wraps every group in a `<section>` of its own, so that
 * shape matched the whole card as well — the negative assertion below
 * would then fail against any leftover Declined request on the card,
 * and the positive ones would pass against a title anywhere on it. Both
 * fresh reviews of slice 65 found it.
 */
const portalGroup = (page: Page, category: "PLANNED" | "CANCELLED" | "DECLINED") =>
  page.locator(`[data-slot="portal-group"][data-category="${category}"]`);

/**
 * Accept a request from the lane, so it becomes ordinary work — the state
 * C29 is about: out of the lane, every move target refusing Cancelled,
 * and nothing but the Cancel-and-reply doors able to end it.
 */
async function accept(page: Page, title: string): Promise<void> {
  await page.goto(`/projects/${seed.projectKey}/triage`);
  const row = laneRow(page, title);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Accept" }).click();
  await expect(row).toHaveCount(0, { timeout: 30_000 });
  // The server agreed — before anything reads the board.
  await expect(page.getByText("accepted", { exact: false })).toBeVisible({ timeout: 30_000 });
}

/** The toast every Cancel-and-reply door shows when the client can read the reply. */
const CANCELLED_AND_SEEN = /cancelled\. Your client can read your reply\./;

/** Fail after `ms` instead of hanging to the test timeout, which would skip the `finally` that un-routes (time.spec.ts has the same helper). */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)),
  ]);
}

test.use({ storageState: STORAGE_STATE, locale: "en-US" });

test.describe("the triage lane", () => {
  test.afterAll(async () => {
    await clearPortalRequests(seed.tenantId, seed.contactEmail);
  });

  test("a client asks, a member declines with a reason, the client reads it", async ({ page, browser }) => {
    const body = "Could you rebuild the whole site in Flash?";
    const title = await submitRequest(browser, body);

    // ── The member's side: the request is in the lane, in the client's
    //    own words ────────────────────────────────────────────────────
    await page.goto(`/projects/${seed.projectKey}/triage`);
    const row = laneRow(page, title);
    await expect(row).toBeVisible({ timeout: 30_000 });
    // THE CLIENT'S PARAGRAPH IS ON THE MEMBER'S SCREEN. Without it the
    // lane would be a list of one-line titles and the member would have
    // to open each task to answer it.
    await expect(row).toContainText(body);

    // ── The answer ───────────────────────────────────────────────────
    const reply = "Flash has not run in a browser since 2020 — we would build this in HTML instead.";
    await row.getByRole("button", { name: "Decline" }).click();
    // THE WARNING IS PART OF THE CONTRACT, not decoration: this is the
    // only field in the product where a member types for a client, and
    // the dialog has to say so before they start.
    await expect(page.getByText("Your client reads this, word for word, on their portal.")).toBeVisible();
    await page.getByLabel("Your reply").fill(reply);
    await page.getByRole("button", { name: "Decline and reply" }).click();

    // The row leaves the lane at once — it is removed OPTIMISTICALLY,
    // before the server is asked.
    await expect(row).toHaveCount(0, { timeout: 30_000 });
    // …so this is the assertion that the server AGREED, and it has to
    // come before any read of the database. The first cut of this test
    // went straight from the line above to the row read below and was
    // flaky by construction: it raced its own action and saw the row
    // still in TRIAGE. The success toast is the only member-visible
    // signal that the write landed, which is exactly why it is the
    // right thing to wait on — a refusal toasts the error instead and
    // puts the row back.
    await expect(page.getByText("Your client can read your reply")).toBeVisible({
      timeout: 30_000,
    });

    // ── The database, which neither screen shows ─────────────────────
    const rows = await readPortalRequests(seed.tenantId);
    const mine = rows.find((r) => r.title === title);
    expect(mine, "the request is still in the database").toBeDefined();
    expect(mine!.stateCategory).toBe("CANCELLED");
    expect(mine!.triageStatus).toBe("DECLINED");
    // It stays CLIENT_VISIBLE — that is what lets the client read the
    // answer at all. A decline is not a retraction.
    expect(mine!.visibility).toBe("CLIENT_VISIBLE");
    // Nobody agreed to this, so nothing says they did (C31).
    expect(mine!.acceptedAt).toBeNull();

    // ── The client's side: the whole point of the slice ──────────────
    // Before 6b this row simply vanished from their list the moment the
    // agency said no. Now it says Declined and carries the words above —
    // DECLINED, because it was turned down at the door (C31 gives agreed
    // work its own word; the board-card test below drives that one).
    const portal = await portalRow(browser, title);
    try {
      const declined = portalGroup(portal.page, "DECLINED");
      await expect(declined.getByText(title)).toBeVisible();
      await expect(declined.getByText(reply)).toBeVisible();
    } finally {
      await portal.close();
    }
  });

  test("a member accepts a request with the `A` key, and the client sees it planned", async ({ page, browser }) => {
    const title = await submitRequest(browser, "Please add a contact form to the site.");

    await page.goto(`/projects/${seed.projectKey}/triage`);
    const row = laneRow(page, title);
    await expect(row).toBeVisible({ timeout: 30_000 });

    // THE KEYBOARD, WHICH IS THE HALF ONLY A BROWSER CAN JUDGE. `J` is
    // the registry's ENTRY into the list — it acts only when no row
    // holds focus — and `A` is a `run: null` binding handled on the list
    // itself, so it answers the row that has focus and nothing else.
    // CLICK SOMETHING THAT IS NOT A ROW, or this measures nothing: the
    // rows are `tabIndex={-1}` and therefore mouse-focusable, so a click
    // inside the list lands ON a row — `enterList` then early-returns
    // (focus is already in the list) and the assertion below passes
    // without the entry path ever running. It would also INVERT into a
    // failure the day the lane holds two rows, because `j` would step to
    // the second. Found by review; the card heading is the neutral spot.
    await page.getByRole("heading", { name: "Triage", exact: true }).click();
    await page.keyboard.press("j");
    await expect(row).toBeFocused();
    await page.keyboard.press("a");

    await expect(row).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText("accepted", { exact: false })).toBeVisible();

    const rows = await readPortalRequests(seed.tenantId);
    const mine = rows.find((r) => r.title === title);
    expect(mine!.stateCategory).toBe("TODO");
    // ACCEPTED IS NEVER STORED as a status — accepting clears every
    // triage column, so the row becomes ordinary work (DATA_MODEL §6.14,
    // amended by this slice) — but the MOMENT is (C31): it is what lets
    // the portal call this "Cancelled" rather than "Declined" if the
    // agency later stops it.
    expect(mine!.triageStatus).toBeNull();
    expect(mine!.acceptedAt).not.toBeNull();

    // The client's list stops saying "Requested" and starts saying
    // "Planned" — the same row, a different promise.
    const portal = await portalRow(browser, title);
    try {
      await expect(portal.page.getByText("Planned", { exact: true })).toBeVisible();
    } finally {
      await portal.close();
    }
  });

  test("the duplicate picker chooses only what the member picks", async ({ page, browser }) => {
    // **THE PATH THAT HAD THREE BUGS BECAUSE NOTHING DROVE IT.** A fresh
    // review found all three in one file: cmdk's HIGHLIGHT was wired
    // straight to the chosen id (so the dialog opened with a target
    // nobody picked, and typing silently re-pointed it), the search
    // scored the member's typing against a UUID because that was each
    // row's cmdk `value`, and the "no open tasks" line rendered above a
    // populated list. Each is invisible to typecheck and to a unit test
    // and obvious the moment a browser opens the dialog.
    const title = await submitRequest(browser, "Please add a contact form.");

    await page.goto(`/projects/${seed.projectKey}/triage`);
    const row = laneRow(page, title);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Duplicate of…" }).click();

    // NOTHING IS CHOSEN ON OPEN. cmdk lights its first row by itself;
    // that is a cursor, not a decision, and the confirm button must not
    // act as though the member had made one.
    const confirm = page.getByRole("button", { name: "Mark duplicate and reply" });
    await expect(page.getByLabel("Your reply")).toBeVisible();
    await expect(confirm).toBeDisabled();

    // The search matches TITLES, not ids. The seeded project has work in
    // it; one row is enough to prove the filter reaches the text.
    const search = page.getByPlaceholder("Search this project's tasks");
    await search.fill("zzz-no-such-task-zzz");
    await expect(page.getByText("No open tasks to point at.")).toBeVisible();
    // …and that line is GONE again once the list has rows, which is the
    // half that was permanently on screen.
    await search.fill("");
    await expect(page.getByText("No open tasks to point at.")).toHaveCount(0);

    // Choosing is a click, and only then is the verb available.
    await page.getByRole("option").first().click();
    await page.getByLabel("Your reply").fill("Already tracked — we will let you know when it ships.");
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(row).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText("Your client can read your reply")).toBeVisible({ timeout: 30_000 });

    const rows = await readPortalRequests(seed.tenantId);
    const mine = rows.find((r) => r.title === title);
    expect(mine!.triageStatus).toBe("DUPLICATE");
    expect(mine!.stateCategory).toBe("CANCELLED");
  });

  test("the Triage tab is drawn for a member who holds the permission", async ({ page }) => {
    // NAMED FOR WHAT IT MEASURES. The first version of this test was
    // called "the lane is not reachable without the permission" and
    // asserted the tab IS visible for a member who HOLDS it — a claim
    // the file did not back, which is the same vacuous shape the first
    // commit of this slice was corrected for (both fresh reviews caught
    // it here). The refusal paths are `triage.dbtest.ts`'s, where a seat
    // WITHOUT the permission and a seat without the scope can both be
    // built and told apart by their reason; the harness has one member
    // and it holds everything.
    await page.goto(`/projects/${seed.projectKey}`);
    await expect(page.getByRole("link", { name: "Triage", exact: true })).toBeVisible({
      timeout: 30_000,
    });
  });

  test("/home carries the triage count, and the row is the way into the lane", async ({ page, browser }) => {
    // WHAT ONLY A BROWSER CAN SAY HERE. The count itself is pinned
    // against the lane's own rows in `triage.dbtest.ts`; what no dbtest
    // can establish is that the card RENDERS on the landing page at all
    // — it is drawn only when something is waiting, behind two
    // permissions and a scope-composed query — and that its row is a
    // real link to a lane that then shows the request. Rule 8's card
    // waited since 2W for a writer; this is the proof it arrived.
    const title = await submitRequest(browser, "Please add a second contact form.");

    await page.goto("/home");
    const card = page.getByTestId("home-triage");
    await expect(card).toBeVisible({ timeout: 30_000 });

    // Identified by where it GOES, not by the project's name: the seed
    // does not publish one, and the link target is the row's actual
    // contract anyway.
    const row = card.getByTestId("home-triage-row").filter({
      has: page.locator(`a[href="/projects/${seed.projectKey}/triage"]`),
    });
    await expect(row).toBeVisible({ timeout: 30_000 });
    // /home is a GLANCE: it names the project, never the client's words.
    // A request title leaking onto the landing page would make this card
    // a second lane, and a smaller one. Asserted on the whole CARD
    // rather than the row — widening it costs nothing and covers the
    // "N more projects" line too (security review). It is preceded by a
    // visibility assertion on purpose: a `not.toContainText` against a
    // locator that resolves to nothing passes trivially.
    await expect(card).not.toContainText(title);

    // THE ROW IS THE LINK — clicked, not navigated past. A card whose
    // number is right and whose row goes nowhere is the failure §5.8
    // exists to prevent.
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${seed.projectKey}/triage$`), { timeout: 30_000 });
    await expect(laneRow(page, title)).toBeVisible({ timeout: 30_000 });
  });
});

/**
 * C29b: THE MENUS' DOORS. An accepted request is ordinary work on the
 * board and the backlog, where every move target refuses Cancelled for
 * it — so a card's menu and a row's menu carry "Cancel and reply…",
 * opening the lane's own dialog through the hook the item panel's band
 * uses too. `triage.dbtest.ts` proves the verb and `work.dbtest.ts` the
 * cap; what only a browser can show is the part in between: a Radix menu
 * handing off to a Radix dialog, where focus goes when that dialog closes
 * (the menu item it opened from is gone by then), a card that re-renders
 * in another column, and what the member is told — and keeps — when the
 * round trip fails.
 */
test.describe("ending a client request from the board, the backlog and the item panel", () => {
  test.afterAll(async () => {
    await clearPortalRequests(seed.tenantId, seed.contactEmail);
  });

  test("a board card's menu ends it, focus stays with the card either way, and the client reads the reply", async ({
    page,
    browser,
  }) => {
    const title = await submitRequest(browser, "Please build a members-only area.");
    await accept(page, title);

    await page.goto(`/projects/${seed.projectKey}/board`);
    const card = page.locator('[data-testid="board-card"]', { hasText: title });
    await expect(card).toBeVisible({ timeout: 30_000 });

    // DISMISSED FIRST — nothing is written, and focus is back on the CARD:
    // the menu item the dialog opened from is gone by the time it closes,
    // so `useFocusReturn` alone would leave focus on <body>. The dismiss
    // says "Go back" beside a confirm that says "Cancel and reply" — never
    // "Cancel", which in Swedish is the confirm's own first word (Avbryt /
    // Avbryt och svara), and dismissing throws the reply away.
    await card.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Cancel and reply…" }).click();
    const dialog = page.getByRole("dialog", { name: "Cancel this work and reply" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Go back", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toBeFocused();

    await card.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Cancel and reply…" }).click();
    // THE LANE'S OWN WARNING: this is a member typing for a client.
    await expect(dialog.getByText("Your client reads this, word for word, on their portal.")).toBeVisible();
    const reply = "We have to stop here — the budget moved to the spring campaign.";
    await dialog.getByLabel("Your reply").fill(reply);
    await dialog.getByRole("button", { name: "Cancel and reply", exact: true }).click();

    // The server agreed, and the toast promises only what it saw.
    await expect(page.getByText(CANCELLED_AND_SEEN)).toBeVisible({ timeout: 30_000 });
    // The card now lives in the Cancelled column — and HOLDS FOCUS there.
    // It is a new node in another column; without the board handing focus
    // to it, focus would sit on <body>, where every key acts.
    const moved = page
      .locator('[data-testid="board-column"][data-state-category="CANCELLED"]')
      .locator('[data-testid="board-card"]', { hasText: title });
    await expect(moved).toBeVisible({ timeout: 30_000 });
    await expect(moved).toBeFocused();

    // …and its menu offers no Delete that could only fail — an answered
    // request's reply is the client's to keep (`deleteItem` refuses it):
    // refused, with the reason, rather than a press answered by an error.
    // No second "Cancel and reply" either: it has ended.
    await moved.getByRole("button", { name: /Actions for/ }).click();
    const del = page.getByRole("menuitem", { name: /^Delete/ });
    await expect(del).toHaveAttribute("aria-disabled", "true");
    await expect(del).toContainText("Your reply is the client’s to keep");
    await expect(page.getByRole("menuitem", { name: "Cancel and reply…" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    const mine = (await readPortalRequests(seed.tenantId)).find((r) => r.title === title);
    expect(mine!.stateCategory).toBe("CANCELLED");
    expect(mine!.triageStatus).toBe("DECLINED");
    // Accepted first — the fact the portal's word turns on (C31).
    expect(mine!.acceptedAt).not.toBeNull();

    // ── THE CLIENT READS "CANCELLED", NOT "DECLINED" (founder decision
    //    C31, 2026-09-25). They watched this request as Planned after
    //    the accept above; "Declined" would tell them the agency never
    //    agreed to it. Same reply under it, at the foot of the card, in
    //    its own group — and NOT in Declined, which is asserted on the
    //    group rather than on the page so a leftover declined request
    //    from another spec cannot make it pass. ────────────────────────
    const portal = await portalRow(browser, title);
    try {
      const cancelled = portalGroup(portal.page, "CANCELLED");
      await expect(cancelled.getByText("Cancelled", { exact: true })).toBeVisible();
      await expect(cancelled.getByText(title)).toBeVisible();
      await expect(cancelled.getByText(reply)).toBeVisible();
      await expect(portalGroup(portal.page, "DECLINED").getByText(title)).toHaveCount(0);
    } finally {
      await portal.close();
    }
  });

  test("a backlog row's menu ends a PRIVATE one, and the toast says the client cannot read the reply", async ({
    page,
    browser,
  }) => {
    const title = await submitRequest(browser, "Please add a newsletter sign-up.");
    await accept(page, title);

    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const row = page.getByTestId("backlog-row").filter({ hasText: title });
    await expect(row).toBeVisible({ timeout: 30_000 });

    // Made private first, through the row's own visibility cell: the
    // client can no longer see the task, so it cannot see the reply.
    const badge = row.locator('[data-slot="visibility-badge"]');
    await expect(badge).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");
    await row.locator('[data-slot="inline-edit"]').filter({ has: page.locator('[data-slot="visibility-badge"]') }).click();
    await row.locator("select").selectOption("INTERNAL");
    await expect(badge).toHaveAttribute("data-visibility", "INTERNAL", { timeout: 30_000 });

    // DISMISSED FIRST, and focus comes back to the ROW: the menu item the
    // dialog opened from no longer exists, and the body's blur handler
    // released the row's pin when focus left for the portalled menu.
    await row.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Cancel and reply…" }).click();
    const dialog = page.getByRole("dialog", { name: "Cancel this work and reply" });
    await dialog.getByLabel("Your reply").fill("A half-written sentence for the client");
    await dialog.getByRole("button", { name: "Go back", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeFocused();

    // …and the half-sentence did not survive into the next opening: this
    // field is published verbatim to a client.
    await row.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Cancel and reply…" }).click();
    await expect(dialog.getByLabel("Your reply")).toHaveValue("");
    await dialog.getByLabel("Your reply").fill("The launch date moved, so we are stopping this one.");
    await dialog.getByRole("button", { name: "Cancel and reply", exact: true }).click();

    // THE OTHER SENTENCE — the server saw a private task, so the toast may
    // not say the client can read the reply. And it says "while": the
    // reply is kept, and sharing the task later publishes it.
    await expect(
      page.getByText(/cancelled\. Your reply is saved, but your client cannot read it while the task is private to the team/),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(CANCELLED_AND_SEEN)).toHaveCount(0);
    await expect(row.getByTestId("backlog-state")).toContainText("Cancelled", { timeout: 30_000 });
    const mine = (await readPortalRequests(seed.tenantId)).find((r) => r.title === title);
    expect(mine!.triageStatus).toBe("DECLINED");
    expect(mine!.visibility).toBe("INTERNAL");
  });

  test("a round trip that fails keeps the reply and the dialog, and the menus say an answer is in flight", async ({
    page,
    browser,
  }) => {
    const title = await submitRequest(browser, "Please add a dark mode.");
    await accept(page, title);

    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const row = page.getByTestId("backlog-row").filter({ hasText: title });
    await expect(row).toBeVisible({ timeout: 30_000 });

    // HOLD THE DECLINE, and only it — the shell's timer pill posts actions
    // of its own. A flag, never an `unroute` while a request is held
    // (unrouting continues it, and a later `abort` then throws).
    let hold = true;
    const held: { route: Route | null } = { route: null };
    let arrived!: () => void;
    const arrival = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (hold && isActionPost(request) && (request.postData() ?? "").includes('"DECLINE"')) {
        hold = false;
        held.route = route;
        arrived();
        return;
      }
      await route.fallback();
    });
    try {
      await row.getByRole("button", { name: /Actions for/ }).click();
      await page.getByRole("menuitem", { name: "Cancel and reply…" }).click();
      const dialog = page.getByRole("dialog", { name: "Cancel this work and reply" });
      const reply = "We will not get to this before the launch, so we are stopping it here.";
      await dialog.getByLabel("Your reply").fill(reply);
      await dialog.getByRole("button", { name: "Cancel and reply", exact: true }).click();
      await within(arrival, 30_000, "the DECLINE to reach the network");

      // IN FLIGHT: the verb is REFUSED on the menus, with the reason — one
      // answer at a time, because the reply is held until it lands — and,
      // like every refused item, it stays reachable and inert.
      await row.getByRole("button", { name: /Actions for/ }).click();
      const inFlight = page.getByRole("menuitem", { name: /^Cancel and reply…/ });
      await expect(inFlight).toHaveAttribute("aria-disabled", "true");
      await expect(inFlight).toContainText("Your last reply is still being sent");
      // `force`: Playwright's actionability check treats `aria-disabled` as
      // not enabled and would wait for ever — this is a real pointer click
      // on the refused item, which is exactly what is being asserted inert.
      await inFlight.click({ force: true });
      await expect(page.getByRole("menu")).toHaveAttribute("data-state", "open");
      await expect(dialog).toHaveCount(0);
      await page.keyboard.press("Escape");

      // THE ROUND TRIP FAILS — a rejected server action, not a refusal the
      // server wrote. It is caught and said, never left to the error
      // boundary, which would have taken the reply with it.
      await held.route!.abort("failed");
      await expect(page.getByText("Something went wrong.")).toBeVisible({ timeout: 30_000 });
      // …and the reply survives it: the dialog is back holding the words,
      // with focus in the field — not on its ✕, one keypress from
      // throwing them away.
      await expect(dialog).toBeVisible();
      const field = dialog.getByLabel("Your reply");
      await expect(field).toHaveValue(reply);
      await expect(field).toBeFocused();

      // Sent again, it lands.
      await dialog.getByRole("button", { name: "Cancel and reply", exact: true }).click();
      await expect(page.getByText(CANCELLED_AND_SEEN)).toBeVisible({ timeout: 30_000 });
      await expect(row.getByTestId("backlog-state")).toContainText("Cancelled", { timeout: 30_000 });
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });

  test("the bulk bar keeps Cancelled for a selection holding a request — refused, reachable, and saying why", async ({
    page,
    browser,
  }) => {
    const title = await submitRequest(browser, "Please translate the site into Finnish.");
    await accept(page, title);
    const mine = (await readPortalRequests(seed.tenantId)).find((r) => r.title === title)!;

    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const row = page.getByTestId("backlog-row").filter({ hasText: title });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId("backlog-select-row").click();
    await page.getByTestId("bulk-state").click();

    // It used to VANISH from this menu with nothing said. Now it is there,
    // refused, with the reason for a member who can end a request — and
    // the way to do it, since this request has a door.
    const refused = page.getByTestId("bulk-state-refused");
    await expect(refused).toBeVisible();
    await expect(refused).toContainText("Cancelled");
    await expect(refused).toContainText(
      "Client requests are never cancelled in bulk. End each one from its own menu, with a reply to the client.",
    );
    await expect(refused).toHaveAttribute("aria-disabled", "true");

    // REACHABLE BY THE ARROWS, which a Radix-`disabled` item is not — the
    // reason exists for the keyboard and a screen reader as well.
    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press("ArrowDown");
      reached = await refused.evaluate((el) => el === document.activeElement);
    }
    expect(reached, "the arrows stop on the refused target").toBe(true);

    // …and a press there does NOTHING. Asserted on the menu's own state —
    // a closing menu stays mounted through its exit animation, so "still
    // visible" would pass for a press that closed it — and on the network:
    // no action naming this request leaves the page.
    let posted = 0;
    page.on("request", (request) => {
      if (isActionPost(request) && (request.postData() ?? "").includes(mine.id)) posted += 1;
    });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toHaveAttribute("data-state", "open");
    // `force`: Playwright treats `aria-disabled` as not enabled and would
    // wait for ever; this is a real pointer click on the refused item.
    await refused.click({ force: true });
    await expect(page.getByRole("menu")).toHaveAttribute("data-state", "open");
    await page.keyboard.press("Escape");
    await expect(refused).toHaveCount(0);
    expect(posted, "no action was sent for the refused target").toBe(0);
    await page.getByTestId("bulk-clear").click();
  });

  test("the item panel's band says Decline… for a request still waiting, and hands focus on when it has gone", async ({
    page,
    browser,
  }) => {
    const title = await submitRequest(browser, "Please move the site to another host.");
    const mine = (await readPortalRequests(seed.tenantId)).find((r) => r.title === title)!;

    // Still in TRIAGE: no work agreed, so the verb is the lane's own word.
    await page.goto(`/projects/${seed.projectKey}/items/${mine.number}`);
    const band = page.getByRole("button", { name: "Decline…" });
    await expect(band).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Cancel and reply…" })).toHaveCount(0);

    await band.click();
    const dialog = page.getByRole("dialog", { name: "Decline this request" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // The band's own button is the dialog's origin, so focus returns to it.
    await expect(band).toBeFocused();

    // HOLD THE ANSWER, to see the band IN FLIGHT: the dialog closes as the
    // call starts and focus comes back to the band's OWN button, which is
    // `aria-disabled` rather than `disabled` — a native `disabled` refuses
    // focus and would drop it on <body> for the whole round trip — and a
    // press opens nothing, because `begin` refuses while an answer is on
    // its way (fix review: neither was pinned).
    let hold = true;
    const held: { route: Route | null } = { route: null };
    let arrived!: () => void;
    const arrival = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (hold && isActionPost(request) && (request.postData() ?? "").includes('"DECLINE"')) {
        hold = false;
        held.route = route;
        arrived();
        return;
      }
      await route.fallback();
    });
    try {
      await band.click();
      await dialog.getByLabel("Your reply").fill("We only host with our own provider, so we cannot move it.");
      await dialog.getByRole("button", { name: "Decline and reply", exact: true }).click();
      await within(arrival, 30_000, "the DECLINE to reach the network");
      await expect(band).toBeFocused();
      await expect(band).toHaveAttribute("aria-disabled", "true");
      await band.click({ force: true });
      await expect(dialog).toHaveCount(0);
      await held.route!.continue();
      await expect(page.getByText(/declined\. Your client can read your reply\./)).toBeVisible({ timeout: 30_000 });
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }

    // The request has ended, so the band is gone — and the focus it held
    // went to the rail's State, which now says so, rather than to <body>.
    await expect(band).toHaveCount(0, { timeout: 30_000 });
    const state = page.locator('[data-slot="item-rail"] button').first();
    await expect(state).toBeFocused();
    await expect(state).toContainText("Cancelled");
  });
});

test.describe("an employee, who may accept a request but not end one", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.afterAll(async () => {
    await clearPortalRequests(seed.tenantId, seed.contactEmail);
  });

  test("sees no Cancel and reply, and the bulk bar tells them it is not theirs to cancel", async ({
    page,
    browser,
  }) => {
    const title = await submitRequest(browser, "Please add a cookie banner.");
    await page.goto("/login");
    await page.locator("#email").fill(seed.employeeEmail);
    await page.locator("#password").fill(seed.employeePassword);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("**/home", { timeout: 30_000 });
    // `work_item:triage` is C M E: an employee MAY take the work on.
    await accept(page, title);

    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const row = page.getByTestId("backlog-row").filter({ hasText: title });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: /Actions for/ }).click();
    // PRESENCE FIRST — the menu has rendered — then the absence, which
    // would otherwise pass against a menu that had not opened yet.
    await expect(page.getByRole("menuitem", { name: "Archive" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Cancel and reply…" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Not pointed at a verb their menus will never show them.
    await row.getByTestId("backlog-select-row").click();
    await page.getByTestId("bulk-state").click();
    await expect(page.getByTestId("bulk-state-refused")).toContainText(
      "A client request is selected, and you do not have permission to cancel client requests.",
    );
    await page.keyboard.press("Escape");
    await page.getByTestId("bulk-clear").click();
  });
});
