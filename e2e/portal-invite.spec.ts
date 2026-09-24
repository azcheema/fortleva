import { randomBytes } from "node:crypto";

import { expect, test } from "@playwright/test";

import { SLOW } from "./fixtures/keys";
import {
  STORAGE_STATE,
  readPortalInviteToken,
  readPortalResetLink,
  removeSpecContact,
  requireSeed,
} from "./fixtures/tenant";

/**
 * THE PORTAL'S FIRST DOOR, DRIVEN END TO END (Phase 3, the invite
 * flow's surfaces).
 *
 * **WHAT THIS PROVES THAT NO dbtest CAN.** `contact-access.dbtest.ts`
 * calls `inviteContact` and `acceptContactInvite` directly and asserts
 * on rows. This drives the whole chain a real client walks and nothing
 * shorter: a member presses a control, the service mails a link, the
 * link is read out of the message, an anonymous browser opens it, a
 * password is chosen, and a contact who did not exist an instant ago
 * lands on `/portal` holding a session of their own. Three seams in that
 * chain are invisible to every other instrument —
 *
 *   • the LINK. `portalInviteUrl` builds it, the mail carries it, the
 *     proxy has to let it through and the route has to exist. Four files
 *     agreeing, and only a browser following the actual address can say
 *     they do.
 *   • the COOKIE. `acceptContactInvite` deliberately mints no session,
 *     so the action signs the contact in afterwards through Better
 *     Auth's own api — which works only because `nextCookies()` can
 *     reach `next/headers` from a Server Action. In an RSC render the
 *     same call resolves with a token and writes no cookie, silently.
 *     A test that asserted on rows would be green either way.
 *   • the MAIL. This is the first test in the repository that makes the
 *     product actually send something. It needs `MAIL_DEV_OUTBOX=1` in
 *     `playwright.config.ts`'s `webServer.env`, because `next start`
 *     runs as production, where the mailer refuses the dev transport —
 *     and `inviteContact` sends AFTER its transaction commits, so
 *     without the flag pressing Invite writes the row and then throws.
 *
 * **IT CREATES ITS OWN CONTACT, and it has to.** The seeded contact is
 * already ACTIVE, and `inviteContact` refuses ACTIVE and SUSPENDED (it
 * admits NO_ACCESS, INVITED and — since C28 — REVOKED);
 * Bo Nilsson is invitable but is photographed by the `client-contacts`
 * stop, and Carina Ek carries the seeded invitation the acceptance
 * page's own stop is taken at. So this spec adds a person, invites them,
 * and takes them away again.
 *
 * **THE UNDO IS BOTH THE COVERAGE AND THE CLEANUP.** The body ends the
 * contact's access and deletes the record through the real row menu,
 * which is the only test of those two verbs; `afterAll` then runs the
 * fixture's belt for the case where the body never got there. It is in
 * `afterAll` and not a `finally` for the reason `portal-requests.spec`
 * records: a Playwright TIMEOUT abandons the body, and every await in a
 * `finally` fails at once. This spec sorts before `visual.spec.ts` and
 * `zz-swedish-widths.spec.ts`, both of which photograph the Contacts
 * tab, so a leftover row would change screenshots in specs that never
 * touched this one.
 *
 * **THE NEGATIVE CASES ARE DELIBERATELY TWO, AND THEY ASSERT THE SAME
 * WORDS.** The founder's settled decision is that every bad token gets
 * the identical refusal — expired, consumed, superseded, never existed —
 * so the test that matters is not "a bad token is refused" but "a
 * CONSUMED token and a token that never existed are refused
 * indistinguishably". Two visits, because each one spends from
 * `portal.invite_preview` and writes a `platform.system_job` row.
 */

const seed = requireSeed();
// Generated per run and never written anywhere, exactly like the two the
// fixture makes: a credential literal in a committed file is a credential
// in a PUBLIC repository, whatever it unlocks.
const PASSWORD = randomBytes(18).toString("base64url");
// The password the reset test chooses, generated the same way.
const NEW_PASSWORD = randomBytes(18).toString("base64url");

// SERIAL, because each test stands on the one before: the reset needs the
// ACTIVE contact the acceptance produced, and the last test is the undo of
// both. Without this a failure early in the chain would be reported again
// by every later test, as a missing row.
test.describe.configure({ mode: "serial" });

