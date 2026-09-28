import { expect, test, type Browser, type Page, type Request } from "@playwright/test";

import { isActionPost } from "./fixtures/actions";

import { SLOW, createOwnTask, deleteOwnTasks, picker, rail } from "./fixtures/keys";
import { CONTACT_STORAGE_STATE, addClientVisibleComment, readItemVisibility, requireSeed } from "./fixtures/tenant";

/**
 * THE SHARING UI (Phase 3 slice 72; founder decisions C35–C37), in a real
 * browser.
 *
 * WHAT ONLY A BROWSER CAN SAY HERE:
 *  · **The worst-bug direction, end to end.** A member makes a shared task
 *    private — with the shared subtask under it — and the task and the
 *    subtask LEAVE the client's own portal, behind a different cookie, a
 *    different table and a different secret. `visibility.dbtest.ts` proves
 *    the rows and the gate; only this proves a member's click arriving on
 *    the client's screen. No spec did this before: every portal check in
 *    the suite was a share (`contact-tasks.spec.ts`), never an unshare.
 *  · **"Follows ACME-12"**: under a private parent the rail draws the chip
 *    as text with the reason — no control is rendered at all.
 *  · **The selection bar asks with the count and SENDS ONLY WHAT IT
 *    COUNTED** — a "Show to client" over a private and a shared row posts
 *    the private one's id alone, the fix for the first of the slice 72
 *    review's two high findings (a stale list re-sharing a task a colleague
 *    had made private) — withdraws the question when the selection moves
 *    under it, and hands focus back to a ROW when it unmounts, never to
 *    `<body>`, where every single key acts.
 *  · **A "Private to team" is never dropped by leaving the task** — the
 *    review's second high: the member picks it and closes the peek while
 *    the preview is out, and the answer still lands, as a toast.
 *  · **Every board card wears its visibility** (C36).
 *
 * EVERY TASK IS THIS FILE'S OWN and is deleted in `afterEach`, pass or
 * fail — a child first, because `deleteItem` refuses a parent with live
 * children. Never a seeded task: the visual walk photographs this project.
 */

const seed = requireSeed();

let created: string[] = [];

test.afterEach(async ({ page }) => {
  const titles = created;
  created = [];
  await deleteOwnTasks(page, seed, titles);
});

/** Whether the client's own portal lists `title`, under the contact plane's jar. */
async function portalSays(browser: Browser, title: string, present: boolean): Promise<void> {
  const contact = await browser.newContext({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });
  try {
    const page = await contact.newPage();
    await page.goto("/portal");
    // The heading first: it proves the page RENDERED, so an absence below
    // is an absence in the list, not a page that never arrived.
    await expect(page.getByRole("heading", { name: "Shared with you" })).toBeVisible({ timeout: 30_000 * SLOW });
    if (present) await expect(page.getByText(title)).toBeVisible({ timeout: 30_000 * SLOW });
    else await expect(page.getByText(title)).toHaveCount(0);
  } finally {
    await contact.close();
  }
}

/** Add a subtask from the open peek; registered FIRST for cleanup. */
async function addSubtask(page: Page, title: string): Promise<void> {
  const section = page.getByTestId("item-peek").getByTestId("item-subtasks");
  created.unshift(title);
  await section.getByTestId("item-subtask-add").click();
  const input = section.getByTestId("item-subtask-input");
  await expect(input).toBeFocused();
  await input.fill(title);
  await input.press("Enter");
  await expect(section.getByTestId("item-subtask-row").filter({ hasText: title })).toHaveCount(1, {
    timeout: 20_000 * SLOW,
  });
  await input.press("Escape");
}

