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
import { driftFor, DRIFT_MAX_PX, DRIFT_MIN_PX, VOLATILE_STOPS } from "./fixtures/overflow";
import { settle } from "./fixtures/settle";
import { RUNG_WIDTHS, stops, VIEWPORTS, type Stop } from "./fixtures/stops";
import { CONTACT_STORAGE_STATE, requireSeed, type E2ESeed } from "./fixtures/tenant";

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

/**
 * KNOWN OVERFLOW, keyed `<stop>@<width>`: the horizontal scroll that stop
 * HAS at that viewport width. Column priority exists so a table fits its
 * box, so every key not listed is held to 0 — including every OTHER width
 * of a stop that appears here, which is the point of keying on the width:
 * `projects` was 412px over at 390px and 0 at 1440px, and a per-stop
 * number would have licensed 412px everywhere.
 *
 * A RATCHET, not an allowance: one pixel past the number (plus the
 * proportional slack below) and the walk fails, so fixing a stop means deleting its keys in the same
 * commit. `offscreenRowActions` above proves a row's verbs stay reachable,
 * but since slice 18 pinned that column it stayed true however far a table
 * scrolled — nothing bounded the scroll itself, which is slice 18's owed
 * (a) and how these numbers survived unseen. They are worst on a PHONE,
 * which this walk has photographed all along.
 *
 * **CALIBRATED AGAINST CI, and it has to be** (2026-09-18, run
 * 35291774042 — the first run went red and taught this): a local
 * `playwright test visual` measures a DIFFERENT app. The walk runs after
 * `time.spec.ts` (`workers: 1`, `fullyParallel: false`, alphabetical —
 * only `work.spec.ts` sorts after it), so in a full suite its tables hold
 * whatever earlier specs left behind — `time.spec.ts`'s entries above all — while a
 * visual-only run finds them empty. Numbers below are CI's. Re-calibrate
 * from a CI log, never from a local visual-only run.
 *
 * IT IS EMPTY, as of 2026-09-20, and an empty map is the strongest
 * thing it can say: every table in the product fits its box at every
 * width this walk measures, in English. Nothing is suppressed here and
 * nothing needs to be. The machinery stays because the NEXT entry is
 * what it exists for — and because emptiness is asserted, not assumed:
 * an unlisted key is held to 0, so the walk goes red the day one
 * appears rather than quietly growing a number.
 *
 * WHAT THEY WERE:
 *   • `files`, `client-files`, `error-banner`, `project-files` — 4-6px,
 *     named rather than hidden under a tolerance wide enough to blind
 *     every other stop. FIXED 2026-09-20, by the Swedish walk finding
 *     them at 14/14/14/7 and making them worth a slice: the documents
 *     table's name cell carried a per-viewport `max-w-28 sm:max-w-64`,
 *     and a max-width on a table CELL is a FLOOR in Chromium, so the
 *     column sat at 112px however little room was left. It takes the
 *     containment idiom now, and every other column an explicit width
 *     so the name is the one that absorbs slack.
 *
 * AND BEFORE THEM — the twelve `projects` / `clients` / `clients-archived`
 * keys this table carried on 2026-09-18 are GONE, fixed rather than
 * ratcheted (slice 28), and both causes were the ones PLAN §0 slice-17
 * owed (f) already named, neither a column-priority mistake:
 *   • `projects` — `<Table className="table-fixed min-w-3xl">` was a hard
 *     48rem = 768px FLOOR. Every number was exactly 768 − box (356+412,
 *     494+274, 606+162, 608+160, 734+34, 736+32), a CONSTANT in every
 *     locale and on both platforms, because a fixed table cannot be
 *     widened by content. `table-fixed` stays — it is what aligns the six
 *     headings across the stacked per-client tables — and the floor went.
 *   • `clients` — the name cell's `max-w-[420px]` was a FLOOR in
 *     Chromium, a max-width clamping the cell's min-content contribution
 *     as well as its max-content one. `clients-archived` was ~14px more
 *     at every width: the same table with the wider "Archived" badge. The
 *     control that proved the reading was `/clients/[id]/projects`, which
 *     carried the same capped cell, never reached it, and sat at 0. All
 *     three now use the backlog's `contain-inline-size` + `w-full`
 *     wrapper over a `min-w` floor (UI.md §10.12).
 *
 * NOT A DEFECT LIST BY DEFINITION. `table.tsx` and UI.md §10.12 record a
 * settled trade — since the actions column is pinned, a rung may carry a
 * little scroll at its very edge in exchange for more columns — so a
 * future entry may be that trade rather than a bug, and must be labelled
 * as such. The harness is ENGLISH and cannot
 * see the trade at all: the backlog is 0 here and 29px over at the
 * `lowest` rung's narrow edge in Swedish. THE TRADES DO NOT BELONG IN
 * THIS MAP and never will — `zz-swedish-widths.spec.ts` shipped on
 * 2026-09-19 and owns them in `KNOWN_OVERFLOW_SV`. A key here is
 * language-blind, so copying a Swedish number in would license 29px of
 * scroll on a stop this walk measures at 0. (An earlier draft of this
 * comment said the owed Swedish walk "will add trades here", which was
 * the wrong file even before that walk existed.)
 */