test.describe("portal invitation", () => {
  const email = `e2e-invited-contact-${Date.now()}@test.invalid`;

  test.afterAll(async () => {
    await removeSpecContact(seed.tenantId, email);
  });

  test("a member invites, and the person sets a password and lands on the portal", async ({
    browser,
  }) => {
    const member = await browser.newContext({ storageState: STORAGE_STATE, locale: "en-US" });
    const page = await member.newPage();
    try {
      await page.goto(`/clients/${seed.clientId}/contacts`);

      // Add the person WITH the tick, which is the founder's shortcut
      // for the common case: one form submission both records them and
      // sends the invitation.
      // BY ID, not by label: the row's own inline editors carry the
      // same "Name" and "Email" labels, so a label query matches three
      // controls. `ct-*` is the add form's established id prefix.
      await page.locator("#ct-name").fill("Dagny Ohlsson");
      await page.locator("#ct-email").fill(email);
      // BY ROLE, not by label: a Radix `<Checkbox>` inside a wrapping
      // `<Label>` renders both a `role="checkbox"` button and a hidden
      // bubble input, and a label query can match the pair.
      await page
        .getByRole("checkbox", { name: "Invite this person to the portal" })
        .check();
      await page.getByRole("button", { name: "Add contact" }).click();

      // The row is the assertion, not the toast: `portalStatus` moved to
      // INVITED, which is the column nothing in the product could write
      // before this slice.
      const row = page.locator("li", { hasText: email });
      await expect(row).toContainText("Invited", { timeout: 30_000 * SLOW });
    } finally {
      await page.close();
      await member.close();
    }

    // THE LINK, AS THE CONTACT RECEIVES IT. The raw token exists nowhere
    // else — `contact_invite` stores a sha256 — so reading the message is
    // not a shortcut around the product, it is the only way in.
    const token = readPortalInviteToken(email);
    expect(token, "the invitation link never reached the dev outbox").toBeTruthy();

    // A SEPARATE, EMPTY CONTEXT: the invitee is not signed in as
    // anything, on either plane, and a browser holding a member cookie
    // while accepting is a state no real visitor produces.
    const invitee = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      locale: "en-US",
    });
    const accept = await invitee.newPage();
    try {
      await accept.goto(`/portal/invite/${token}`);
      // The agency's name is what makes the page trustworthy to somebody
      // who has just clicked a link in an email, so it is what the test
      // asserts the page said.
      await expect(accept.getByRole("heading", { level: 1 })).toContainText(seed.tenantName);

      await accept.getByLabel("Choose a password").fill(PASSWORD);
      await accept.getByLabel("Repeat the password").fill(PASSWORD);
      await accept.getByRole("button", { name: "Set password and sign in" }).click();

      // **THE WHOLE POINT.** Not a message, not a row — the contact is
      // on their own portal, under their own session, having held no
      // credential at all ninety seconds ago.
      // A PREDICATE ON THE PATHNAME, not `/\/portal$/`. That regex also
      // matches `/portal/login?next=/portal` — the exact URL the proxy
      // produces when the session cookie did NOT arrive, which is the
      // one failure this assertion exists to catch.
      await accept.waitForURL((url) => url.pathname === "/portal", {
        timeout: 30_000 * SLOW,
      });
      await expect(accept.getByRole("heading", { level: 1 })).toBeVisible();
    } finally {
      await accept.close();
      await invitee.close();
    }

    // THE SAME TOKEN, NOW CONSUMED, AND A TOKEN THAT NEVER EXISTED —
    // asserted to produce the SAME page, which is the founder's decision
    // expressed as a test rather than as a comment.
    const stranger = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      locale: "en-US",
    });
    const spent = await stranger.newPage();
    try {
      await spent.goto(`/portal/invite/${token}`);
      const consumed = await spent.locator("main").innerText();
      await spent.goto("/portal/invite/a-token-that-never-existed");
      const unknown = await spent.locator("main").innerText();
      expect(consumed).toContain("Invitation not available");
      expect(unknown).toBe(consumed);
    } finally {
      await spent.close();
      await stranger.close();
    }
  });

  /**
   * THE WAY BACK IN, driven from the sign-in form's own link. It lives in
   * THIS serial chain because it needs what nothing else in the harness
   * has: an ACTIVE contact whose password the spec knows and whose
   * sessions nobody else depends on. Astrid, the fixture's contact, is
   * neither — her password lives nowhere after global setup, and a reset
   * revokes the one session five later specs share.
   *
   * What it proves that `portal.dbtest.ts` cannot: the link the mail
   * carries is the address a browser can actually open (the proxy's
   * exemption, the route, the instance's `portalResetUrl`, agreeing), and
   * the form's reset-then-sign-in lands a contact on `/portal` under a
   * session of their own.
   */
  test("the contact forgets the password, is mailed a link, and chooses a new one", async ({
    browser,
  }) => {
    const visitor = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      locale: "en-US",
    });
    const page = await visitor.newPage();
    try {
      // The door as a person finds it: the sign-in form's footer link.
      await page.goto("/portal/login");
      await page.getByRole("link", { name: "Choose a new one" }).click();
      await page.waitForURL((url) => url.pathname === "/portal/reset-password");
      await page.getByLabel("Email").fill(email);
      await page.getByRole("button", { name: "Email me a link" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your email");

      // THE LINK, exactly as the contact receives it — origin and all. The
      // instance sends it AFTER the response, so that neither the send nor
      // its failure is on anybody's clock, which means it may land a moment
      // after the confirmation does.
      let link: string | null = null;
      await expect
        .poll(() => (link = readPortalResetLink(email)), { timeout: 30_000 * SLOW })
        .toBeTruthy();

      await page.goto(link!);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Choose a new password");
      // Which account is being changed is the first thing the page says.
      await expect(page.locator("main")).toContainText(email);
      await page.getByLabel("New password").fill(NEW_PASSWORD);
      await page.getByLabel("Repeat the password").fill(NEW_PASSWORD);
      await page.getByRole("button", { name: "Save password and sign in" }).click();
      // A predicate on the pathname, for the reason the acceptance test
      // above gives: `/portal/login?next=/portal` also ends in "/portal".
      await page.waitForURL((url) => url.pathname === "/portal", { timeout: 30_000 * SLOW });
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      // THE SPENT LINK AND ONE THAT NEVER EXISTED render the SAME page.
      await page.goto(link!);
      const spent = await page.locator("main").innerText();
      await page.goto("/portal/reset-password/a-link-that-never-existed");
      const unknown = await page.locator("main").innerText();
      expect(spent).toContain("Link not available");
      expect(unknown).toBe(spent);
    } finally {
      await page.close();
      await visitor.close();
    }

    // AND THE OLD PASSWORD NO LONGER OPENS THE DOOR — the new one is what
    // signed them in above.
    const stranger = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      locale: "en-US",
    });
    const login = await stranger.newPage();
    try {
      await login.goto("/portal/login");
      await login.getByLabel("Email").fill(email);
      await login.getByLabel("Password").fill(PASSWORD);
      await login.getByRole("button", { name: "Sign in" }).click();
      // Scoped to `main`: Next mounts its own `role="alert"` route announcer
      // outside it, and an unscoped query would match both.
      await expect(login.locator("main").getByRole("alert")).toContainText(
        "We could not sign you in",
      );
      expect(new URL(login.url()).pathname).toBe("/portal/login");
    } finally {
      await login.close();
      await stranger.close();
    }
  });

  test("the member ends the access, and only then can the record be deleted", async ({
    browser,
  }) => {
    const member = await browser.newContext({ storageState: STORAGE_STATE, locale: "en-US" });
    const page = await member.newPage();
    try {
      await page.goto(`/clients/${seed.clientId}/contacts`);
      const row = page.locator("li", { hasText: email });
      // The first test left them ACTIVE, which is the only state that
      // offers Pause — and the state from which Delete is refused.
      await expect(row).toContainText("Portal active", { timeout: 30_000 * SLOW });

      await row.getByRole("button", { name: /Actions for/ }).click();
      await page.getByRole("menuitem", { name: "End access" }).click();
      // §5.9: a destructive verb asks IN PLACE, in the row, with no modal.
      await row.getByRole("button", { name: "Yes" }).click();
      await expect(row).toContainText("Ended", { timeout: 30_000 * SLOW });

      // Only now is the record erasable — `deleteContact` admits
      // NO_ACCESS or REVOKED and nothing else, and this person wrote
      // nothing in the portal while they were in it.
      await row.getByRole("button", { name: /Actions for/ }).click();
      await page.getByRole("menuitem", { name: "Remove contact" }).click();
      await row.getByRole("button", { name: "Yes" }).click();
      await expect(page.locator("li", { hasText: email })).toHaveCount(0, {
        timeout: 30_000 * SLOW,
      });
    } finally {
      await page.close();
      await member.close();
    }
  });
});
