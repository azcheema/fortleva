import { expect, type Page } from "@playwright/test";

import { isActionPost } from "./actions";
import type { E2ESeed } from "./tenant";

/**
 * THE STOP LIST AND THE WIDTHS, in one place because there are now two
 * walks over them (`visual.spec.ts` in English, `zz-swedish-widths.spec.ts`
 * in Swedish) and a route that existed in one list and not the other
 * would be a route nobody audits. Moved here from visual.spec.ts, which
 * owned them alone until 2026-09-19; a spec file cannot import from
 * another spec file without registering its tests twice.
 */

export const VIEWPORTS = {
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
export const RUNG_WIDTHS = [768, 880, 882, 1008, 1010, 1256, 1258, 1408, 1410] as const;

export type Stop = {
  /** File-name stem; stable, so shots diff across runs. */
  name: string;
  path: string;
  /** Rendered signed out (the auth lockup). */
  anon?: true;
  /**
   * Rendered under a plane OTHER than the member one. `"contact"` walks
   * the stop in a real portal session (`.auth/contact.json`,
   * global-setup) — the harness's third principal, added with the first
   * portal route (memo §2.4: "the portal walk needs an anonymous-ish
   * fixture — a contact session — which the harness has no concept of
   * today").
   *
   * The Swedish width walk SKIPS these, and that is a gap rather than a
   * decision: its `setLanguage` writes `User.locale`, and a contact's
   * language comes from `Contact.locale` (src/i18n/resolve.ts). Covering
   * the portal in Swedish needs a contact-side switch, which the invite
   * slice's profile menu is the natural home for.
   */
  session?: "contact";
  /** Accepted document statuses; defaults to [200]. */
  status?: number[];
  /** Expected landing path when the route deliberately redirects. */
  url?: string;
  /** This stop is *about* a failure, so its noise is the point. */
  expectsFailure?: true;
  /**
   * Drive the page into the state worth photographing.
   *
   * KEEP IT LOCALE-AGNOSTIC — a keystroke, a test id, a role with no
   * name — or the stop can only ever be walked in English. The Swedish
   * width walk shares this list, and `error-boundary`'s driver, which
   * names an English button, is why it has to skip `expectsFailure`.
   */
  drive?: (page: Page) => Promise<void>;
};

/** A route that does not exist, for the root 404. */
const MISSING = "/this-route-does-not-exist";

export const stops = (seed: E2ESeed): Stop[] => {
  const client = `/clients/${seed.clientId}`;
  const project = `/projects/${seed.projectKey}`;
  return [
    // ── the unauthenticated lockup ──────────────────────────────────
    { name: "login", path: "/login", anon: true },
    { name: "signup", path: "/signup", anon: true },
    { name: "invite", path: `/invite/${seed.inviteToken}`, anon: true },
    { name: "invite-unavailable", path: "/invite/expired-or-unknown-token", anon: true },
    // MEMBER ACCOUNT RECOVERY (C30): the password reset's three states —
    // the request form, the new-password form over a live link, the
    // dead-link state — and the confirmation page's two. The live links
    // stand still because the fixture seeds them for two people who belong
    // to no workspace (`memberResetToken`, `memberConfirmToken`), and a
    // visit only READS either: the new-password page checks its link, and
    // the confirmation page changes nothing on GET by design (a mail
    // scanner's GET must not confirm an address), which is also what makes
    // photographing it four times per run safe. NEVER add a `drive` that
    // presses either page's button. The drives below only ASSERT the live
    // form rendered — by id and element, never by English words — because
    // a dead link still renders one h1 and an icon, and without them these
    // stops would photograph "Link not available" under the live state's
    // name and pass. None of the five is metered.
    { name: "reset-request", path: "/reset-password", anon: true },
    {
      name: "reset",
      path: `/reset-password/${seed.memberResetToken}`,
      anon: true,
      drive: async (page) => {
        await expect
          .soft(page.locator("#reset-password"), "the seeded member reset link is live")
          .toBeVisible();
      },
    },
    { name: "reset-unavailable", path: "/reset-password/expired-or-unknown-token", anon: true },
    {
      name: "confirm-email",
      path: `/confirm-email/${seed.memberConfirmToken}`,
      anon: true,
      drive: async (page) => {
        await expect
          .soft(
            page.locator('main form button[type="submit"]'),
            "the seeded confirmation link is live and its address unconfirmed",
          )
          .toBeVisible();
      },
    },
    { name: "confirm-email-unavailable", path: "/confirm-email/not-a-token", anon: true },
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
    // Phase 3 slice 4: the master switch beside a preview that renders
    // through the portal's OWN projection and components. The seed
    // switches this project's portal on and activates a CONTACT_PRIMARY,
    // so the stop photographs the live panel rather than its empty
    // state — which makes it the second place a human ever looks at what
    // a client sees, and the only place both views are on one screen.
    { name: "project-portal", path: `${project}/portal` },
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

    // ── the portal plane (Phase 3) ──────────────────────────────────
    // The sign-in lockup, which every portal redirect lands on, and the
    // contact's own landing page. The second is the FIRST stop in this
    // list that is not rendered for a member, so it is also the first
    // thing the craft audit has ever said about what a client sees.
    { name: "portal-login", path: "/portal/login", anon: true },
    { name: "portal-home", path: "/portal", session: "contact" },
    // INVITATION ACCEPTANCE, both states, mirroring the member plane's
    // pair at the top of this list. The live one needs a token that
    // stands still, which is why the fixture seeds one
    // (`contactInviteToken`); a visit only previews, so the walk cannot
    // consume it. Both are `anon` by construction — the whole point of
    // the page is that the visitor has no session yet — and both are
    // metered by `portal.invite_preview`, which is sized at sixty an
    // hour precisely so that these four visits per walk, twice over,
    // cannot exhaust it (src/ratelimit's own note).
    { name: "portal-invite", path: `/portal/invite/${seed.contactInviteToken}`, anon: true },
    {
      name: "portal-invite-unavailable",
      path: "/portal/invite/expired-or-unknown-token",
      anon: true,
    },
    // THE PASSWORD RESET, all three states a visitor can land on: the
    // request form, the new-password form over a live link, and the
    // dead-link state. The live one needs a link that stands still, so
    // the fixture seeds one for the ACTIVE contact (`contactResetToken`);
    // a visit only reads it. NEVER add a `drive` that submits it — a
    // reset revokes every session that contact holds, and later specs
    // share hers. None of the three is metered, so the walks spend
    // nothing on them.
    { name: "portal-reset-request", path: "/portal/reset-password", anon: true },
    {
      name: "portal-reset",
      path: `/portal/reset-password/${seed.contactResetToken}`,
      anon: true,
    },
    {
      name: "portal-reset-unavailable",
      path: "/portal/reset-password/expired-or-unknown-token",
      anon: true,
    },

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
