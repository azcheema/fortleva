import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { auditPage, type PageAudit } from "./audit";
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
    { name: "dashboard", path: "/dashboard" },
    { name: "clients", path: "/clients" },
    { name: "clients-archived", path: "/clients?archived=1" },
    { name: "client-overview", path: client },
    { name: "client-projects", path: `${client}/projects` },
    { name: "client-contacts", path: `${client}/contacts` },
    { name: "client-files", path: `${client}/files` },
    { name: "projects", path: "/projects" },
    { name: "project-overview", path: project },
    { name: "project-board", path: `${project}/board` },
    { name: "project-backlog", path: `${project}/backlog` },
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
    { name: "members", path: "/members" },
    { name: "settings-roles", path: "/settings/roles" },
    { name: "settings-preferences", path: "/settings/preferences" },
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
          if (request.method() === "POST" && request.headers()["next-action"]) {
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
  await page.screenshot({ path: join(SHOTS, shot), fullPage: true, animations: "disabled" });

  const audit = await page.evaluate(auditPage);
  const status = response?.status() ?? null;
  findings.push({
    route: stop.name,
    theme,
    device,
    path: stop.path,
    url: new URL(page.url()).pathname + new URL(page.url()).search,
    status,
    shot,
    audit,
    trace: JSON.parse(JSON.stringify(trace)) as Trace,
  });

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

  // A row's verbs behind an unadvertised horizontal scroll are verbs
  // nobody will find — the phone case column priority exists to fix.
  expect
    .soft(craft.offscreenRowActions, `${at}: row actions outside their table's visible box`)
    .toEqual([]);

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

  // The current tab is on screen inside its own strip.
  if (craft.tabStrip) {
    expect.soft(craft.tabStrip.visible, `${at}: current tab is outside the tab strip`).toBe(true);
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
        // ~35 stops × 3 navigations. Five minutes next to the database; on
        // CI (US runner, EU database — ~10 s a stop on a slow evening) the
        // same walk needs three times that.
        test.setTimeout(process.env["CI"] ? 900_000 : 300_000);
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
