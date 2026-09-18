import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  auditPage,
  offscreenRowActions,
  tableOverflow,
  type PageAudit,
  type TableOverflow,
} from "./audit";
import { isActionPost } from "./fixtures/actions";
import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * The visual sweep: every route the app has, in both themes, at desktop
 * and phone width, photographed and audited.
 *
 * It exists because the defects a design pass leaves behind are not the
 * ones a unit test fails on. A control that is invisible in one theme,
 * a table that pushes the page sideways at 390px, a heading outline
 * with two h1s, a key that reached the screen instead of its
 * translation — all of those render, hydrate and return 200.
 *
 * Two outputs, both meant to be read:
 *   • .design-shots/<route>__<theme>__<device>.png — full-page shots,
 *     gitignored, deterministic names, overwritten every run.
 *   • .design-shots/report-<theme>-<device>.json — every audit, so a
 *     defect can be traced to a selector rather than squinted at.
 *
 * Assertions are `expect.soft` on purpose: one bad route must not hide
 * the other twenty-six, and the run still fails when anything trips.
 */

// One clean set per RUN — cleared in global-setup, not here: Playwright
// recycles the worker after a failing test, so module scope runs again
// and would delete the shots the previous walk just took.
const SHOTS = join(process.cwd(), ".design-shots");
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

/**
 * Widths at which `offscreenRowActions` is asked again, on every stop of one
 * walk. Since the actions column is PINNED (UI.md §10.12) this walk proves
 * the pin holds at every rung — a table may now overflow there and still
 * pass, so it no longer bounds how FAR a table overflows; a column-priority
 * mistake that adds scroll is caught by review and by the screenshots, not
 * here (an overflow budget per table is owed, PLAN §0). What it guards is
 * still worth nine resizes: a pin that breaks at some width, a sticky cell
 * that loses its layer, a table whose header and cells come apart.
 *
 * Column priority reads the TABLE's box, not the viewport (UI.md §10.12),
 * and from `md` up the open rail takes 224px of it, so 1440 and 390 say
 * nothing about the band between: the backlog overflowed its box
 * everywhere from 768px to ~1370px, its row actions out of view below
 * ~1350px, while both shots were clean.
 *
 * The worst box a rung's columns ever get is the rung itself (38/46/61.5/71rem
 * = 608/736/984/1136px), so each rung is asked at the viewport that puts a
 * box exactly ON it with the rail open — twice, because a box sits 272px
 * under the viewport for a flush table on the canvas (rail 224 + two 24px
 * gutters; the backlog) and 274px for a bordered or carded one. 768 is the
 * narrowest box the rail ever leaves (494/496px), where only `high` columns
 * render but the identifying cells' `sm:` caps are already wide. A phone
 * needs no widths of its own: a box of 608–735px holds the same columns
 * under the same `sm:` caps at 640–767px as at 880–1009px, and the mobile
 * walk asks 390. What this CANNOT see: the harness is English and its
 * headless Chromium hides scrollbars, while the rungs are calibrated for
 * Swedish content and a classic 17px scrollbar (UI.md §10.12). The Swedish
 * widths were measured by hand with a throwaway probe; the scrollbar is
 * arithmetic (the headless box less 17px).
 */
const RUNG_WIDTHS = [768, 880, 882, 1008, 1010, 1256, 1258, 1408, 1410] as const;

