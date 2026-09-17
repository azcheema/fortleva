import { readFileSync } from "node:fs";

import { expect, test, type Download, type Locator, type Page, type Request } from "@playwright/test";

import { isActionPost } from "./fixtures/actions";
import { createOwnTask, deleteOwnTasks, keyLink, overlaySection, pressUntil } from "./fixtures/keys";
import { forgetStaffNotice, requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * 2T in a browser (PLAN.md Phase 2T "Demo" + the 2026-08-20 D1/D2/D6
 * deltas): the staff notice gates the first timer; the quick start runs
 * a timer that the header pill shows ticking and stops; starting another
 * timer auto-stops the first and the toast offers UNDO; an instant
 * (project-less) task works; a break stops the running timer and the
 * day reconciles; a typed "1h 30m" entry lands in the week grid; and the
 * employee cannot reach the team view. Everything happens inside the
 * throwaway e2e tenant (fixtures/tenant.ts) and is removed by teardown.
 */

let seed!: E2ESeed;

// Timer start / clock-in are a server action plus a full refresh of
// /time — dozens of queries. Stated for the fast path; on CI (US runner,
// EU database) the same waits get three times the leash.
const SLOW = process.env["CI"] ? 3 : 1;

test.beforeAll(() => {
  seed = requireSeed();
});

// The pill is mounted twice (desktop header slot + mobile slot); the
// desktop one comes first in the DOM and is the visible one at this viewport.
const pill = (page: Page) => page.getByTestId("timer-pill").first();
const idlePill = (page: Page) => page.getByTestId("timer-pill-idle").first();
const stopButton = (page: Page) => page.getByTestId("timer-pill-stop").first();
const elapsedClock = (page: Page) => page.getByTestId("timer-pill-elapsed").first();

// Downloads are same-origin attachments from a route handler: click the
// anchor, wait for the download event, read the file Playwright saved.
const BOM = String.fromCharCode(0xfeff);
async function download(page: Page, testId: string): Promise<{ name: string; text: string; header: string }> {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 * SLOW }), page.getByTestId(testId).first().click()]);
  const d: Download = dl;
  const path = await d.path();
  const raw = readFileSync(path, "utf8");
  const text = raw.startsWith(BOM) ? raw.slice(1) : raw;
  return { name: d.suggestedFilename(), text, header: text.split("\r\n")[0] ?? "" };
}
const ENTRY_HEADER =
  "id,date,started_at,stopped_at,timezone,seconds,hours,member_id,member,client,project_key,project,task_key,task,agreement,work_type,billable,description,entry_mode,source,needs_review,locked_reason";

async function acknowledgeNoticeIfShown(page: Page): Promise<void> {
  const ack = page.getByTestId("notice-acknowledge");
  if (await ack.isVisible().catch(() => false)) {
    await ack.click();
    await expect(ack).toHaveCount(0, { timeout: 15_000 * SLOW });
  }
}

/**
 * A finished entry through the New-entry form (a duration on a date; the
 * date defaults to today). The form resets itself only after the action
 * succeeded — waiting for the empty note is the reliable "it landed"
 * signal, since a success toast may still be up from a previous add.
 */
async function addEntry(page: Page, entry: { note: string; duration: string; date?: string }): Promise<void> {
  if (entry.date) await page.locator("#ne-date").fill(entry.date);
  await page.getByTestId("new-entry-duration").fill(entry.duration);
  await page.getByTestId("new-entry-description").fill(entry.note);
  await page.getByTestId("new-entry-submit").click();
  await expect(page.getByTestId("new-entry-description")).toHaveValue("", { timeout: 15_000 * SLOW });
}

/** The viewed week's first day as the APP sees it (Europe/Stockholm, the tenant's week start) — from the week-CSV link, never the runner's clock. */
async function viewedWeekFrom(page: Page): Promise<string> {
  const href = await page.getByTestId("time-export-csv").getAttribute("href");
  const from = new URL(href ?? "", "http://x").searchParams.get("from");
  expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  return from!;
}

/** The stop confirm every explicit stop opens (UI.md rule 9 — no silent save). */
const stopConfirm = (page: Page) => page.getByTestId("stop-confirm");

/** Dismiss the stop confirm — by Escape, or by its close button — keeping the entry exactly as stopped. */
async function keepAsStopped(page: Page, via: "escape" | "close" = "escape"): Promise<void> {
  await expect(stopConfirm(page)).toBeVisible({ timeout: 15_000 * SLOW });
  if (via === "escape") await page.keyboard.press("Escape");
  else await stopConfirm(page).locator('[data-slot="dialog-close"]').click();
  await expect(stopConfirm(page)).toHaveCount(0);
}

async function stopIfRunning(page: Page): Promise<void> {
  const stop = stopButton(page);
  if (await stop.isVisible().catch(() => false)) {
    await stop.click();
    await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });
    await keepAsStopped(page);
  }
}

/**
 * A task's timer control is visible AND idle. The control ignores a press
 * while its start or stop is in flight (the pill's state not yet re-read),
 * so a key pressed the instant the new label paints could be swallowed.
 */
async function timerControlReady(control: Locator): Promise<void> {
  await expect(control).toBeVisible({ timeout: 15_000 * SLOW });
  await expect(control).not.toHaveAttribute("aria-disabled", "true", { timeout: 15_000 * SLOW });
  // The key registry learns `enabled` in the effect AFTER that render.
  await nextFrames(control.page());
}

/** A promise that fails the test after `ms` instead of hanging it to the test timeout (which skips `finally`). */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)),
  ]);
}

/** Two animation frames: whatever a key's own commit mounts is in the DOM by then. */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/**
 * Nothing on the page is busy. A card's or a row's `T` ignores a press
 * while its own start or stop is in flight, and the board region and the
 * backlog say so with `aria-busy` — the one outward sign of it.
 */
async function listIdle(page: Page): Promise<void> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 * SLOW });
}

/**
 * Wait until a freshly LOADED task page's `T` is registered, without
 * pressing anything that acts: the `?` overlay is a projection of the
 * live key registry, so once it lists the task's timer row the control
 * has hydrated. A click or `T` retried until something changes is unsafe
 * on a toggle — a retry that lands after the first press took effect
 * presses the button's OTHER verb (measured: a second "Start" click
 * landed on the button that had just become "Stop").
 */
