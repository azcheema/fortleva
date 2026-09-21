import { expect, test, type Page } from "@playwright/test";

import { CONTACT_STORAGE_STATE, STORAGE_STATE, requireSeed } from "./fixtures/tenant";

/**
 * VIEW-AS-CONTACT, BYTE-COMPARED TO A REAL CONTACT SESSION (Phase 3
 * slice 5).
 *
 * SECURITY.md §5.1's vector table asks for exactly this — "output
 * byte-compared to a real contact session in CI" — and it is the guard
 * the founder's session-model decision rests on. View-as runs under the
 * MEMBER'S own session (PLAN §0, 2026-09-20 decision 1), so the thing on
 * screen is not *quite* the thing a contact receives, and the only
 * honest way to make that safe is to measure the difference and find
 * none.
 *
 * THE DBTEST NEXT DOOR PROVES THE JSON HALF — that the synthesised
 * principal equals the session-derived one field for field, so the two
 * reads cannot return different rows. This proves the half a dbtest
 * cannot reach: the RENDER. Locale, time zone, chrome, copy, markup.
 *
 * WHY IT SWITCHES THE MEMBER TO SWEDISH FIRST, which is the whole
 * design of the test rather than a flourish. With both sides in English
 * the comparison passes whether or not the locale pin exists, and PLAN
 * §0 named that pin owed before the slice started. The seeded contact
 * has no `Contact.locale` — nothing in the product writes one — so a
 * real contact request resolves English from its browser's
 * Accept-Language, and `/view-as` pins English because that is what a
 * contact with no recorded language gets. The MEMBER meanwhile reads
 * Swedish. Without the pin the member's own locale would win and every
 * string on the page would differ; with it, the two documents are the
 * same bytes. The pin is therefore the only reason this test can pass.
 *
 * WHAT IS COMPARED IS `[data-portal-surface]`, marked on the portal's
 * own frame. The chrome is deliberately INSIDE it — the bar, the product
 * mark and the "signed in as" line are as much what the client sees as
 * the task list — and the red View-as banner is deliberately outside,
 * being the one thing on this route no contact ever receives. Naming the
 * boundary in the markup rather than agreeing on a CSS selector in a
 * spec file is what stops this from silently comparing less than it
 * claims; `src/authz/portal-view-as.test.ts` fails if the banner ever
 * moves inside it.
 */

const seed = requireSeed();

/** The compared region, with the attributes React varies per render stripped. */
async function portalSurface(page: Page): Promise<string> {
  const surface = page.locator("[data-portal-surface]");
  await expect(surface).toBeVisible({ timeout: 30_000 });
  return surface.evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    // React 19 emits nothing per-render into this subtree today, so this
    // is a guard rather than a fix: if a future component adds an
    // `id`/`aria-controls` pair from `useId`, the comparison would start
    // failing on two documents that are otherwise identical, and the
    // failure would read as a leak. Stripped by NAME, so anything else
    // that differs still fails the test.
    for (const node of clone.querySelectorAll("*")) {
      for (const attr of ["id", "aria-controls", "aria-labelledby", "aria-describedby"]) {
        const v = node.getAttribute(attr);
        if (v && /:r[0-9a-z]+:|«r/i.test(v)) node.removeAttribute(attr);
      }
    }
    return clone.innerHTML;
  });
}