/**
 * KNOWN OVERFLOW, keyed `<stop>@<width>`: the horizontal scroll that
 * table stop HAS at that viewport width today. Column priority exists so
 * a table fits its box, so every key not listed is held to 0 — including
 * every OTHER width of a stop that appears here, which is the point of
 * keying on the width: `projects` is 412px over at 390px and 0 at 1440px,
 * and a per-stop number would have licensed 412px everywhere.
 *
 * A RATCHET, not an allowance. One pixel more than the number here and
 * the walk fails; fixing a stop means deleting its keys in the same
 * commit. `offscreenRowActions` above proves a row's verbs stay
 * reachable, but since slice 18 pinned that column it stayed true however
 * far a table scrolled — nothing bounded the scroll itself, which is
 * slice 18's owed (a) and how the numbers below survived unseen. They are
 * worst on a PHONE, which this walk has photographed all along.
 *
 * WHAT THEY ARE, measured 2026-09-18 — both causes are the ones PLAN §0
 * slice-17 owed (f) already named, and neither is a column-priority
 * mistake:
 *   • `projects` — `<Table className="table-fixed min-w-3xl">`
 *     (`projects/page.tsx`) is a hard 48rem = 768px FLOOR. Every number
 *     below is exactly 768 − box (356+412, 494+274, 606+162, 608+160,
 *     734+34, 736+32), so it is a constant, identical at every locale and
 *     every run; under `table-fixed` content cannot widen the table at
 *     all. Removing `min-w-3xl` removes all of it.
 *   • `clients` — the name cell's `max-w-[420px]` (`clients/page.tsx`)
 *     behaves as a FLOOR in Chromium, so the content is 503px wide below
 *     the `low` rung and 799px at it. `clients-archived` is 14px more at
 *     every width: the same table with the wider "Archived" badge. The
 *     control that proves the reading is `/clients/[id]/projects`, which
 *     carries the same capped cell, is held to 0, and passes — its seeded
 *     names never reach the cap.
 *   • `files`, `client-files`, `error-banner` — 3px at phone width. Small,
 *     but more than the 1px rounding tolerance, and named rather than
 *     hidden under a wider tolerance that would blind every other stop.
 * Each number is set by a CAP or a FLOOR, never by seeded text, so none of
 * them moves with the run id in the fixture's names.
 *
 * NOT A DEFECT LIST BY DEFINITION. `table.tsx` and UI.md §10.12 record a
 * settled trade — since the actions column is pinned, a rung may carry a
 * little scroll at its very edge in exchange for more columns — so a
 * future entry may be that trade rather than a bug. All six today are
 * bugs. The harness is ENGLISH and cannot see the trade: the backlog is
 * 0 here and ~30px over at the `lowest` rung's narrow edge in Swedish
 * (measured with a throwaway probe on 2026-09-18; `table.tsx` and UI.md
 * §10.12 record ~21px for the same edge). The owed Swedish walk will add
 * trades here, and they must be labelled as such.
 */
const KNOWN_OVERFLOW: Record<string, number> = {
  "projects@390": 412,
  "projects@768": 274,
  "projects@880": 162,
  "projects@882": 160,
  "projects@1008": 34,
  "projects@1010": 32,
  "clients@390": 147,
  "clients@768": 9,
  "clients@1010": 63,
  "clients-archived@390": 161,
  "clients-archived@768": 23,
  "clients-archived@1010": 77,
  "files@390": 3,
  "client-files@390": 3,
  "error-banner@390": 3,
};

type Device = keyof typeof VIEWPORTS;
type Theme = "light" | "dark";

type Stop = {
  /** File-name stem; stable, so shots diff across runs. */
  name: string;
  path: string;
  /** Rendered signed out (the auth lockup). */
  anon?: true;
  /** Accepted document statuses; defaults to [200]. */
  status?: number[];
  /** Expected landing path when the route deliberately redirects. */
  url?: string;
  /** This stop is *about* a failure, so its noise is the point. */
  expectsFailure?: true;
  /** Drive the page into the state worth photographing. */
  drive?: (page: Page) => Promise<void>;
};

/** A route that does not exist, for the root 404. */
const MISSING = "/this-route-does-not-exist";

/**
 * Workspace-level routes: their h1 is the page noun ("Files"), never
 * "{tenant} — Files". An entity route's h1 IS the entity's name and may
 * legitimately contain anything.
 */
const WORKSPACE_H1 = ["files", "members", "settings-roles"];