async function waitForTaskTimerKey(page: Page, label: string): Promise<void> {
  const overlay = page.getByRole("dialog", { name: /shortcut/i });
  await pressUntil(page, "?", overlay);
  await expect(overlay.getByText(label, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
}

test.describe("my time (owner)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/time");
    await expect(page.getByRole("heading", { name: "My time" })).toBeVisible();
    await acknowledgeNoticeIfShown(page);
    await stopIfRunning(page);
  });

  test("an instant task: quick start → the pill ticks → stop → the stop confirm adjusts the note and the duration → the row is in the week as adjusted", async ({ page }) => {
    await page.getByTestId("quick-start-description").fill("E2E instant task");
    await page.getByTestId("quick-start-start").click();
    await expect(pill(page)).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(pill(page)).toContainText("E2E instant task");

    // The elapsed clock moves (1 Hz from the server start instant).
    const elapsed = elapsedClock(page);
    const before = await elapsed.textContent();
    await expect.poll(async () => elapsed.textContent(), { timeout: 5_000 * SLOW }).not.toBe(before);
    // The tab title mirrors it.
    await expect.poll(async () => page.title(), { timeout: 5_000 * SLOW }).toMatch(/^\d+:\d\d:\d\d · /);

    await stopButton(page).click();
    await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });

    // One tap stopped it; the confirm then shows what was saved and takes
    // the three adjustments. An instant task has no billable choice.
    const confirm = stopConfirm(page);
    await expect(confirm).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(confirm).toContainText("E2E instant task");
    await expect(confirm.getByTestId("stop-confirm-note")).toHaveValue("E2E instant task");
    await expect(confirm.getByTestId("stop-confirm-billable")).toHaveCount(0);
    await expect(confirm).toContainText("Instant tasks are not billable");
    // Focus is on Done, never in the note: the next keystrokes — a second
    // `t`, the next task's name — must not land in the entry.
    await expect(confirm.getByTestId("stop-confirm-done")).toBeFocused();
    await page.keyboard.type("tt");
    await nextFrames(page);
    await expect(confirm.getByTestId("stop-confirm-note")).toHaveValue("E2E instant task");
    // …nor the global `T`, which with no timer running would navigate to the quick start.
    await expect(page).toHaveURL(/\/time$/);
    const adjusted = `E2E instant task, adjusted ${Date.now()}`;
    await confirm.getByTestId("stop-confirm-note").fill(adjusted);
    // 2m, deliberately: past the service's one-minute slack for a future end,
    // so a confirm that kept the START (not the stop instant) would be
    // REFUSED here and the dialog would stay open — the one e2e signal that
    // the end is kept. Short, because the start moves back by it: a run in
    // the first two minutes after Monday 00:00 would re-date the row into
    // last week (a recorded two-minute window).
    await confirm.getByTestId("stop-confirm-duration").fill("2m");
    await confirm.getByTestId("stop-confirm-done").click();
    await expect(confirm).toHaveCount(0, { timeout: 15_000 * SLOW });
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(idlePill(page)).toBeVisible();

    const row = page.getByTestId("time-entry-row").filter({ hasText: adjusted });
    await expect(row.first()).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(row.first()).toContainText("Not billable");
    await expect(row.first()).toContainText("2m");
  });

  test("a project timer; starting another auto-stops it and the toast offers Undo; the stop confirm's Escape keeps the entry as stopped, and its billable flips a project entry", async ({ page }) => {
    await page.getByTestId("quick-start-project").selectOption(seed.projectId);
    await page.getByTestId("quick-start-description").fill("E2E project work");
    await page.getByTestId("quick-start-start").click();
    await expect(pill(page)).toContainText(seed.projectKey, { timeout: 15_000 * SLOW });

    await page.getByTestId("quick-start-description").fill("E2E second timer");
    await page.getByTestId("quick-start-start").click();
    const toast = page.getByText(/was stopped/);
    await expect(toast).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(pill(page)).toContainText("E2E second timer");

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(pill(page)).toContainText(seed.projectKey, { timeout: 15_000 * SLOW });
    await expect(pill(page)).not.toContainText("E2E second timer");

    // Escape keeps the entry as stopped: a typed note is NOT sent. Stopped by
    // the pill's GLOBAL `T` this time (no task is open on /time).
    const escaped = `E2E typed then escaped ${Date.now()}`;
    const updates: string[] = [];
    page.on("request", (r) => {
      if (isActionPost(r) && (r.postData() ?? "").includes(escaped)) updates.push(r.url());
    });
    await page.keyboard.press("t");
    await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });
    const confirm = stopConfirm(page);
    await expect(confirm).toBeVisible({ timeout: 15_000 * SLOW });
    await confirm.getByTestId("stop-confirm-note").fill(escaped);
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await nextFrames(page);
    expect(updates).toHaveLength(0);
    // And the server agrees, after a fresh render.
    await page.reload();
    await expect(page.getByRole("heading", { name: "My time" })).toBeVisible();
    await expect(page.getByTestId("time-entry-row").filter({ hasText: "E2E project work" }).first()).toBeVisible();
    await expect(page.getByTestId("time-entry-row").filter({ hasText: escaped })).toHaveCount(0);

    // Twice, from the quick start's own Stop this time: a project entry's
    // billable is a real choice, and the flip reaches the week row.
    const flip = `E2E billable flip ${Date.now()}`;
    await page.getByTestId("quick-start-project").selectOption(seed.projectId);
    await page.getByTestId("quick-start-description").fill(flip);
    await page.getByTestId("quick-start-start").click();
    await expect(pill(page)).toContainText(flip, { timeout: 15_000 * SLOW });
    await page.getByTestId("quick-start-stop").click();
    await expect(confirm).toBeVisible({ timeout: 15_000 * SLOW });
    const billable = confirm.getByTestId("stop-confirm-billable");
    const wasBillable = await billable.isChecked();
    await billable.setChecked(!wasBillable);
    // While the save is out the dialog does not close — Escape would
    // otherwise say "kept as stopped" while the save lands anyway.
    let holding = true;
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/*", async (route) => {
      if (holding && isActionPost(route.request()) && (route.request().postData() ?? "").includes('"billable"')) {
        holding = false;
        await released;
      }
      await route.fallback();
    });
    try {
      const saved = page.waitForResponse((r) => isActionPost(r.request()) && (r.request().postData() ?? "").includes('"billable"'), { timeout: 30_000 * SLOW });
      await confirm.getByTestId("stop-confirm-done").click();
      await expect(confirm.getByTestId("stop-confirm-done")).toHaveAttribute("aria-disabled", "true");
      await page.keyboard.press("Escape");
      await nextFrames(page);
      // Still OPEN, not merely still visible: a dialog that did close stays
      // on screen through its exit animation, so visibility proves nothing.
      // A close also resets `saving`, which Done's attribute would show.
      await expect(confirm).toHaveAttribute("data-state", "open");
      await expect(confirm.getByTestId("stop-confirm-done")).toHaveAttribute("aria-disabled", "true");
      release();
      await saved;
    } finally {
      release();
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
    await expect(confirm).toHaveCount(0, { timeout: 15_000 * SLOW });
    const flipped = page.getByTestId("time-entry-row").filter({ hasText: flip }).first();
    await expect(flipped).toContainText(wasBillable ? "Not billable" : "Billable", { timeout: 15_000 * SLOW });
  });

  test("`T` on a task: start it from the peek and Undo while it is still settling; `T` and Undo again while typing in the peek; on the task's page `T` stops and starts it, and a stop in the pill reaches the button", async ({ page }) => {
    const created: string[] = [];
    try {
      await page.getByTestId("quick-start-description").fill("E2E before the task");
      await page.getByTestId("quick-start-start").click();
      await expect(pill(page)).toContainText("E2E before the task", { timeout: 15_000 * SLOW });

      const task = await createOwnTask(page, seed, "E2E timer task", created);
      const peek = page.getByTestId("item-peek");
      const start = peek.getByTestId("item-timer-start");
      const stop = peek.getByTestId("item-timer-stop");

      // The peek opened by a client navigation on a hydrated page, so its
      // control is live on arrival: ONE click, never a retried one.
      //
      // The start's own re-read of the timer is HELD, so the Undo below is
      // clicked while the start is still settling — the window in which an
      // undo was once silently dropped (review). The re-read is the first
      // argument-less action POST AFTER the start's own POST (which names
      // the task): several actions take no arguments, so the start comes first.
      await timerControlReady(start);
      const control = peek.getByTestId("item-timer").getByRole("button");
      let sawStart = false;
      let holdRead = true;
      let readHeld!: () => void;
      const heldNow = new Promise<void>((r) => {
        readHeld = r;
      });
      let releaseRead!: () => void;
      const readReleased = new Promise<void>((r) => {
        releaseRead = r;
      });
      await page.route("**/*", async (route) => {
        // A flag, never `unroute` while a request is held.
        const body = route.request().postData() ?? "";
        if (isActionPost(route.request()) && body.includes("workItemId")) sawStart = true;
        else if (sawStart && holdRead && isActionPost(route.request()) && body === "[]") {
          holdRead = false;
          readHeld();
          await readReleased;
        }
        await route.fallback();
      });
      await start.click();
      await within(heldNow, 30_000 * SLOW, "the start's re-read of the timer");
      await expect(page.getByText(/"E2E before the task" was stopped/)).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(control).toHaveAttribute("aria-disabled", "true");
      await page.getByRole("button", { name: "Undo" }).click();
      releaseRead();
      // The undo's OWN answer, not the pill's text: at this instant the pill
      // may not have caught up with the start yet, so "it shows the earlier
      // timer" alone would pass for an undo that never ran (measured, by
      // re-introducing the drop).
      await expect(page.getByText("Undone — the previous timer is running again.")).toBeVisible({ timeout: 15_000 * SLOW });
      await timerControlReady(start);
      await expect(pill(page)).toContainText("E2E before the task", { timeout: 15_000 * SLOW });
      await expect(pill(page)).not.toContainText(task.title);
      await expect(peek).toBeVisible();
      await page.unrouteAll({ behavior: "ignoreErrors" });

      // Now by key — the proof that `T` belongs to the task while one is
      // open: the global `T` would have STOPPED "E2E before the task".
      await page.keyboard.press("t");
      await expect(stop).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(pill(page)).toContainText(task.title, { timeout: 15_000 * SLOW });
      await expect(peek.getByTestId("item-timer-elapsed")).toBeVisible();
      await timerControlReady(stop);

      // Undo again, now with the member typing in the peek. The toast floats
      // over it; its Undo must be clickable there, must not close the peek
      // (a modal layer's "outside"), and must not take focus: the peek's
      // trap would hand it back to the field WITH its text selected, and
      // the next key would replace what was typed.
      const subtaskInput = peek.getByTestId("item-subtask-input");
      await peek.getByTestId("item-subtask-add").click();
      await subtaskInput.fill("Kept as typed");
      await page.getByRole("button", { name: "Undo" }).click();
      await timerControlReady(start);
      await expect(pill(page)).toContainText("E2E before the task", { timeout: 15_000 * SLOW });
      await expect(pill(page)).not.toContainText(task.title);
      await expect(peek).toBeVisible();
      await expect(subtaskInput).toBeFocused();
      await expect(subtaskInput).toHaveValue("Kept as typed");
      expect(await subtaskInput.evaluate((el: HTMLInputElement) => el.selectionStart === el.selectionEnd)).toBe(true);
      await subtaskInput.press("Escape");
      await timerControlReady(start);

      // A stop INSIDE the peek. The confirm is the shell's, a second modal
      // layer outside the peek's React tree: typing and Done must work in
      // it, the peek must stay open beneath, and focus must come back into
      // the peek where the key was pressed (the subtask row's button).
      await page.keyboard.press("t");
      await timerControlReady(stop);
      await page.keyboard.press("t");
      const confirm = stopConfirm(page);
      await expect(confirm).toBeVisible({ timeout: 15_000 * SLOW });
      await confirm.getByTestId("stop-confirm-note").fill("E2E stopped in the peek");
      await confirm.getByTestId("stop-confirm-done").click();
      await expect(confirm).toHaveCount(0, { timeout: 15_000 * SLOW });
      await expect(page.getByText("Saved.")).toBeVisible();
      await expect(peek).toBeVisible();
      await expect(peek.getByTestId("item-subtask-add")).toBeFocused();
      await timerControlReady(start);

      // And the task's timer once more, for the page below.
      await page.keyboard.press("t");
      await expect(stop).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(pill(page)).toContainText(task.title, { timeout: 15_000 * SLOW });

      // The task's own page: the server's first paint already knows the
      // running timer is this task's.
      await page.goto(`/projects/${seed.projectKey}/items/${task.number}`);
      const pageStart = page.getByTestId("item-timer-start");
      const pageStop = page.getByTestId("item-timer-stop");
      await expect(pageStop).toBeVisible();
      await waitForTaskTimerKey(page, "Stop this task's timer");
      await page.keyboard.press("t");
      await expect(pageStart).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });
      await keepAsStopped(page);

      // Twice: the second start is the one a stale "running here" gets wrong.
      await timerControlReady(pageStart);
      await page.keyboard.press("t");
      await expect(pageStop).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(pill(page)).toContainText(task.title, { timeout: 15_000 * SLOW });

      // A stop somewhere else — the pill — turns the task's button back.
      await stopButton(page).click();
      await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(pageStart).toBeVisible({ timeout: 15_000 * SLOW });
      await keepAsStopped(page, "close");
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      // Off the peek first: its modal layer makes the header pill unclickable.
      await page.goto("/time");
      await stopIfRunning(page);
      await deleteOwnTasks(page, seed, created);
    }
  });

  test("`T` on a focused backlog row and board card starts THAT task — never the global `T`'s stop — wears the badge there, and a second `T` stops it with focus coming back; from the card's \"…\" button too, swallowing a second `T` while the start is in flight; with no card focused `T` is the global one; under the card's delete question it does nothing; and the overlay lists both", async ({ page }) => {
    const created: string[] = [];
    try {
      // A timer running ELSEWHERE first. The global `T` would STOP it, so a
      // row that failed to claim the key would leave the pill idle — or
      // stopped and restarted — instead of on the row's task.
      await page.getByTestId("quick-start-description").fill("E2E before the row");
      await page.getByTestId("quick-start-start").click();
      await expect(pill(page)).toContainText("E2E before the row", { timeout: 15_000 * SLOW });
      const task = await createOwnTask(page, seed, "E2E row timer", created);

      // ── the backlog row ──
      await page.goto(`/projects/${seed.projectKey}/backlog`);
      const row = page.locator('[data-testid="backlog-row"]', { hasText: task.title });
      await expect(row).toBeVisible({ timeout: 20_000 * SLOW });
      await waitForTaskTimerKey(page, "Start or stop a timer on the focused task");
      const link = keyLink(row, seed.projectKey);
      await link.focus();
      await page.keyboard.press("t");
      await expect(pill(page)).toContainText(task.title, { timeout: 15_000 * SLOW });
      // The start stopped the other timer in the same transaction, so the toast offers Undo.
      await expect(page.getByText(/"E2E before the row" was stopped/)).toBeVisible();
      await expect(row.getByTestId("backlog-row-timer")).toBeVisible();
      await expect(page.getByTestId("backlog-row-timer")).toHaveCount(1);
      await expect(link).toBeFocused();

      // Under the row's inline delete question `T` does NOTHING — with the
      // row's timer running, the global `T` would STOP it behind the question.
      // Its stop request would go out at once (nothing is queued ahead of it),
      // so no action request at all is the signal.
      await listIdle(page);
      const rowActions = row.getByRole("button", { name: /Actions for/ });
      await rowActions.click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      const rowYes = row.getByRole("button", { name: "Yes" });
      await expect(rowYes).toBeFocused();
      const underQuestion: string[] = [];
      const countActions = (r: Request) => {
        if (isActionPost(r)) underQuestion.push(r.url());
      };
      page.on("request", countActions);
      await page.keyboard.press("t");
      await nextFrames(page);
      await nextFrames(page);
      page.off("request", countActions);
      expect(underQuestion).toHaveLength(0);
      await expect(rowYes).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(rowYes).toHaveCount(0);
      await expect(stopConfirm(page)).toHaveCount(0);
      await expect(pill(page)).toContainText(task.title);
      await expect(row.getByTestId("backlog-row-timer")).toBeVisible();
      await expect(page).toHaveURL(/\/backlog$/);

      await link.focus();
      await listIdle(page);
      await page.keyboard.press("t");
      await keepAsStopped(page);
      await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(row.getByTestId("backlog-row-timer")).toHaveCount(0);
      // The confirm hands focus back to where `T` was pressed.
      await expect(link).toBeFocused();

      // ── the board card ──
      await page.goto(`/projects/${seed.projectKey}/board`);
      const card = page.locator('[data-testid="board-card"]', { hasText: task.title });
      await expect(card).toBeVisible({ timeout: 20_000 * SLOW });
      // Both `T` rows: the card's, and the global one beneath it, which still
      // acts wherever no card holds focus — a focus-handled row hides nothing.
      const overlay = page.getByRole("dialog", { name: /shortcut/i });
      await pressUntil(page, "?", overlay);
      await expect(overlaySection(page, "Board").locator("li", { hasText: "Start or stop a timer on the focused card" })).toBeVisible();
      await expect(overlaySection(page, "Global").locator("li", { hasText: "Start or stop the timer" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(overlay).toHaveCount(0);

      // No timer runs now, so a global `T` would NAVIGATE to /time: staying on
      // the board is the card's claim.
      await card.focus();
      await page.keyboard.press("t");
      await expect(pill(page)).toContainText(task.title, { timeout: 15_000 * SLOW });
      const badge = card.getByTestId("board-card-timer");
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAccessibleName("Your timer is running on this task");
      const shown = await badge.textContent();
      await expect.poll(() => badge.textContent(), { timeout: 5_000 * SLOW }).not.toBe(shown);
      await expect(page.getByTestId("board-card-timer")).toHaveCount(1);
      await expect(page).toHaveURL(/\/board$/);
      await expect(card).toBeFocused();

      await listIdle(page);
      await page.keyboard.press("t");
      // This stop goes through the confirm's Done with a duration typed
      // in, so the card has a FINISHED entry worth showing: Σ spent is
      // read on the page's next render (the confirm's own refresh, slice
      // 20), as the team's figure — the seed member holds time:view_team
      // — and alone, since this task carries no estimate. The row's stop
      // above left the seconds its timer ran on the task, a few locally and
      // more on a slow runner, so the figure is 45m plus whatever they
      // round to (review): the assertion tolerates that, not a wrong number.
      const confirm = stopConfirm(page);
      await expect(confirm).toBeVisible({ timeout: 15_000 * SLOW });
      await confirm.getByTestId("stop-confirm-duration").fill("45m");
      await confirm.getByTestId("stop-confirm-done").click();
      await expect(confirm).toHaveCount(0, { timeout: 15_000 * SLOW });
      await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(badge).toHaveCount(0);
      await expect(card).toBeFocused();
      const spent = card.getByTestId("board-card-spent");
      await expect(spent).toBeVisible({ timeout: 20_000 * SLOW });
      await expect(spent).toContainText(/^4[5-9]m$/);
      await expect(spent).toHaveAccessibleName(/^Spent 4[5-9]m$/);

      // (The stop halves above cannot tell the card's `T` from the global one
      // — both stop — so the claim is proved by the start halves and by this.)
      //
      // Once more on the card, from its "…" BUTTON this time — focus inside
      // the card, not on it — and with the start's request HELD, so a second
      // `T` lands while the first is in flight. The card must swallow it. A
      // `T` passed on to the global binding would send a STOP, and Next runs
      // server actions one at a time: that stop waits behind the held start
      // and then stops the card's own new timer, so the badge below never
      // appears (mutation-checked). Inside the held window the request count,
      // the absent confirm and the URL cannot fail — Next keeps a queued action
      // in the browser — so they are checked again once the flight has settled.
      await page.goto("/time");
      await page.getByTestId("quick-start-description").fill("E2E again elsewhere");
      await page.getByTestId("quick-start-start").click();
      await expect(pill(page)).toContainText("E2E again elsewhere", { timeout: 15_000 * SLOW });
      await page.goto(`/projects/${seed.projectKey}/board`);
      await expect(card).toBeVisible({ timeout: 20_000 * SLOW });
      await waitForTaskTimerKey(page, "Start or stop a timer on the focused card");
      const starts: string[] = [];
      let holding = true;
      let held!: () => void;
      const heldNow = new Promise<void>((r) => {
        held = r;
      });
      let release!: () => void;
      const released = new Promise<void>((r) => {
        release = r;
      });
      await page.route("**/*", async (route) => {
        const body = route.request().postData() ?? "";
        if (isActionPost(route.request()) && body.includes("workItemId")) {
          starts.push(body);
          if (holding) {
            holding = false;
            held();
            await released;
          }
        }
        await route.fallback();
      });
      try {
        await card.getByRole("button", { name: /Actions for/ }).focus();
        await page.keyboard.press("t");
        await within(heldNow, 30_000 * SLOW, "the card's start request");
        await expect(page.locator('[data-slot="board"][aria-busy="true"]')).toBeVisible();
        await page.keyboard.press("t");
        await nextFrames(page);
        expect(starts).toHaveLength(1);
        await expect(stopConfirm(page)).toHaveCount(0);
        await expect(page).toHaveURL(/\/board$/);
        release();
        await expect(badge).toBeVisible({ timeout: 15_000 * SLOW });
        await expect(pill(page)).toContainText(task.title, { timeout: 15_000 * SLOW });
        await expect(page.getByText(/"E2E again elsewhere" was stopped/)).toBeVisible();
        await listIdle(page);
        await expect(stopConfirm(page)).toHaveCount(0);
        await expect(badge).toBeVisible();
        expect(starts).toHaveLength(1);
      } finally {
        release();
        await page.unrouteAll({ behavior: "ignoreErrors" });
      }

      // Then `T` from the board REGION, where no card holds focus: that is the
      // global `T`, which stops the card's timer.
      await listIdle(page);
      await page.getByTestId("board").focus();
      await page.keyboard.press("t");
      await keepAsStopped(page);
      await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(badge).toHaveCount(0);
      await expect(page).toHaveURL(/\/board$/);

      // Under the card's inline delete question `T` does NOTHING. The question
      // renders inside the card, so the card's handler sees its Yes: a start
      // there would put a timer on the task being deleted, and the global `T`
      // (no timer running) would leave the board behind the question.
      const laterStarts: string[] = [];
      page.on("request", (r) => {
        if (isActionPost(r) && (r.postData() ?? "").includes("workItemId")) laterStarts.push(r.url());
      });
      await listIdle(page);
      const actions = card.getByRole("button", { name: /Actions for/ });
      await actions.click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      const yes = card.getByRole("button", { name: "Yes" });
      await expect(yes).toBeFocused();
      await page.keyboard.press("t");
      await nextFrames(page);
      await page.keyboard.press("Escape");
      await expect(yes).toHaveCount(0);
      await expect(actions).toBeFocused();
      // Still on the board, with no stop confirm: the global `T` (no timer
      // running) would have navigated to /time behind the question.
      await expect(page).toHaveURL(/\/board$/);
      await expect(stopConfirm(page)).toHaveCount(0);
      // Settled, so a start made under the question would show by now.
      await listIdle(page);
      await expect(badge).toHaveCount(0);
      await expect(idlePill(page)).toBeVisible();
      expect(laterStarts).toHaveLength(0);
      // …and the same key from the "…" button, the question gone, starts it.
      await page.keyboard.press("t");
      await expect(badge).toBeVisible({ timeout: 15_000 * SLOW });
      await listIdle(page);
      expect(laterStarts).toHaveLength(1);
    } finally {
      await page.goto("/time");
      await stopIfRunning(page);
      await deleteOwnTasks(page, seed, created);
    }
  });

  test("shift: clock in, a break stops the running timer, clock out", async ({ page }) => {
    await page.getByTestId("quick-start-description").fill("E2E before break");
    await page.getByTestId("quick-start-start").click();
    await expect(pill(page)).toBeVisible({ timeout: 15_000 * SLOW });

    await page.getByTestId("shift-clock-in").click();
    await expect(page.getByText("Clocked in", { exact: true })).toBeVisible({ timeout: 15_000 * SLOW });
    await page.getByTestId("shift-start-break").click();
    await expect(page.getByText(/the running timer was stopped/)).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });
    // A stop that is a side effect (the break) is not an explicit stop: no confirm.
    await nextFrames(page);
    await expect(stopConfirm(page)).toHaveCount(0);
    await expect(page.getByText("On break", { exact: true })).toBeVisible();

    await page.getByTestId("shift-end-break").click();
    await expect(page.getByText("Clocked in", { exact: true })).toBeVisible({ timeout: 15_000 * SLOW });
    await page.getByTestId("shift-clock-out").click();
    await expect(page.getByText("Clocked out", { exact: true })).toBeVisible({ timeout: 15_000 * SLOW });
  });

  test("a typed duration entry lands in the week grid", async ({ page }) => {
    await page.getByTestId("new-entry-duration").fill("1h 30m");
    await page.getByTestId("new-entry-description").fill("E2E manual entry");
    await page.getByTestId("new-entry-submit").click();
    const row = page.getByTestId("time-entry-row").filter({ hasText: "E2E manual entry" });
    await expect(row.first()).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(row.first()).toContainText("1h 30m");
  });

  test("copy last week copies rows, not hours — and 'copy with durations' only what is not there yet", async ({ page }) => {
    // Last week's first day, as the APP sees it (never the runner's clock: Sunday 22:00 UTC is already Monday in Stockholm).
    const weekFrom = await viewedWeekFrom(page);
    const lastMonday = new Date(`${weekFrom}T00:00:00Z`);
    lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
    const sourceDate = lastMonday.toISOString().slice(0, 10);

    // A row last week (the New-entry form takes a date): 30 min on an instant task.
    await addEntry(page, { note: "E2E copy source", duration: "30m", date: sourceDate });
    // The week card now offers to copy (last week has a row; this week's grid is asserted below, after the copy).
    await expect(page.getByTestId("copy-last-week-rows")).toBeVisible({ timeout: 15_000 * SLOW });

    // Primary: rows, not hours — the copy lands on this week's Monday with an EMPTY duration.
    await page.getByTestId("copy-last-week-rows").click();
    await expect(page.getByText(/copied from last week/).first()).toBeVisible({ timeout: 15_000 * SLOW });
    const copied = page.getByTestId("time-entry-row").filter({ hasText: "E2E copy source" });
    await expect(copied).toHaveCount(1, { timeout: 15_000 * SLOW });
    await expect(copied.first()).toContainText("0m");
    await expect(copied.first()).not.toContainText("30m");

    // Secondary, behind the caret: with durations — copies only what is not there yet, never re-fills the empty row.
    await addEntry(page, { note: "E2E copy source 2", duration: "45m", date: sourceDate });
    await page.getByTestId("copy-last-week-more").click();
    await page.getByTestId("copy-last-week-durations").click();
    const second = page.getByTestId("time-entry-row").filter({ hasText: "E2E copy source 2" });
    await expect(second).toHaveCount(1, { timeout: 15_000 * SLOW });
    await expect(second.first()).toContainText("45m");
    await expect(page.getByTestId("time-entry-row").filter({ hasText: "E2E copy source" }).filter({ hasNotText: "source 2" })).toHaveCount(1);
    await expect(copied.filter({ hasNotText: "source 2" }).first()).toContainText("0m");
  });

  test("split: a finished entry becomes two rows with the same target — the first keeps its row, the second is new", async ({ page }, testInfo) => {
    // A note unique per attempt: a CI retry must not meet the rows a first attempt already split.
    const note = `E2E split me ${testInfo.retry}-${Date.now().toString(36)}`;
    await addEntry(page, { note, duration: "1h" });
    const rows = page.getByTestId("time-entry-row").filter({ hasText: note });
    await expect(rows).toHaveCount(1, { timeout: 15_000 * SLOW });
    // The row's menu → Split… → the in-place form under the table, default half (30m); type 20m.
    await rows.first().getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Split…" }).click();
    const form = page.getByTestId("split-form");
    await expect(form).toBeVisible();
    await expect(page.getByTestId("split-first")).toHaveValue("30m");
    await page.getByTestId("split-first").fill("20m");
    await page.getByTestId("split-submit").click();
    await expect(page.getByText("Entry split in two.").first()).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(rows).toHaveCount(2, { timeout: 15_000 * SLOW });
    const texts = await rows.allTextContents();
    expect(texts.some((x) => /20m/.test(x))).toBe(true);
    expect(texts.some((x) => /40m/.test(x))).toBe(true);
    await expect(form).toHaveCount(0);
  });

  test("/home shows this week's and today's own hours, and the running timer ticking into them", async ({ page }) => {
    // Self-sufficient: a finished entry today (25 m), then a running timer started from the strip's own affordance.
    await addEntry(page, { note: "E2E home strip", duration: "25m" });
    await page.goto("/home");
    await expect(page.getByTestId("home-time-strip")).toBeVisible({ timeout: 15_000 * SLOW });
    // Both tiles carry a real duration that INCLUDES the entry: today ≥ 25 m (whole minutes: "25m" … "59m", or hours), and the week too.
    const atLeast25m = /^(?:(?:2[5-9]|[3-5]\d)m|\d+h(?: \d+m)?)$/;
    await expect(page.getByTestId("home-time-today")).toHaveText(atLeast25m);
    await expect(page.getByTestId("home-time-week")).toHaveText(atLeast25m);
    const todayBefore = await page.getByTestId("home-time-today").textContent();

    // The idle slot's verb really leads to the quick start; start there, come back.
    await page.getByTestId("home-time-start").click();
    await expect(page).toHaveURL(/\/time#quick-start$/);
    await page.getByTestId("quick-start-description").fill("E2E home running");
    await page.getByTestId("quick-start-start").click();
    await expect(pill(page)).toContainText("E2E home running", { timeout: 15_000 * SLOW });
    await page.goto("/home");
    const running = page.getByTestId("home-time-running");
    await expect(running).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(page.getByText(/Timer running on E2E home running/)).toBeVisible();
    // The Running tile ticks, and the running minutes flow INTO today (started today ⇒ counted today, as the stopped row will be).
    const before = await running.textContent();
    await expect(running).not.toHaveText(before ?? "", { timeout: 5_000 * SLOW });
    await expect
      .poll(async () => page.getByTestId("home-time-today").textContent(), { timeout: 90_000 * SLOW })
      .not.toBe(todayBefore);
    await stopIfRunning(page);
  });

  test("exports: the week's CSV (machine header, rates for the owner, never cost); the statement page and its CSV", async ({ page }) => {
    // Self-sufficient: an entry of its own, so the test holds under a -g filter too.
    await page.getByTestId("new-entry-duration").fill("45m");
    await page.getByTestId("new-entry-description").fill("E2E export entry");
    await page.getByTestId("new-entry-submit").click();
    await expect(page.getByTestId("time-entry-row").filter({ hasText: "E2E export entry" }).first()).toBeVisible({ timeout: 15_000 * SLOW });

    const week = await download(page, "time-export-csv");
    expect(week.name).toMatch(/^time-entries-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
    // The owner holds rate:view_bill: the rate columns exist; cost never does.
    expect(week.header).toBe(`${ENTRY_HEADER},rate,currency,amount`);
    expect(week.text).not.toMatch(/cost/);
    expect(week.text).toContain("E2E export entry");

    // The statement card names the month and opens the print view; the CSV is the same data.
    await expect(page.getByTestId("statement-month")).toBeVisible();
    await page.getByTestId("statement-print-link").click();
    await expect(page.getByRole("heading", { name: "Working-time statement", level: 1 })).toBeVisible();
    // Every calendar day of the month is a row (28–31; the exact month is the app's Europe/Stockholm one, not the runner's clock).
    const dayRows = await page.getByTestId("statement-day").count();
    expect(dayRows).toBeGreaterThanOrEqual(28);
    expect(dayRows).toBeLessThanOrEqual(31);
    await expect(page.getByTestId("statement-total")).toBeVisible();
    await expect(page.getByTestId("statement-print")).toBeVisible();
    const statement = await download(page, "statement-csv");
    expect(statement.name).toMatch(/^working-time-.+-\d{4}-\d{2}\.csv$/);
    expect(statement.header).toBe(
      "date,shift_start,shift_end,shift_start_utc,shift_end_utc,timezone,span_seconds,break_seconds,worked_seconds,worked_hours,provisional,no_break_over_5h,note,tracked_seconds,tracked_hours,unallocated_seconds",
    );
    expect(statement.text.trimEnd().split("\r\n").pop()).toMatch(/^TOTAL,/);

    // The route itself, probed from inside the page (a same-origin fetch carries the Secure session cookie and
    // Sec-Fetch-Site: same-origin — Playwright's Node-side request context would drop the cookie over http):
    // an attachment, never cached (ARC-25); 400 on a bad range / month with nothing echoed back.
    const probe = (url: string) =>
      page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: "same-origin", redirect: "manual" });
        return {
          status: r.status,
          contentType: r.headers.get("content-type"),
          disposition: r.headers.get("content-disposition"),
          cache: r.headers.get("cache-control"),
          body: await r.text(),
        };
      }, url);
    const ok = await probe(`/time/export?kind=statement&month=${new Date().toISOString().slice(0, 7)}`);
    expect(ok.status).toBe(200);
    expect(ok.contentType).toContain("text/csv");
    expect(ok.disposition).toMatch(/^attachment; filename="working-time-/);
    expect(ok.cache).toContain("no-store");
    for (const bad of ["/time/export?kind=entries&from=2026-13-01&to=2026-08-31", "/time/export?kind=entries&from=0001-01-01&to=9999-12-31", "/time/export?kind=statement&month=0099-12"]) {
      const res = await probe(bad);
      expect(res.status, bad).toBe(400);
      expect(res.body).not.toContain("9999");
    }
  });

  test("team, project and money exports: the week's team CSV and a member's statement CSV; the project's entries CSV; the money rollup CSV without cost", async ({ page }) => {
    // Self-sufficient: the team shifts table lists members with a CLOSED shift this week — make sure the owner has one.
    const clockIn = page.getByTestId("shift-clock-in");
    if (await clockIn.isVisible().catch(() => false)) {
      await clockIn.click();
      await expect(page.getByText("Clocked in", { exact: true })).toBeVisible({ timeout: 15_000 * SLOW });
    }
    await page.getByTestId("shift-clock-out").click();
    await expect(page.getByText("Clocked out", { exact: true })).toBeVisible({ timeout: 15_000 * SLOW });

    await page.goto("/time/team");
    await expect(page.getByRole("heading", { name: "Team time", level: 1 })).toBeVisible();
    const team = await download(page, "team-export-csv");
    expect(team.name).toMatch(/^time-entries-team-/);
    expect(team.header).toBe(`${ENTRY_HEADER},rate,currency,amount`);
    // The shift test above clocked the owner out today: the shifts table has a row, and its one verb is the statement CSV.
    const memberStatement = await download(page, "team-statement-csv");
    expect(memberStatement.name).toMatch(/^working-time-/);
    expect(memberStatement.header).toBe(
      "date,shift_start,shift_end,shift_start_utc,shift_end_utc,timezone,span_seconds,break_seconds,worked_seconds,worked_hours,provisional,no_break_over_5h,note,tracked_seconds,tracked_hours,unallocated_seconds",
    );

    await page.goto(`/projects/${seed.projectKey}/time`);
    const project = await download(page, "project-time-export-csv");
    expect(project.name).toMatch(new RegExp(`^time-entries-${seed.projectKey}-`));
    expect(project.header).toBe(`${ENTRY_HEADER},rate,currency,amount`);
    expect(project.text).toContain("E2E project work");

    await page.getByTestId("time-money-link").click();
    await expect(page.getByTestId("money-tiles")).toBeVisible({ timeout: 15_000 * SLOW });
    // The cost layer is off on the fixture: the rollup CSV carries amounts and no cost columns.
    const rollup = await download(page, "money-export-csv");
    expect(rollup.name).toMatch(new RegExp(`^time-rollup-${seed.projectKey}-.*\\.csv$`));
    expect(rollup.name).not.toContain("with-cost");
    expect(rollup.header).toBe("dimension,key,label,seconds,hours,billable_seconds,billable_hours,amount,currency");
    expect(rollup.text).not.toMatch(/cost|margin/);
    expect(rollup.text).toMatch(/\r\ntotal,total,/);
  });
});