test.describe("view-as-contact", () => {
  /**
   * THE MEMBER'S LANGUAGE IS RESTORED HERE, NOT IN A `finally`, and the
   * difference is an afternoon (code review).
   *
   * The comparison below only means anything if the member is reading
   * SWEDISH while the contact reads English — so the test writes
   * `User.locale` on the ONE seeded member every other spec shares. A
   * `finally` looks like the right home for the undo, and is not: a
   * Playwright TEST TIMEOUT abandons the test body, and every `await`
   * inside a `finally` then fails immediately, so the restore never
   * completes. `view-as.spec.ts` sorts before `visibility.spec.ts` and
   * `visual.spec.ts`, so one timeout here would hand the 204-screenshot
   * walk a Swedish UI — precisely the "broad cross-surface e2e failure
   * with an unrelated cause" AGENTS.md records as a standing trap.
   *
   * `afterAll` runs with its own timeout budget after an aborted test,
   * so the undo happens whether the body finished, failed or was killed.
   */
  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: STORAGE_STATE });
    try {
      const page = await ctx.newPage();
      await page.goto("/account");
      const back = page.locator("#locale");
      await expect(back).toBeVisible({ timeout: 30_000 });
      await back.click();
      await page.getByRole("option", { name: "English", exact: true }).click();
      await expect.poll(() => page.locator("html").getAttribute("lang")).toBe("en");
    } finally {
      await ctx.close();
    }
  });

  test("renders byte-identical output to a real contact session", async ({ page, browser }) => {
    // ── The contact's own page, in a context of its own ──────────────
    // A SEPARATE CONTEXT, never a second cookie in the member jar: the
    // planes are separate tables with separate secrets, and a browser
    // holding both is a state no real surface produces (global-setup
    // makes the same point when it mints this session).
    const portal = await browser.newContext({
      storageState: CONTACT_STORAGE_STATE,
      locale: "en-US",
    });
    let contactHtml: string;
    try {
      const contactPage = await portal.newPage();
      await contactPage.goto("/portal");
      contactHtml = await portalSurface(contactPage);
      await contactPage.close();
    } finally {
      await portal.close();
    }
    // NOT VACUOUS — and the first cut of this guard did not measure that
    // (code review). It asserted `toContain(seed.contactName)` and a
    // length over 200, both of which the portal CHROME satisfies on its
    // own: `PortalFrame` renders "Signed in as Astrid Lindqvist" and its
    // markup alone is comfortably longer than 200 characters. If the
    // seed ever stopped sharing work with this client, both sides would
    // render `PortalTasksEmpty`, the comparison would hold two identical
    // empty states, and it would pass forever — the exact failure this
    // spec's docblock claims to have prevented.
    //
    // So the guard is on SHARED CONTENT: two CLIENT_VISIBLE tasks the
    // seed marks for this client (`seed-cli.ts:568-580`), and the
    // absence of the empty state.
    expect(contactHtml).toContain("Tillgänglighetsgranskning");
    expect(contactHtml).toContain("Migrera DNS till ny leverantör");
    expect(contactHtml).not.toContain('data-slot="empty-state"');

    // ── The member, reading SWEDISH, entering View-as ────────────────
    await page.goto("/account");
    const locale = page.locator("#locale");
    await expect(locale).toBeVisible({ timeout: 30_000 });
    await locale.click();
    await page.getByRole("option", { name: "Svenska", exact: true }).click();
    await expect.poll(() => page.locator("html").getAttribute("lang")).toBe("sv");

    {
      await page.goto(`/projects/${seed.projectKey}/portal`);
      // The button names the contact, so this also asserts the tab chose
      // a viewer at all — with no admissible contact it does not render.
      await page.getByRole("button", { name: new RegExp(seed.contactName) }).click();
      await page.waitForURL("**/view-as", { timeout: 30_000 });

      // THE BANNER IS THERE, IT IS OUTSIDE THE SURFACE, AND IT IS IN THE
      // MEMBER'S LANGUAGE — the last of which is the point of asserting
      // it here rather than trusting the component.
      //
      // The whole request is pinned to the CONTACT'S locale so the
      // surface below can be byte-compared. The banner and its exit
      // button are the only member-facing things on the route — the
      // warning that you are looking at somebody else's screen, and the
      // control that gets you out — and a code review caught the first
      // cut rendering both in the client's language. So: an ENGLISH
      // page, with a SWEDISH warning across the top, on one document.
      const banner = page.locator('[data-slot="view-as-banner"]');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(seed.contactName);
      await expect(banner).toContainText("Du ser sidan som");
      await expect(page.getByRole("button", { name: "Lämna kundvyn" })).toBeVisible();
      expect(await banner.evaluate((el) => el.closest("[data-portal-surface]") !== null)).toBe(
        false,
      );

      // THE PAGE IS IN THE CONTACT'S LANGUAGE, NOT THE MEMBER'S. Pinned
      // on <html> by the request config, which is the level next-intl's
      // server hooks read (`src/clients/view-as-context.ts`).
      await expect.poll(() => page.locator("html").getAttribute("lang")).toBe("en");

      // ── THE COMPARISON ───────────────────────────────────────────────
      expect(await portalSurface(page)).toBe(contactHtml);

      // ── AND LEAVING WORKS, from inside the mode ──────────────────────
      await page.getByRole("button", { name: "Lämna kundvyn" }).click();
      await page.waitForURL("**/home", { timeout: 30_000 });
      // The member is themselves again — Swedish, their own application.
      await expect.poll(() => page.locator("html").getAttribute("lang")).toBe("sv");
      // …and the mode really ended: /view-as with no pointer renders
      // nothing and sends them home rather than showing a stale client.
      await page.goto("/view-as");
      await page.waitForURL("**/home", { timeout: 30_000 });
    }
  });

  test("a member cannot reach the portal plane by typing its URL", async ({ page }) => {
    // The reason View-as exists as a member-plane route at all: the
    // proxy gates `/portal` on the PORTAL session cookie, so a member
    // arriving with only a member cookie is sent to a sign-in form that
    // cannot authenticate them. Pinned here because the day someone
    // "fixes" that redirect is the day the plane boundary opens.
    await page.goto("/portal");
    // A REGEX, not a glob: the proxy appends `?next=/portal` so the
    // member lands back where they aimed after signing in, and
    // `**/portal/login` does not match a URL with a query string.
    await page.waitForURL(/\/portal\/login(\?|$)/, { timeout: 30_000 });
  });
});