const KNOWN_OVERFLOW: Record<string, number> = {};

type Device = keyof typeof VIEWPORTS;
type Theme = "light" | "dark";

/**
 * Workspace-level routes: their h1 is the page noun ("Files"), never
 * "{tenant} — Files". An entity route's h1 IS the entity's name and may
 * legitimately contain anything.
 */
const WORKSPACE_H1 = ["files", "members", "settings-roles"];

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
  // The shots are a HUMAN artefact — 200 full-page PNGs for the craft
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
    // An EXEMPT stop is not a silent one. Its numbers went into the
    // report and nowhere else, and the report is written locally and
    // uploaded only on FAILURE — so on a green CI run the worst
    // overflow in the product was unobservable, which is how
    // `time-team`'s 249px sat there. Printing them puts them in the one
    // artefact a later session is told to calibrate from (the CI LOG),
    // which is the precondition for ever ratcheting these stops at all
    // (PLAN §0's owed (a)). It cannot fail a run: this is the branch
    // that returns no findings.
    if (VOLATILE_STOPS.has(stop.name)) {
      for (const r of rows) console.log(`[volatile] ${at} at ${width}px: ${describe(r)}`);
      return [];
    }
    const known = KNOWN_OVERFLOW[`${stop.name}@${width}`] ?? 0;
    // The drift rides on a KNOWN number only: an unlisted key stays at 0.
    const ceiling = known + driftFor(known);
    return rows
      .filter((r) => r.px > ceiling)
      .map((r) => `${describe(r)} of scroll, allowed ${ceiling}px (known ${known}px)`);
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

/**
 * The ratchet cannot tighten itself, so at least stop it ROTTING: a key
 * naming a stop that was renamed, removed or fixed would sit there
 * forever, silently licensing scroll on nothing. Cheap, and it runs
 * without a browser.
 */
test("every KNOWN_OVERFLOW and VOLATILE_STOPS name is a real stop", () => {
  const names = new Set(stops(requireSeed()).map((s) => s.name));
  const unknownKeys = Object.keys(KNOWN_OVERFLOW).filter(
    (k) => !names.has(k.slice(0, k.lastIndexOf("@"))),
  );
  const unknownWidths = Object.keys(KNOWN_OVERFLOW).filter((k) => {
    const w = Number(k.slice(k.lastIndexOf("@") + 1));
    return w !== VIEWPORTS.desktop.width && w !== VIEWPORTS.mobile.width && !RUNG_WIDTHS.includes(w as (typeof RUNG_WIDTHS)[number]);
  });
  expect(unknownKeys, "KNOWN_OVERFLOW keys naming no stop").toEqual([]);
  expect(unknownWidths, "KNOWN_OVERFLOW keys at a width never measured").toEqual([]);
  expect([...VOLATILE_STOPS].filter((n) => !names.has(n)), "VOLATILE_STOPS naming no stop").toEqual(
    [],
  );
});