test.describe("as the employee", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill(seed.employeeEmail);
    await page.locator("#password").fill(seed.employeePassword);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("**/home", { timeout: 30_000 });
  });

  test("may track own time and export it — without rate columns — but cannot see the team view", async ({ page }) => {
    await page.goto("/time");
    await expect(page.getByRole("heading", { name: "My time" })).toBeVisible();
    // Self-access (SECURITY.md §9.7.3): own rows and own statement need only time:track; no rate:view_bill ⇒ no rate columns.
    const week = await download(page, "time-export-csv");
    expect(week.header).toBe(ENTRY_HEADER);
    const statement = await download(page, "statement-csv");
    expect(statement.header).toMatch(/^date,shift_start,.*,tracked_seconds,tracked_hours,unallocated_seconds$/);
    await page.goto("/time/team");
    await expect(page.getByText("You do not have permission to see the team's time.")).toBeVisible();
    await expect(page.getByTestId("team-export-csv")).toHaveCount(0);
  });

  test("a first start from a task shows the staff notice THERE: Cancel starts nothing — even while the acknowledgment is in flight — acknowledging starts the timer, and the next start asks nothing", async ({ page }) => {
    // Every start request the page sends: the one body that names a task.
    const starts: string[] = [];
    page.on("request", (r) => {
      if (isActionPost(r) && (r.postData() ?? "").includes("workItemId")) starts.push(r.url());
    });
    const start = page.getByTestId("item-timer-start");
    const stop = page.getByTestId("item-timer-stop");
    const notice = page.getByTestId("item-timer-notice");
    const openTask = async () => {
      // The notice shows only on a member's FIRST start; forget any
      // acknowledgment so this holds on a retry too. Seeded task #1 of the
      // project the employee's client assignment puts in scope.
      await forgetStaffNotice(seed.tenantId, seed.employeeEmail);
      await page.goto(`/projects/${seed.projectKey}/items/1`);
      await expect(start).toBeVisible();
      await expect(idlePill(page)).toBeVisible();
      await waitForTaskTimerKey(page, "Start a timer on this task");
    };

    try {
      await openTask();
      await start.click();
      await expect(notice).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(notice).toContainText("What is never recorded");
      // The dialog owns the keyboard: `p` must not open the Priority picker
      // behind it. The picker would mount in the key's own commit, so two
      // frames later it would be there.
      await page.keyboard.press("p");
      await nextFrames(page);
      await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);

      // Cancel starts nothing, and focus goes back to the button.
      await notice.getByRole("button", { name: "Cancel" }).click();
      await expect(notice).toHaveCount(0);
      await expect(start).toBeFocused();
      await nextFrames(page);
      expect(starts).toHaveLength(0);
      await expect(idlePill(page)).toBeVisible();

      await start.click();
      await expect(notice).toBeVisible({ timeout: 15_000 * SLOW });
      await notice.getByTestId("item-timer-notice-acknowledge").click();
      await expect(notice).toHaveCount(0, { timeout: 15_000 * SLOW });
      await expect(stop).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(pill(page)).toContainText(`${seed.projectKey}-1`, { timeout: 15_000 * SLOW });
      expect(starts).toHaveLength(1);

      await timerControlReady(stop);
      await page.keyboard.press("t");
      await expect(start).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });
      // The key's stop opens the confirm too; Escape hands focus back to the
      // control it was pressed on.
      await keepAsStopped(page);
      await expect(start).toBeFocused();

      // Acknowledged: the next start is a start.
      await timerControlReady(start);
      await page.keyboard.press("t");
      await expect(stop).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(notice).toHaveCount(0);
      await stopButton(page).click();
      await keepAsStopped(page);
      await timerControlReady(start);

      // A change of mind DURING the acknowledgment: hold its request, Cancel,
      // then let it land. The notice is acknowledged; no timer starts.
      await openTask();
      await start.click();
      await expect(notice).toBeVisible({ timeout: 15_000 * SLOW });
      const startsBefore = starts.length;
      let holding = true;
      let release!: () => void;
      const released = new Promise<void>((r) => {
        release = r;
      });
      await page.route("**/*", async (route) => {
        // A flag, never `unroute` while a request is held (a later
        // `continue()` then throws "Route is already handled").
        if (holding && isActionPost(route.request())) {
          holding = false;
          await released;
        }
        await route.fallback();
      });
      const acknowledged = page.waitForResponse((r) => isActionPost(r.request()), { timeout: 30_000 * SLOW });
      await notice.getByTestId("item-timer-notice-acknowledge").click();
      await notice.getByRole("button", { name: "Cancel" }).click();
      await expect(notice).toHaveCount(0);
      release();
      await acknowledged;
      // The control decides "start or not" in the same continuation that
      // clears its busy state, and a start keeps it busy until that start
      // has been sent AND answered — so once it is idle, a start that was
      // going to happen has already been counted. The control by ROLE, not by
      // test id: a start that did go out would flip "start" to "stop" while
      // still busy, and waiting on the start id would then time out instead
      // of failing here, at the count (round-3 review).
      await timerControlReady(page.getByTestId("item-timer").getByRole("button"));
      expect(starts).toHaveLength(startsBefore);
      await expect(start).toBeVisible();
      await expect(idlePill(page)).toBeVisible();
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.goto("/time");
      await stopIfRunning(page);
    }
  });

  test("a first start from a focused board CARD shows the notice over the board: Cancel hands focus back to the card, acknowledging starts that card's task", async ({ page }) => {
    const starts: string[] = [];
    page.on("request", (r) => {
      if (isActionPost(r) && (r.postData() ?? "").includes("workItemId")) starts.push(r.url());
    });
    const notice = page.getByTestId("item-timer-notice");
    try {
      // Seeded task #1 of the project in the employee's scope; forget any
      // acknowledgment so the notice shows on a retry too.
      await forgetStaffNotice(seed.tenantId, seed.employeeEmail);
      await page.goto(`/projects/${seed.projectKey}/board`);
      const card = page.locator(`[data-testid="board-card"][data-item-key="${seed.projectKey}-1"]`);
      await expect(card).toBeVisible({ timeout: 20_000 * SLOW });
      await expect(idlePill(page)).toBeVisible();
      await waitForTaskTimerKey(page, "Start or stop a timer on the focused card");

      await card.focus();
      await page.keyboard.press("t");
      await expect(notice).toBeVisible({ timeout: 15_000 * SLOW });
      await expect(notice).toContainText("What is never recorded");
      // It covers the board, so it names the task the start will go to.
      await expect(notice).toContainText(`The timer starts on ${seed.projectKey}-1:`);
      await notice.getByRole("button", { name: "Cancel" }).click();
      await expect(notice).toHaveCount(0);
      await expect(card).toBeFocused();
      await nextFrames(page);
      expect(starts).toHaveLength(0);
      await expect(idlePill(page)).toBeVisible();

      await listIdle(page);
      await page.keyboard.press("t");
      await expect(notice).toBeVisible({ timeout: 15_000 * SLOW });
      await notice.getByTestId("item-timer-notice-acknowledge").click();
      await expect(notice).toHaveCount(0, { timeout: 15_000 * SLOW });
      await expect(pill(page)).toContainText(`${seed.projectKey}-1`, { timeout: 15_000 * SLOW });
      await expect(card.getByTestId("board-card-timer")).toBeVisible();
      expect(starts).toHaveLength(1);
    } finally {
      await page.goto("/time");
      await stopIfRunning(page);
    }
  });
});