const stops = (seed: E2ESeed): Stop[] => {
  const client = `/clients/${seed.clientId}`;
  const project = `/projects/${seed.projectKey}`;
  return [
    // ── the unauthenticated lockup ──────────────────────────────────
    { name: "login", path: "/login", anon: true },
    { name: "signup", path: "/signup", anon: true },
    { name: "invite", path: `/invite/${seed.inviteToken}`, anon: true },
    { name: "invite-unavailable", path: "/invite/expired-or-unknown-token", anon: true },
    // Signed out, an unknown path never reaches a 404: the proxy gates
    // every non-public route to /login (src/proxy.ts). That redirect is
    // the state an anonymous visitor actually gets.
    { name: "404-anon", path: MISSING, anon: true, url: "/login" },

    // ── the member plane ────────────────────────────────────────────
    { name: "home", path: "/home" },
    {
      // Global chrome (UI.md §3.2) that held none of the design shots
      // until now — and the stop that would have caught the palette
      // shipping broken, since every walk asserts `trace.pageErrors`.
      // `drive` is how a stop reaches state that only exists after an
      // interaction, exactly as `project-backlog-selection` does.
      name: "palette",
      path: "/home",
      drive: async (page) => {
        await page.keyboard.press("ControlOrMeta+k");
        await expect(page.getByRole("dialog")).toBeVisible({ timeout: 20_000 });
      },
    },
    // 2W notifications: the standing fixture holds exactly one real
    // notification (the employee assigned a task to the owner), so this
    // stop photographs a row that resolved its subject AND the rail
    // badge that every other stop now carries too.
    { name: "inbox", path: "/inbox" },
    // 2W search: with a query, so the stop photographs RESULTS rather
    // than the idle state — grouped headings, the row rail and the
    // state icon are what the craft audit needs to see.
    { name: "search", path: "/search?q=Designgranskning" },
    { name: "dashboard", path: "/dashboard" },
    { name: "clients", path: "/clients" },
    { name: "clients-archived", path: "/clients?archived=1" },
    { name: "client-overview", path: client },
    { name: "client-projects", path: `${client}/projects` },
    { name: "client-contacts", path: `${client}/contacts` },
    { name: "client-files", path: `${client}/files` },
    // 2T: agreements with their rate and this month's hours, plus the
    // agreement-scoped rate cards.
    { name: "client-agreements", path: `${client}/agreements` },
    { name: "projects", path: "/projects" },
    { name: "project-overview", path: project },
    { name: "project-board", path: `${project}/board` },
    { name: "project-backlog", path: `${project}/backlog` },
    // 2W-F: the same list with the view turned on — two ACTIVE chips,
    // the Clear control they reveal, and the group header rows. The
    // resting stop above photographs the bar at rest, so between them
    // both states of the new chrome are audited (and a chip row that
    // wrapped or overflowed at 390 px would fail here, not in review).
    { name: "project-backlog-grouped", path: `${project}/backlog?group=assignee&hideDone=true` },
    {
      // 2W-F slice 4: the selection bar, which only exists once a row is
      // ticked — so the audit reaches it through `drive`. This is the one
      // stop that photographs a STICKY element. The DESKTOP walk is what
      // audits the bar; on a phone the select column is dropped, so the
      // bar is unreachable there and the stop degrades to a second look
      // at the list rather than failing.
      name: "project-backlog-selection",
      path: `${project}/backlog`,
      drive: async (page) => {
        // The select column is phone-dropped (`priority="medium"`), so at
        // 390px there is nothing to tick and this stop simply re-audits
        // the list. `.first()` keeps the visibility probe on ONE element —
        // never `isVisible()` on a multi-match locator, where a strict
        // violation is swallowed as "not visible".
        const box = page.locator('[data-testid="backlog-select-row"]').first();
        if (!(await box.isVisible())) return;
        await box.click();
        await expect(page.getByTestId("bulk-bar")).toBeVisible({ timeout: 20_000 });
      },
    },
    // 2W-B: the item side-peek over the backlog (empty attachments +
    // the anchored upload form on the seeded first task).
    { name: "project-item-peek", path: `${project}/backlog?item=${seed.projectKey}-1` },
    // The same panel as a page (2W-P): the shot that shows the two
    // surfaces cannot drift apart.
    { name: "project-item-page", path: `${project}/items/1` },
    { name: "project-timeline", path: `${project}/timeline` },
    // 2T: the Time tab (rollups, budget) and the Money tab (value; cost
    // stays behind the tenant's cost layer, which the fixture leaves off).
    { name: "project-time", path: `${project}/time` },
    { name: "project-money", path: `${project}/money` },
    { name: "project-files", path: `${project}/files` },
    { name: "project-team", path: `${project}/team` },
    { name: "files", path: "/files" },
    // 2T: My time (week grid, shift strip) and the team view.
    { name: "time", path: "/time" },
    { name: "time-team", path: "/time/team" },
    // 2T D1: the member's own monthly working-time statement — the page IS the print layout.
    { name: "time-statement", path: "/time/statement" },
    { name: "members", path: "/members" },
    { name: "settings-roles", path: "/settings/roles" },
    { name: "settings-preferences", path: "/settings/preferences" },
    // 2T: bill cards + the ✦ cost section in its "confirm two-factor"
    // state (the fixture owner has no factor); notice status + work types.
    { name: "settings-rates", path: "/settings/rates" },
    { name: "settings-time", path: "/settings/time" },
    // 2W/2T: the member's own notification settings — the one Settings
    // page with no permission gate.
    { name: "settings-notifications", path: "/settings/notifications" },
    { name: "settings-export", path: "/settings/export" },
    // Dev-only preview: it 404s under `next start` by design (nav.ts
    // devOnly + notFound() in the page), so both statuses are legal.
    { name: "settings-design", path: "/settings/design", status: [200, 404] },
    { name: "account", path: "/account" },
    // A member with no enrolled factor cannot step up — the page sends
    // them to enrol instead, and that redirect is the state to inspect.
    { name: "account-step-up", path: "/account/step-up" },

    // ── the states nobody designs twice ─────────────────────────────
    // An unmatched path resolves to the ROOT not-found (the auth lockup),
    // because it never enters the (authed) segment.
    { name: "404-root", path: MISSING, status: [404] },
    // notFound() inside the member plane answers 200, not 404: the
    // segment has a loading.tsx, so the shell is streamed — and the
    // status committed — before the page body ever runs. Worth knowing,
    // not worth removing a loading boundary over.
    { name: "404-app", path: "/clients/no-such-client-id", status: [200, 404] },
    {
      // The in-page failure banner: what a withError() redirect makes.
      name: "error-banner",
      path: `/files?error=${encodeURIComponent("The file could not be downloaded. Try again.")}`,
    },
    {
      // The error boundary, reached the only way it can be without
      // touching app code: a Server Action that answers 500.
      name: "error-boundary",
      path: "/files",
      expectsFailure: true,
      drive: async (page) => {
        await page.route("**/files", async (route) => {
          const request = route.request();
          if (isActionPost(request)) {
            return route.fulfill({ status: 500, contentType: "text/plain", body: "" });
          }
          return route.fallback();
        });
        await page.getByRole("button", { name: "Download" }).first().click();
        await expect(page.locator('[data-slot="empty-state"]')).toBeVisible({ timeout: 20_000 });
        await page.unrouteAll({ behavior: "ignoreErrors" });
      },
    },
  ];
};