test("making a shared task private takes it AND the shared subtask under it off the client's portal", async ({
  page,
  browser,
}) => {
  const task = await createOwnTask(page, seed, "Sharing cascade", created);
  const trigger = rail(page).getByTestId("item-visibility");
  const chip = trigger.locator('[data-slot="visibility-badge"]');

  // Share it; a subtask added now is born shared (defaulted from the
  // parent at creation — never inherited live).
  await trigger.click();
  await picker(page).getByTestId("item-visibility-CLIENT_VISIBLE").click();
  await expect(chip).toHaveAttribute("data-visibility", "CLIENT_VISIBLE", { timeout: 20_000 * SLOW });
  const childTitle = `Sharing cascade child ${Date.now()}`;
  await addSubtask(page, childTitle);
  const childRow = page.getByTestId("item-subtask-row").filter({ hasText: childTitle });
  await expect(childRow.locator('[data-slot="visibility-badge"]')).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");
  const childNumber = Number((await childRow.textContent())?.match(new RegExp(`${seed.projectKey}-(\\d+)`))?.[1]);
  expect(childNumber).toBeGreaterThan(0);

  // The client sees both — the list is flat and shows subtasks too.
  await portalSays(browser, task.title, true);
  await portalSays(browser, childTitle, true);

  // Private: the rail ASKS, counting the subtask.
  await trigger.click();
  await picker(page).getByTestId("item-visibility-INTERNAL").click();
  const question = page.getByTestId("item-visibility-question");
  await expect(question).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(question).toContainText("together with 1 task under it");
  await question.getByTestId("item-visibility-question-confirm").click();
  await expect(chip).toHaveAttribute("data-visibility", "INTERNAL", { timeout: 20_000 * SLOW });
  await expect(childRow.locator('[data-slot="visibility-badge"]')).toHaveAttribute("data-visibility", "INTERNAL", {
    timeout: 20_000 * SLOW,
  });

  // STORED private, both — and gone from the client's screen, both.
  await expect
    .poll(() => readItemVisibility(seed.projectId, task.number), { timeout: 20_000 * SLOW })
    .toMatchObject({ visibility: "INTERNAL" });
  await expect
    .poll(() => readItemVisibility(seed.projectId, childNumber), { timeout: 20_000 * SLOW })
    .toMatchObject({ visibility: "INTERNAL" });
  await portalSays(browser, task.title, false);
  await portalSays(browser, childTitle, false);
});

test("under a private parent the chip is text and says whom it follows", async ({ page }) => {
  const parent = await createOwnTask(page, seed, "Follows parent", created);
  const childTitle = `Follows child ${Date.now()}`;
  await addSubtask(page, childTitle);
  await page.getByTestId("item-subtask-row").filter({ hasText: childTitle }).getByRole("link").click();
  const peek = page.getByTestId("item-peek");
  await expect(peek.getByText(childTitle)).toBeVisible({ timeout: 20_000 * SLOW });

  // No control — the chip alone, and the reason on its own line.
  await expect(rail(page).getByTestId("item-visibility")).toHaveCount(0);
  await expect(rail(page).locator('[data-slot="visibility-badge"]').first()).toHaveAttribute(
    "data-visibility",
    "INTERNAL",
  );
  await expect(rail(page).getByTestId("item-visibility-follows")).toHaveText(
    `Follows ${parent.key}. Share ${parent.key} first to share this task.`,
  );
  // No trigger is rendered at all, so there is no picker for `V` (whose
  // binding is disabled here) to open — the M rule: nothing choosable,
  // the island is text.
});

test("the selection bar shows and hides tasks, asking once with the count, and hands focus back to a row", async ({
  page,
}) => {
  const one = await createOwnTask(page, seed, "Bar share one", created);
  const two = await createOwnTask(page, seed, "Bar share two", created);
  await page.goto(`/projects/${seed.projectKey}/backlog`);
  const rowOf = (title: string) => page.locator('[data-testid="backlog-row"]', { hasText: title });
  await expect(rowOf(one.title)).toBeVisible({ timeout: 20_000 * SLOW });
  const tick = async () => {
    await rowOf(one.title).getByRole("checkbox").check();
    await rowOf(two.title).getByRole("checkbox").check();
  };
  const bar = page.getByTestId("bulk-bar");
  const question = bar.getByTestId("bulk-question");
  const toast = (text: string) => page.locator("[data-sonner-toast]", { hasText: text });

  // Show to client: counted, asked in place, focus on the answer.
  await tick();
  await bar.getByTestId("bulk-visibility").click();
  await page.getByTestId("bulk-share").click();
  await expect(question).toContainText("Show 2 tasks to the client?");
  await expect(question.getByTestId("bulk-question-confirm")).toBeFocused();
  await question.getByTestId("bulk-question-confirm").click();
  await expect(toast("2 tasks are now visible to the client.")).toBeVisible({ timeout: 20_000 * SLOW });
  for (const t of [one, two]) {
    await expect(rowOf(t.title).locator('[data-slot="visibility-badge"]')).toHaveAttribute(
      "data-visibility",
      "CLIENT_VISIBLE",
      { timeout: 20_000 * SLOW },
    );
  }
  // The bar unmounted with focus inside it: focus is on a ROW, not <body>.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest("[data-item-id]") !== null), {
      timeout: 20_000 * SLOW,
    })
    .toBe(true);

  // Make private: the preview first, then the question — nothing under
  // these two, so it is the short one.
  await tick();
  await bar.getByTestId("bulk-visibility").click();
  await page.getByTestId("bulk-make-private").click();
  await expect(question).toContainText("Make 2 tasks private?", { timeout: 20_000 * SLOW });
  await question.getByTestId("bulk-question-confirm").click();
  await expect(toast("2 tasks are now private to the team.")).toBeVisible({ timeout: 20_000 * SLOW });
  for (const t of [one, two]) {
    await expect
      .poll(() => readItemVisibility(seed.projectId, t.number), { timeout: 20_000 * SLOW })
      .toMatchObject({ visibility: "INTERNAL" });
  }

  // Everything ticked is private now: "Make private" is refused WITH ITS
  // REASON and stays focusable (C29b).
  await tick();
  await bar.getByTestId("bulk-visibility").click();
  await expect(page.getByTestId("bulk-make-private-refused")).toContainText(
    "No selected task is visible to the client.",
  );
  await page.keyboard.press("Escape");
});

