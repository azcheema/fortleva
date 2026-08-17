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
    { name: "project-files", path: `${project}/files` },
    { name: "project-team", path: `${project}/team` },
    { name: "files", path: "/files" },
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
        test.setTimeout(300_000);
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
            await visit(page, stop, theme, device, trace, findings);
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
              await visit(anonPage, stop, theme, device, anonTrace, findings);
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