/**
 * The slack is the one thing in this file that can quietly stop the
 * ratchet from ratcheting, and it is pure arithmetic — so it is checked
 * here, in process, beside the name-rot test and without a browser.
 *
 * The load-bearing property is the LAST one: this can only ever tighten.
 * A change to the three constants that widened any number's allowance
 * would be a change that licensed a regression somewhere, and it would
 * fail here rather than in six months' CI log.
 */
test("the overflow ratchet's slack is proportional, and can only tighten", () => {
  // An unlisted key, and a key listed at 0, are held to the pixel.
  expect(driftFor(0)).toBe(0);
  expect(driftFor(-1)).toBe(0);

  // The sizes the two maps carry, spelled out rather than derived — so a
  // constant nudged by a future session fails with the number in hand.
  // `KNOWN_OVERFLOW` is empty as of 2026-09-20, so these are the Swedish
  // ratchet's (27 and 29, where `DRIFT_MAX_PX` caps the slack flat) plus
  // the 4 and 6 this walk carried until that day — kept because they are
  // the SMALL sizes the proportional half exists for, and the ones that
  // come back first.
  expect(driftFor(4)).toBe(1);
  expect(driftFor(6)).toBe(2);
  expect(driftFor(27)).toBe(4);
  expect(driftFor(29)).toBe(4);

  const sizes = Array.from({ length: 500 }, (_, i) => i + 1);

  // Never below a pixel of sub-pixel rounding, never above the flat
  // tolerance this replaced, and never decreasing as the number grows.
  for (const n of sizes) {
    expect(driftFor(n), `drift at ${n}px`).toBeGreaterThanOrEqual(DRIFT_MIN_PX);
    expect(driftFor(n), `drift at ${n}px`).toBeLessThanOrEqual(DRIFT_MAX_PX);
  }
  for (const n of sizes.slice(1)) {
    expect(driftFor(n), `drift is monotone at ${n}px`).toBeGreaterThanOrEqual(driftFor(n - 1));
  }

  // A listed number can never DOUBLE inside its own allowance. At 1px it
  // can, and that is the honest exception: one pixel to two is the
  // rounding this floor exists for, not a regression.
  for (const n of sizes.slice(1)) {
    expect(n + driftFor(n), `${n}px could double`).toBeLessThan(n * 2);
  }

  // THE ONE THAT MATTERS: never wider than the flat 4px this replaced,
  // at any size at all. Asserted over the SWEEP and deliberately not
  // over `KNOWN_OVERFLOW`'s current values — a review caught that: a
  // loop demanding every listed key be strictly under 4 is a property of
  // today's four small keys, not of this function, and the ~30px Swedish
  // backlog entry this file already plans for (PLAN §0 owed (c)) would
  // have failed it while being perfectly correct.
  for (const n of sizes) expect(driftFor(n), `drift at ${n}px`).toBeLessThanOrEqual(4);
});

for (const theme of ["light", "dark"] as const) {
  for (const device of Object.keys(VIEWPORTS) as Device[]) {
    test.describe(`${theme} · ${device}`, () => {
      test.use({ viewport: VIEWPORTS[device], colorScheme: theme });

      test("every route renders", async ({ page, context, browser, baseURL }) => {
        // 50 stops × 3 navigations, five minutes next to the database.
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
          for (const stop of all.filter((s) => !s.anon && !s.session)) {
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

          // The PORTAL plane: a real contact session, minted through the
          // real endpoint in global-setup. A context of its own rather
          // than a second cookie in this one — `src/auth/portal.ts` is a
          // separate table with a separate secret, and the surface must
          // be photographed under the principal that will really read it.
          const contactStops = all.filter((s) => s.session === "contact");
          if (contactStops.length > 0) {
            const contact: BrowserContext = await browser.newContext({
              viewport: VIEWPORTS[device],
              colorScheme: theme,
              locale: "en-US",
              storageState: CONTACT_STORAGE_STATE,
            });
            try {
              await contact.addCookies([themeCookie]);
              const contactPage = await contact.newPage();
              const contactTrace = watch(contactPage);
              for (const stop of contactStops) {
                await visit(contactPage, stop, theme, device, contactTrace, findings, seed);
              }
            } finally {
              await contact.close();
            }
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