test("the bar's share sends ONLY the rows it counted, is withdrawn when the selection moves, and is refused when all are shared", async ({
  page,
}) => {
  const priv = await createOwnTask(page, seed, "Bar count private", created);
  const shared = await createOwnTask(page, seed, "Bar count shared", created);
  // Share the second one from its own rail, so the list shows one of each.
  await rail(page).getByTestId("item-visibility").click();
  await picker(page).getByTestId("item-visibility-CLIENT_VISIBLE").click();
  await expect(rail(page).getByTestId("item-visibility").locator('[data-slot="visibility-badge"]')).toHaveAttribute(
    "data-visibility",
    "CLIENT_VISIBLE",
    { timeout: 20_000 * SLOW },
  );
  await page.goto(`/projects/${seed.projectKey}/backlog`);
  const rowOf = (title: string) => page.locator('[data-testid="backlog-row"]', { hasText: title });
  await expect(rowOf(priv.title)).toBeVisible({ timeout: 20_000 * SLOW });
  const privId = await rowOf(priv.title).getAttribute("data-item-id");
  const sharedId = await rowOf(shared.title).getAttribute("data-item-id");
  expect(privId).toBeTruthy();
  expect(sharedId).toBeTruthy();
  const bar = page.getByTestId("bulk-bar");
  const question = bar.getByTestId("bulk-question");

  // Every action POST that names either row, recorded for the whole test.
  const posts: string[] = [];
  page.on("request", (request: Request) => {
    if (!isActionPost(request)) return;
    const body = request.postData() ?? "";
    if (body.includes(privId!) || body.includes(sharedId!)) posts.push(body);
  });

  // The selection MOVES under an open question: it is withdrawn, nothing sent.
  await rowOf(priv.title).getByRole("checkbox").check();
  await rowOf(shared.title).getByRole("checkbox").check();
  await bar.getByTestId("bulk-visibility").click();
  await page.getByTestId("bulk-share").click();
  await expect(question).toContainText("Show 1 task to the client?");
  await rowOf(shared.title).getByRole("checkbox").uncheck();
  await expect(question).toHaveCount(0);
  expect(posts).toHaveLength(0);

  // Asked again over both, and answered: the POST carries the COUNTED row
  // alone — the shared one is never sent, so a stale list cannot re-share
  // a task a colleague made private since it rendered.
  await rowOf(shared.title).getByRole("checkbox").check();
  await bar.getByTestId("bulk-visibility").click();
  await page.getByTestId("bulk-share").click();
  await expect(question).toContainText("Show 1 task to the client?");
  await question.getByTestId("bulk-question-confirm").click();
  await expect(page.locator("[data-sonner-toast]", { hasText: "1 task is now visible to the client." })).toBeVisible({
    timeout: 20_000 * SLOW,
  });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain(privId!);
  expect(posts[0]).not.toContain(sharedId!);

  // Both shared now: "Show to client" is refused WITH ITS REASON.
  await rowOf(priv.title).getByRole("checkbox").check();
  await rowOf(shared.title).getByRole("checkbox").check();
  await bar.getByTestId("bulk-visibility").click();
  await expect(page.getByTestId("bulk-share-refused")).toContainText(
    "Every selected task is already visible to the client.",
  );
  await page.keyboard.press("Escape");
});

test("every board card wears its visibility — Private to team as well as Client can see (C36)", async ({ page }) => {
  await page.goto(`/projects/${seed.projectKey}/board`);
  const card = (n: number) => page.locator(`[data-testid="board-card"][data-item-key="${seed.projectKey}-${n}"]`);
  // KEY-1 is the seed's INTERNAL task, KEY-2 its shared one.
  await expect(card(1).locator('[data-slot="visibility-badge"]')).toHaveAttribute("data-visibility", "INTERNAL", {
    timeout: 20_000 * SLOW,
  });
  await expect(card(1).locator('[data-slot="visibility-badge"]')).toHaveText("Private to team");
  await expect(card(2).locator('[data-slot="visibility-badge"]')).toHaveText("Client can see");
});

