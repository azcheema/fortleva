import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  CONTACT_STORAGE_STATE,
  STORAGE_STATE,
  clearPortalRequests,
  readPortalRequests,
  requireSeed,
} from "./fixtures/tenant";

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
 * group into the portal's stop in the 204-shot sweep, and its presence
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

    // ── The client's side: the whole point of the slice ──────────────
    // Before 6b this row simply vanished from their list the moment the
    // agency said no. Now it says Declined and carries the words above.
    const portal = await portalRow(browser, title);
    try {
      await expect(portal.page.getByText("Declined", { exact: true })).toBeVisible();
      await expect(portal.page.getByText(reply)).toBeVisible();
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
    // ACCEPTED IS NEVER STORED — accepting clears every triage column,
    // so the row becomes ordinary work (DATA_MODEL §6.14, amended by
    // this slice).
    expect(mine!.triageStatus).toBeNull();

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
