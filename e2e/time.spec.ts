import { readFileSync } from "node:fs";

import { expect, test, type Download, type Page } from "@playwright/test";

import { requireSeed, type E2ESeed } from "./fixtures/tenant";

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

async function stopIfRunning(page: Page): Promise<void> {
  const stop = stopButton(page);
  if (await stop.isVisible().catch(() => false)) {
    await stop.click();
    await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });
  }
}

test.describe("my time (owner)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/time");
    await expect(page.getByRole("heading", { name: "My time" })).toBeVisible();
    await acknowledgeNoticeIfShown(page);
    await stopIfRunning(page);
  });

  test("an instant task: quick start → the pill ticks → stop → the row is in the week", async ({ page }) => {
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
    const row = page.getByTestId("time-entry-row").filter({ hasText: "E2E instant task" });
    await expect(row.first()).toBeVisible();
    await expect(row.first()).toContainText("Not billable");
  });

  test("a project timer; starting another auto-stops it and the toast offers Undo", async ({ page }) => {
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

    await stopButton(page).click();
    await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });
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
});