/**
 * The preview POST — `previewMakePrivateAction([itemId], projectKey)`: an
 * array whose first argument is an ARRAY of ids, which neither the share
 * nor the make-private door sends.
 */
const isPreviewOf = (itemId: string) => (request: Request): boolean =>
  isActionPost(request) && (request.postData() ?? "").startsWith(`[["${itemId}"]`);

test("a Private to team picked just before leaving the task is kept — as the door's result, or as the question with its action", async ({
  page,
}) => {
  const toast = (text: string) => page.locator("[data-sonner-toast]", { hasText: text });
  // One gate per case, released by hand: the preview is HELD until the
  // member has left the task (a gate, never an `unroute`).
  let gate: (() => void) | null = null;
  let heldFor: string | null = null;
  await page.route("**/*", async (route) => {
    if (heldFor && isPreviewOf(heldFor)(route.request())) {
      await new Promise<void>((release) => {
        gate = release;
      });
    }
    await route.continue();
  });
  const leaveWhilePreviewIsOut = async (itemId: string) => {
    heldFor = itemId;
    await rail(page).getByTestId("item-visibility").click();
    await picker(page).getByTestId("item-visibility-INTERNAL").click();
    await expect(page.getByTestId("item-visibility-checking")).toBeVisible({ timeout: 20_000 * SLOW });
    // The picker's popover must be GONE first: while it animates out it is
    // still the top Radix layer, and it would take this Escape itself.
    await expect(picker(page)).toHaveCount(0);
    // Leave the task: the peek closes and the island unmounts.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("item-peek")).toHaveCount(0);
    heldFor = null;
    await expect.poll(() => gate !== null, { timeout: 20_000 * SLOW }).toBe(true);
    (gate as unknown as () => void)();
    gate = null;
  };
  const shareFromRail = async () => {
    await rail(page).getByTestId("item-visibility").click();
    await picker(page).getByTestId("item-visibility-CLIENT_VISIBLE").click();
    await expect(rail(page).getByTestId("item-visibility").locator('[data-slot="visibility-badge"]')).toHaveAttribute(
      "data-visibility",
      "CLIENT_VISIBLE",
      { timeout: 20_000 * SLOW },
    );
  };

  // (a) Nothing below: the door runs, and its result is the toast.
  const alone = await createOwnTask(page, seed, "Away alone", created);
  const aloneId = new URL(page.url()).searchParams.get("item")!;
  await shareFromRail();
  const aloneRowId = await page
    .locator('[data-testid="backlog-row"]', { hasText: alone.title })
    .getAttribute("data-item-id");
  await leaveWhilePreviewIsOut(aloneRowId!);
  await expect(toast(`${alone.key} is now private to the team.`)).toBeVisible({ timeout: 20_000 * SLOW });
  await expect
    .poll(() => readItemVisibility(seed.projectId, alone.number), { timeout: 20_000 * SLOW })
    .toMatchObject({ visibility: "INTERNAL" });
  expect(aloneId).toBe(alone.key);

  // (b) Something below: the QUESTION comes along as a toast, and its
  // action is the answer.
  const tree = await createOwnTask(page, seed, "Away tree", created);
  await shareFromRail();
  await addClientVisibleComment(seed.projectId, tree.number);
  const treeRowId = await page
    .locator('[data-testid="backlog-row"]', { hasText: tree.title })
    .getAttribute("data-item-id");
  await leaveWhilePreviewIsOut(treeRowId!);
  const ask = toast(`The client can still see ${tree.key}. Make it private, together with 1 comment?`);
  await expect(ask).toBeVisible({ timeout: 20_000 * SLOW });
  // Nothing written yet: the member has not answered.
  expect(await readItemVisibility(seed.projectId, tree.number)).toMatchObject({ visibility: "CLIENT_VISIBLE" });
  await ask.getByRole("button", { name: "Make all private" }).click();
  await expect(toast(`${tree.key} is now private to the team, together with 1 comment.`)).toBeVisible({
    timeout: 20_000 * SLOW,
  });
  await expect
    .poll(() => readItemVisibility(seed.projectId, tree.number), { timeout: 20_000 * SLOW })
    .toEqual({ visibility: "INTERNAL", clientVisibleComments: 0 });
});
