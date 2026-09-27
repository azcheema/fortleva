import { expect, test } from "@playwright/test";

import { CONTACT_STORAGE_STATE, requireSeed } from "./fixtures/tenant";

/**
 * THE ONE-SCREEN PROJECT PAGE, through a real contact session (Phase 3,
 * the Client Timeline slice; UI.md §4).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT. `portal-timeline.dbtest.ts`
 * calls the two projections with a principal an assertion built and
 * reads their JSON. This drives the whole vertical — a contact cookie,
 * `requirePortalContext()`, five reads under the contact principal — and
 * reads the RENDER: that the header names the phase the seed put in
 * progress and the milestone it dated next, that the meter counts the
 * three shared milestones and not the INTERNAL fourth, that the rail
 * carries every kind of entry in date order, and that the one name the
 * seed planted as a negative control ("Lansering", INTERNAL, due in
 * three weeks) is on no part of the page.
 *
 * It sorts before `updates.spec.ts` (workers: 1, alphabetical), so the
 * seeded post is the only published update when it runs.
 */

const seed = requireSeed();

test.use({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });

test.describe("portal project page", () => {
  test("header, rail and tasks — and nothing internal", async ({ page }) => {
    await page.goto(`/portal/projects/${seed.projectKey}`);
    await expect(page.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 });

    // ── The header ───────────────────────────────────────────────────
    const header = page.locator('[data-slot="page-header"]');
    await expect(header.locator("h1")).toContainText("E2E Project");
    // The health is the seeded post's, human-chosen: AT_RISK.
    await expect(header.locator('[data-slot="health-chip"]')).toHaveAttribute("data-value", "AT_RISK");
    const facts = header.locator('[data-slot="portal-project-facts"]');
    await expect(facts).toContainText(`Phase: ${seed.datedMilestoneName}`);
    await expect(facts).toContainText(`Next milestone: ${seed.upcomingMilestoneName}`);
    // Sidmallar reached; Designgranskning and Innehållsinläsning open;
    // Lansering INTERNAL and therefore not a milestone this reader has.
    await expect(facts).toContainText("1 of 3 milestones");

    // ── The rail ─────────────────────────────────────────────────────
    const rail = page.locator('[data-slot="portal-timeline"]');
    await expect(rail).toBeVisible();
    const events = rail.locator('[data-slot="portal-event"]');
    // Newest first: the upcoming due (+7 d), the post (today), the
    // reached milestone (today, before the post in the seed), the two
    // versions of the shared deliverable (today, seeded before the
    // milestones — the portal files slice), the second ship (−2 d, the
    // sign-off fixture, with its control), the first ship (−7 d), the
    // in-progress phase's own due (−14 d).
    await expect(events).toHaveCount(8);
    await expect(events.nth(0)).toHaveAttribute("data-kind", "milestone_due");
    await expect(events.nth(0)).toContainText(seed.upcomingMilestoneName);
    await expect(events.nth(1)).toHaveAttribute("data-kind", "update");
    await expect(events.nth(1).locator('[data-slot="health-chip"]')).toHaveAttribute("data-value", "AT_RISK");
    await expect(events.nth(2)).toHaveAttribute("data-kind", "milestone_done");
    await expect(events.nth(2)).toContainText(seed.reachedMilestoneName);
    await expect(events.nth(3)).toHaveAttribute("data-kind", "document_version");
    await expect(events.nth(3)).toHaveAttribute("data-document-kind", "DELIVERABLE");
    await expect(events.nth(3)).toContainText(`Deliverable: ${seed.deliverableDocName}`);
    await expect(events.nth(3)).toContainText("Version 2");
    await expect(events.nth(4)).toHaveAttribute("data-kind", "document_version");
    await expect(events.nth(4)).toContainText("Version 1");
    await expect(events.nth(5)).toHaveAttribute("data-kind", "version_shipped");
    await expect(events.nth(5)).toContainText(`Version ${seed.pendingVersion}`);
    // The ask, on the entry it is about (the sign-off slice): the reader
    // is a primary contact, so the control is offered. Deciding it is
    // `portal-signoff.spec.ts`'s; this only reads the offer.
    await expect(events.nth(5).locator('[data-slot="portal-signoff"]')).toHaveAttribute("data-status", "PENDING");
    await expect(events.nth(5).getByTestId("portal-signoff-approve")).toBeVisible();
    await expect(events.nth(6)).toHaveAttribute("data-kind", "version_shipped");
    await expect(events.nth(6)).toContainText(`Version ${seed.shippedVersion}`);
    await expect(events.nth(6)).toContainText("Sidmallar och navigation på plats");
    // …and no ask on the version nobody asked about: no state, no control.
    await expect(events.nth(6).locator('[data-slot="portal-signoff"]')).toHaveCount(0);
    await expect(events.nth(7)).toHaveAttribute("data-kind", "milestone_due");
    await expect(events.nth(7)).toContainText(seed.datedMilestoneName);

    // ── THE NEGATIVE CONTROLS ────────────────────────────────────────
    // The INTERNAL milestone is on no part of the page. Checked on the
    // whole surface, not the rail alone: the header's facts and the
    // meter are the other places a milestone name could reach.
    // (The seeded post's summary says "Lanseringen flyttas…" — the
    // WORD, in the agency's own prose to the client; the exact name as
    // its own token is what must be absent, so the rail and the header
    // are checked rather than the post's body.)
    await expect(rail).not.toContainText("Lansering");
    await expect(facts).not.toContainText("Lansering");
    // …and the INTERNAL deliverable is on neither the rail nor the files
    // section (the portal files slice's control).
    await expect(page.locator("[data-portal-surface]")).not.toContainText(seed.internalDeliverableDocName);

    // ── The latest update and the shared tasks are on the page too ──
    await expect(page.locator('[data-slot="portal-update"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="portal-group"]').first()).toBeVisible();

    // ── 6. Files & deliverables: the project's shared files, the
    // deliverable first at version 2, each with its download. ────────
    const filesSection = page.locator('[data-slot="portal-project-files"]');
    await expect(filesSection).toBeVisible();
    const rows = filesSection.locator('[data-slot="portal-file"]');
    await expect(rows.first()).toHaveAttribute("data-kind", "DELIVERABLE");
    await expect(rows.first()).toContainText(seed.deliverableDocName);
    await expect(rows.first()).toContainText("Version 2");
    await expect(rows.first().getByRole("button", { name: `Download ${seed.deliverableDocName}` })).toBeVisible();

    // ── 7. Hours & retainer (the hours widget slice): the seed shares
    // hours AND amounts on this project, so a primary contact reads the
    // live widget with money on it, the monthly hours budget as a fact,
    // two months of the employee's time (35 and 70 days back — never
    // the current month, so "this month" is zero whatever ran before),
    // and the one published time report, grouped by task. ────────────
    const hoursSection = page.locator('[data-slot="portal-hours"]');
    await expect(hoursSection).toBeVisible();
    const live = hoursSection.locator('[data-slot="portal-hours-live"]');
    // THE CURRENT MONTH IS NOT THIS SPEC'S TO PIN. Earlier specs start and
    // stop timers on this project (seconds each), and every one of those
    // lands in the current month: in CI "to date" read SEK 6,175.53 for
    // 6 h 30 m — two seconds at 950 SEK. So the tiles are asserted to
    // within what a suite of timers can add (under an hour, under a
    // hundred kronor), and the PAST months and the report — which no
    // spec can touch — carry the exact figures.
    await expect(live.locator('[data-metric="thisMonth"] dd').first()).toHaveText(/^\d+m$/);
    await expect(live.locator('[data-metric="toDate"] dd').first()).toHaveText(/^6h 3\dm$/);
    // 2 h 30 m + 3 h + 1 h, at the tenant's 950 SEK bill rate: 6 175 SEK.
    // `\s`, not a space: the formatter puts a NO-BREAK SPACE between the
    // code and the number, which a string match normalises and a regex
    // does not.
    await expect(live.locator('[data-metric="toDate"]')).toContainText(/SEK\s6,1\d\d\.\d\d billable/);
    await expect(live.locator('[data-metric="budget"] dd').first()).toHaveText("40h");
    // Newest first: the month 35 days back (3 h + 1 h), then 70 days back
    // (2 h 30 m) — found by their amounts, because a timer this month adds
    // a third row above them.
    const months = live.locator('[data-slot="portal-hours-month"]');
    const newer = months.filter({ hasText: "SEK 3,800.00" });
    const older = months.filter({ hasText: "SEK 2,375.00" });
    await expect(newer).toHaveCount(1);
    await expect(older).toHaveCount(1);
    await expect(newer).toContainText("4h");
    await expect(older).toContainText("2h 30m");
    const monthKeys = await months.evaluateAll((rows) => rows.map((r) => r.getAttribute("data-month") ?? ""));
    expect(monthKeys.indexOf((await newer.getAttribute("data-month")) ?? "")).toBeLessThan(
      monthKeys.indexOf((await older.getAttribute("data-month")) ?? ""),
    );
    // The published report: its row, then its lines behind the disclosure
    // — the shared task by name, the INTERNAL task's hour folded into
    // "Other work".
    const report = hoursSection.locator('[data-slot="portal-time-report"]', { hasText: seed.timeReportTitle });
    await expect(report).toHaveCount(1);
    await expect(report).toContainText("6h 30m · SEK 6,175.00");
    await report.locator("summary").click();
    const lines = report.locator('[data-slot="report-line"]');
    await expect(lines).toHaveCount(2);
    await expect(lines.filter({ hasText: "Skriv kravspecifikation" })).toContainText("5h 30m");
    await expect(lines.filter({ hasText: "Other work" })).toContainText("1h");
    await expect(report.locator('[data-slot="report-total"]')).toContainText("SEK 6,175.00");
    // THE NEGATIVE CONTROL: the INTERNAL task an hour was logged on is
    // named nowhere on the surface — not in the report's lines, not
    // anywhere else. (Its title is a phrase the seeded post's prose does
    // not contain; see the seed.)
    await expect(page.locator("[data-portal-surface]")).not.toContainText(seed.hoursInternalTaskTitle);

    // ── The post's entry links to the updates page, at its anchor ────
    await events.nth(1).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/portal/projects/${seed.projectKey}/updates#update-`), {
      timeout: 30_000,
    });
    // …whose back link returns to the project page.
    await page.getByRole("link", { name: /^Back to E2E Project/ }).click();
    await expect(page).toHaveURL(new RegExp(`/portal/projects/${seed.projectKey}$`), { timeout: 30_000 });
  });

  test("the home's project card leads to the page", async ({ page }) => {
    await page.goto("/portal");
    await expect(page.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 });
    // The PROJECT card — the one whose heading is a link. Since the
    // sign-off slice the home leads with a "Waiting on you" card that
    // also names the project (under each open ask), so `.first()` on the
    // name alone would land there.
    const card = page
      .locator('[data-slot="section-card"]', { hasText: "E2E Project" })
      .filter({ has: page.locator("h2 a") })
      .first();
    await card.locator("h2").getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/portal/projects/${seed.projectKey}$`), { timeout: 30_000 });
    await expect(page.locator('[data-slot="page-header"] h1')).toContainText("E2E Project");
  });
});