// ── the watcher ──────────────────────────────────────────────────────

type Trace = {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  httpErrors: string[];
};

/** Requests the browser cancels on its own are noise, not defects. */
const IGNORED_FAILURES = ["net::ERR_ABORTED"];

function watch(page: Page): Trace {
  const trace: Trace = { consoleErrors: [], pageErrors: [], failedRequests: [], httpErrors: [] };
  page.on("console", (m) => {
    if (m.type() === "error") trace.consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => trace.pageErrors.push(e.message));
  page.on("requestfailed", (r) => {
    const failure = r.failure()?.errorText ?? "";
    if (IGNORED_FAILURES.some((f) => failure.includes(f))) return;
    trace.failedRequests.push(`${r.method()} ${r.url()} — ${failure}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) trace.httpErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return trace;
}

const clear = (trace: Trace): void => {
  trace.consoleErrors.length = 0;
  trace.pageErrors.length = 0;
  trace.failedRequests.length = 0;
  trace.httpErrors.length = 0;
};

// ── the report ───────────────────────────────────────────────────────

type Finding = {
  route: string;
  theme: Theme;
  device: Device;
  path: string;
  /** Where the route actually ended up — a redirect is a finding too. */
  url: string;
  status: number | null;
  shot: string;
  audit: PageAudit;
  /** `offscreenRowActions` by viewport width: the device's own, plus `RUNG_WIDTHS` on one walk. */
  offscreenRowActions: Record<string, string[]>;
  /** `tableOverflow` at the same widths — how FAR a table scrolls, not just whether its verbs survive. */
  tableOverflow: Record<string, string[]>;
  trace: Trace;
};

// ── the walk ─────────────────────────────────────────────────────────

/**
 * Wait until the page has stopped becoming a different page. Retried,
 * because a route that redirects from inside a streamed render (the
 * step-up page does) destroys the execution context mid-measurement.
 */
async function settle(page: Page): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.waitForLoadState("load");
      // Self-hosted fonts: a shot taken before they swap measures the
      // fallback's metrics, not the design's.
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      // Finish every FINITE animation before anything measures the page.
      // This used to happen BY ACCIDENT: visit() took a full-page shot
      // with `animations: "disabled"`, which finishes finite animations,
      // so the audit always ran against settled geometry. The shot is no
      // longer taken under CI, and the design system outlasts the wait
      // below — `--dur-slow` is 320 ms (globals.css) and the item-peek
      // stop mounts a Sheet that is full-width at 390 px, so one still
      // sliding in would be measured mid-flight and reported as
      // horizontal overflow. Explicit here, so BOTH paths settle the
      // same way and a CI-only red cannot appear from this.
      //
      // NOT identical to Playwright's `animations: "disabled"`, and the
      // difference is deliberate: that mode CANCELS infinite animations
      // and replays them afterwards, while finish() throws on them and
      // we leave them running. That matches what the audit always saw —
      // Playwright had already resumed them by the time it ran.
      await page.evaluate(() => {
        for (const animation of document.getAnimations()) {
          try {
            animation.finish();
          } catch {
            /* infinite animations cannot finish; leave them running */
          }
        }
      });
      await page.waitForTimeout(150);
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
      await page.waitForTimeout(300);
    }
  }
}

async function visit(
  page: Page,
  stop: Stop,
  theme: Theme,
  device: Device,
  trace: Trace,
  findings: Finding[],
  seed: E2ESeed,
): Promise<void> {
  clear(trace);
  const response = await page.goto(stop.path, { waitUntil: "domcontentloaded" });
  await settle(page);
  if (stop.drive) await stop.drive(page);
  await settle(page);

  const shot = `${stop.name}__${theme}__${device}.png`;
  // The shots are a HUMAN artefact — 192 full-page PNGs for the craft
  // review. Nothing asserts on them: this repo has no committed
  // baselines and no toHaveScreenshot anywhere, and ci.yml uploads only
  // playwright-report/, so under CI they were rendered, encoded and then
  // discarded unread. The pass/fail signal is the audit below and the
  // expect.soft assertions that read it; both are untouched, and the
  // filename still travels in the finding so a report reads the same.
  // What this call ALSO did — finish every running animation, via
  // `animations: "disabled"` — settle() now does explicitly for both
  // paths, because that side effect was load-bearing for the audit and
  // nothing said so.
  if (!process.env["CI"]) {
    await page.screenshot({ path: join(SHOTS, shot), fullPage: true, animations: "disabled" });
  }

  const audit = await page.evaluate(auditPage);
  const status = response?.status() ?? null;
  const finding: Finding = {
    route: stop.name,
    theme,
    device,
    path: stop.path,
    url: new URL(page.url()).pathname + new URL(page.url()).search,
    status,
    shot,
    audit,
    offscreenRowActions: {},
    tableOverflow: {},
    trace: JSON.parse(JSON.stringify(trace)) as Trace,
  };
  findings.push(finding);

  const at = `${stop.name} [${theme}/${device}]`;
  const allowed = stop.status ?? [200];

  expect.soft(allowed, `${at}: document status ${status}`).toContain(status);
  if (stop.url) {
    expect.soft(new URL(page.url()).pathname, `${at}: landed on`).toBe(stop.url);
  }

  // Exactly one h1: the heading outline is the page's structure, and a
  // route that lost or doubled its title has lost it for everyone.
  expect.soft(audit.h1.count, `${at}: h1 count (${audit.h1.texts.join(" | ")})`).toBe(1);

  // Text the same colour as what is behind it.
  expect.soft(audit.invisibleText, `${at}: text invisible against its backdrop`).toEqual([]);

  // A translation key that reached the screen instead of its message.
  expect.soft(audit.rawKeys, `${at}: raw i18n keys rendered`).toEqual([]);

  // Nothing renders as a picture of nothing.
  expect.soft(audit.images.brokenImgs, `${at}: broken images`).toEqual([]);
  expect.soft(audit.images.svgs, `${at}: icons present`).toBeGreaterThan(0);

  if (device === "mobile") {
    expect
      .soft(
        audit.overflow.scrollWidth,
        `${at}: horizontal overflow — ${audit.overflow.offenders.join(", ")}`,
      )
      .toBeLessThanOrEqual(audit.overflow.clientWidth + 1);
  }

  // ── the craft gate (refinement pass §4) ──────────────────────────
  // These are the three founder mandates plus the acceptance criteria,
  // asserted on every stop so none of them can regress quietly. Soft,
  // like everything else here: one bad route must not hide the rest.
  const craft = audit.craft;

  // MANDATE 1 — pages that should read as content read as content.
  expect
    .soft(craft.restingRowControls, `${at}: form control visible in a resting table row`)
    .toEqual([]);
  expect.soft(craft.badInlineEdits, `${at}: inline-edit rest state is not a named <button>`).toEqual([]);

  // MANDATE 2 — the destructive weight lives in the menu and in the
  // confirm's "Yes", nowhere else.
  expect.soft(craft.destructiveInRows, `${at}: destructive control inside a table row`).toEqual([]);
  expect
    .soft(craft.destructiveFills, `${at}: solid --destructive fill outside a confirm group`)
    .toEqual([]);

  // MANDATE 3 — no OS file input anywhere in the product.
  expect.soft(craft.visibleFileInputs, `${at}: raw native file input on screen`).toEqual([]);

  // A "nothing here yet" state that offers nothing to do is a dead end.
  expect.soft(craft.deadEndEmptyStates, `${at}: empty state with no action`).toEqual([]);

  // A table that scrolls must be reachable and named.
  expect.soft(craft.unnamedScrollRegions, `${at}: unnamed or unfocusable scroll region`).toEqual([]);

  // §10.15.1 — a bordered table inside a padded card is two hairlines.
  expect.soft(craft.doubleHairlines, `${at}: bordered DataTable inside a padded SectionCard`).toEqual([]);

  // A row's verbs live in the table's pinned column, on every stop.
  expect
    .soft(craft.unpinnedRowActions, `${at}: row actions in a column that is not pinned`)
    .toEqual([]);

  // A row's verbs behind an unadvertised horizontal scroll are verbs
  // nobody will find — the case column priority exists to fix. Asked at
  // this device's width on every walk, and at `RUNG_WIDTHS` on ONE:
  // widths are the same in both themes, and the mobile walk would only
  // repeat the desktop one's resizes. Every answer is in the report too.
  const own = await page.evaluate(offscreenRowActions);
  finding.offscreenRowActions[String(VIEWPORTS[device].width)] = own;
  expect.soft(own, `${at}: row actions outside their table's visible box`).toEqual([]);
  // And how FAR it scrolls. The pin keeps the verbs; this keeps the
  // table inside its box, which is what column priority is FOR.
  // Keyed by WIDTH as well as stop, so a number measured on a phone
  // cannot license the same scroll on a desktop (see KNOWN_OVERFLOW).
  const describe = (r: TableOverflow) => `"${r.label}" (${r.box}px box): ${r.px}px`;
  const overflowing = (rows: TableOverflow[], width: number): string[] => {
    const known = KNOWN_OVERFLOW[`${stop.name}@${width}`] ?? 0;
    return rows.filter((r) => r.px > known).map((r) => `${describe(r)} of scroll, known ${known}px`);
  };
  const ownWidth = VIEWPORTS[device].width;
  const ownOver = await page.evaluate(tableOverflow);
  finding.tableOverflow[String(ownWidth)] = ownOver.map(describe);
  expect
    .soft(overflowing(ownOver, ownWidth), `${at}: a table overflows its own scroll box`)
    .toEqual([]);
  if (device === "desktop" && theme === "light") {
    try {
      for (const width of RUNG_WIDTHS) {
        await page.setViewportSize({ width, height: VIEWPORTS.desktop.height });
        const past = await page.evaluate(offscreenRowActions);
        finding.offscreenRowActions[String(width)] = past;
        expect.soft(past, `${at} at ${width}px: row actions outside their table's visible box`).toEqual([]);
        const over = await page.evaluate(tableOverflow);
        finding.tableOverflow[String(width)] = over.map(describe);
        expect
          .soft(
            overflowing(over, width),
            `${at} at ${width}px: a table overflows its own scroll box`,
          )
          .toEqual([]);
      }
    } finally {
      await page.setViewportSize(VIEWPORTS[device]);
    }
  }

  // Row rhythm. Desktop only: at 390px a cell legitimately wraps and
  // takes its row with it, which is the point of column priority.
  if (device === "desktop") {
    expect
      .soft(
        craft.rowPitch.map((r) => `${r.selector} ${r.actual}px ≠ ${r.expected}px`),
        `${at}: row pitch is not its --row-h`,
      )
      .toEqual([]);
  }

  // The shell says where you are exactly once (§3.3, P8 rule 3). Null
  // means the route renders outside the app shell (the root 404, the
  // auth lockup) and therefore has no bar to mark.
  if (device === "mobile" && craft.tabBarCurrent !== null) {
    expect.soft(craft.tabBarCurrent, `${at}: aria-current entries in the tab bar`).toBe(1);
  }

  // A strip marks exactly where you are, and that mark is on screen.
  if (craft.tabStrip) {
    expect
      .soft(craft.tabStrip.hasCurrent, `${at}: the tab strip marks no current tab`)
      .toBe(true);
    if (craft.tabStrip.hasCurrent) {
      expect.soft(craft.tabStrip.visible, `${at}: current tab is outside the tab strip`).toBe(true);
    }
  }

  // §10.7 — a WORKSPACE-level page's h1 is the page noun, not
  // "{tenant} — {page}"; the tenant name stays in <title> and in the
  // header trail. Scoped to the three routes that had it wrong: every
  // fixture entity is named after the same run id, so a blanket
  // substring test would flag "E2E Project 0b672f2a" — an entity h1,
  // which is correct — rather than the defect.
  // The <title> is only required to be non-empty: §4 says it *may*
  // carry the workspace, and today it carries "{page} · Fortleva".
  const tenant = seed.tenantSlug.replace(/^e2e-/, "");
  if (WORKSPACE_H1.includes(stop.name)) {
    expect.soft(audit.h1.texts[0] ?? "", `${at}: h1 carries the tenant name`).not.toContain(tenant);
    expect.soft(audit.documentTitle, `${at}: document has no title`).not.toBe("");
  }

  if (!stop.expectsFailure) {
    // A stop whose document is legitimately a 404 gets one console line
    // from the browser itself for that very response; the defect this
    // assertion hunts is script noise, not the status we asked for.
    const expectedStatusNoise = allowed
      .filter((s) => s !== 200)
      .map((s) => `responded with a status of ${s}`);
    const console = trace.consoleErrors.filter(
      (e) => !expectedStatusNoise.some((noise) => e.includes(noise)),
    );
    const unexpected = trace.httpErrors.filter((e) => !allowed.some((s) => e.startsWith(`${s} `)));

    expect.soft(trace.pageErrors, `${at}: uncaught page errors`).toEqual([]);
    expect.soft(console, `${at}: console errors`).toEqual([]);
    expect.soft(trace.failedRequests, `${at}: failed requests`).toEqual([]);
    expect.soft(unexpected, `${at}: unexpected HTTP errors`).toEqual([]);
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const device of Object.keys(VIEWPORTS) as Device[]) {
    test.describe(`${theme} · ${device}`, () => {
      test.use({ viewport: VIEWPORTS[device], colorScheme: theme });

      test("every route renders", async ({ page, context, browser, baseURL }) => {
        // 48 stops × 3 navigations, five minutes next to the database.
        // The CI branch was 900 s, sized when the runner was in the US
        // and the database in the EU (~10 s a stop on a slow evening).
        // Since 2026-09-01 CI runs against a service container on the
        // runner, so the link is gone and only the smaller machine is
        // left: 600 s is 2× the local budget. Note this is a per-ATTEMPT
        // budget and CI sets `retries: 1`, so four walks can cost twice
        // this in the worst case — ci.yml's ceiling comment does the
        // arithmetic. DERIVED, like every other number in this change —
        // read the real per-walk time off the first green run. The light
        // desktop walk also resizes nine times per stop (`RUNG_WIDTHS`);
        // with seven it took 2.4 min locally against the remote dev DB.
        test.setTimeout(process.env["CI"] ? 600_000 : 300_000);
        const seed = requireSeed();
        const all = stops(seed);
        const findings: Finding[] = [];

        // The theme is a cookie (src/lib/theme.ts), so the signed-in and
        // signed-out surfaces are pinned the same way and the SERVER
        // renders <html class="dark"> — there is no flash to race.
        const themeCookie = { name: "fl_theme", value: theme, url: baseURL! };
        await context.addCookies([themeCookie]);
        const trace = watch(page);

        try {
          for (const stop of all.filter((s) => !s.anon)) {
            await visit(page, stop, theme, device, trace, findings, seed);
          }

          // The auth lockup has no session by definition.
          const anon: BrowserContext = await browser.newContext({
            viewport: VIEWPORTS[device],
            colorScheme: theme,
            locale: "en-US",
            storageState: { cookies: [], origins: [] },
          });
          try {
            await anon.addCookies([themeCookie]);
            const anonPage = await anon.newPage();
            const anonTrace = watch(anonPage);
            for (const stop of all.filter((s) => s.anon)) {
              await visit(anonPage, stop, theme, device, anonTrace, findings, seed);
            }
          } finally {
            await anon.close();
          }
        } finally {
          // Written even when the walk throws: a partial audit is still
          // the fastest way to see what the shots are showing.
          writeFileSync(
            join(SHOTS, `report-${theme}-${device}.json`),
            `${JSON.stringify(findings, null, 2)}
`,
            "utf8",
          );
        }
      });
    });
  }
}
