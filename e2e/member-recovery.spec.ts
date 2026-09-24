import { randomBytes } from "node:crypto";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { sessionCookieName } from "../src/config";

import { SLOW } from "./fixtures/keys";
import {
  countMemberConfirmMails,
  readMemberConfirmLink,
  readMemberResetLink,
  removeSpecUsers,
} from "./fixtures/tenant";

/**
 * MEMBER ACCOUNT RECOVERY, DRIVEN END TO END (OPEN_QUESTIONS C30).
 *
 * `member-recovery.dbtest.ts` calls the instance and asserts on rows. This
 * drives what a person actually does — a form, a mail, a link opened in a
 * browser with no session — because the seams that decide whether any of
 * it works are invisible to every other instrument:
 *
 *   • THE LINKS. `memberResetUrl` and `confirmEmailUrl` build them, the mail
 *     carries them, the proxy must let a cookie-less visitor through, and the
 *     routes must exist. Only a browser following the address the mail
 *     actually holds can say those four agree — so every link here is read
 *     out of `.dev-outbox`, origin and all, never rebuilt from a token.
 *   • THE CONFIRMATION PAGE CONFIRMS NOTHING ON A GET. A mail scanner
 *     fetches every link in a business inbox; if opening confirmed, a
 *     stranger's sign-up at somebody else's address would be confirmed by
 *     nobody. The test opens the link, RELOADS it, and only then finds the
 *     password field and its button still there.
 *   • CONFIRMING TAKES THE ACCOUNT'S PASSWORD, AND THEN SIGNS THE PERSON IN
 *     (C30, after its review — the owner of an address a stranger signed up
 *     first holds the link but not the stranger's password, so neither of
 *     them can confirm such an account alone). A WRONG password confirms
 *     nothing and names the way to a new one; the right one lands on the
 *     signed-in destination with the member cookie set, and the same link
 *     then says "already confirmed".
 *   • AN UNCONFIRMED MEMBER WHO SIGNS IN WITH THE RIGHT PASSWORD IS MAILED A
 *     NEW LINK (`sendOnSignIn`), stays on `/login`, and is told so; a WRONG
 *     password to the same account gets the generic refusal and mails
 *     nothing. The mails are COUNTED, because that is the claim.
 *   • THE FORGOTTEN PASSWORD, from the sign-in page's own footer link to a
 *     new password that signs the person in — then the spent link and a
 *     made-up one render the SAME page, and the old password opens nothing.
 *
 * **IT SIGNS UP PEOPLE OF ITS OWN**, through the real form. The fixture's
 * two recovery people (`memberResetEmail`, `memberConfirmEmail`) carry the
 * links the visual walk photographs, and nothing may ever spend those. The
 * people here belong to no workspace, so no tenant teardown reaches them:
 * `afterAll` removes them by address (`remove-users`, which refuses anyone
 * outside the recovery fixture's prefixes, anyone with a membership and
 * any console principal), and the sweep collects them if a run is killed.
 * In `afterAll`, never a `finally`, for `portal-requests.spec.ts`'s reason:
 * a Playwright TIMEOUT abandons the body, and every await in a `finally`
 * then fails at once.
 *
 * **EVERY SIGN-IN WAITS FOR BETTER AUTH'S LIMITER TO GO QUIET.** The
 * production build this harness runs keeps the library's built-in limiter
 * on, in memory, keyed by client address AND PATH — and the address is the
 * same for every request of the run (or absent, which is one shared
 * bucket), and the KEY IS SHARED BY ALL THREE AUTH INSTANCES, because it is
 * the path inside the instance's base path. `/sign-in/email` allows three
 * requests, and its count resets only after TEN SECONDS WITH NO ALLOWED
 * REQUEST — every allowed one restarts the clock (`decideConsume`,
 * better-auth/dist/api/rate-limiter). `keymap.spec.ts`, just before this
 * file, ends with two employee sign-ins, and `money.spec.ts`, just after,
 * signs its employee in too. So each sign-in below starts an empty window
 * (`spendSignIn`): none can be refused for a neighbour's, and this file
 * leaves at most one in the bucket for the next. The reset's POST sits in
 * the default bucket (100 per 10 s); the one reset REQUEST (3 per 60 s) and
 * the two sign-ups (3 per 10 s) are far inside theirs. The CONFIRMATION is a
 * Server Action on the page, not an `/api/auth` request, so the library's
 * limiter never sees it (nor the sign-in it makes through `auth.api`); it
 * spends the app's own in-process `auth.sign_in` floor instead
 * (`confirmEmailAction`, 10 per 10 min per address) — two presses here. The
 * sign-up and reset-request endpoints also answer no sooner than a second
 * (the route's response floor), which costs time and nothing else.
 *
 * SERIAL, because the forgotten-password test resets the password of the
 * person the first test signed up and confirmed — that is the person who
 * CAN reset: a confirmed member with a password the test knows.
 */

test.describe.configure({ mode: "serial" });

const run = Date.now();
/** A recovery-fixture address (`RECOVERY_USER_PREFIXES` in seed-cli.ts): nothing else may be removed by it. */
const address = (label: string): string => `e2e-recovery-${label}-${run}@test.invalid`;

/** Signs up, confirms, signs in — and is then the one who forgets the password. */
const CONFIRMED = address("confirmed");
/** Signs up and never confirms. */
const UNCONFIRMED = address("unconfirmed");
const NAME = "Rut Andersson";

// Generated per run and never written anywhere, like every credential the
// harness uses: a literal in a committed file is a credential in a PUBLIC
// repository, whatever it unlocks. Twenty-four characters, over the
// member plane's twelve.
const PASSWORD = randomBytes(18).toString("base64url");
const NEW_PASSWORD = randomBytes(18).toString("base64url");
const WRONG_PASSWORD = randomBytes(18).toString("base64url");

/** The member plane's sign-in endpoint — every request that spends from the limiter's sign-in bucket. */
const SIGN_IN_PATH = "/api/auth/sign-in/email";
/** Better Auth's sign-in window is ten seconds of quiet; one more for the clocks' edges. */
const SIGN_IN_QUIET_MS = 11_000;
let lastSignIn = 0;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Press whatever sends a member sign-in, once the limiter's window has
 * gone quiet, and note when it answered — the file's opening note says
 * why. The mark is taken AFTER the answer, so the next wait is measured
 * from later than the server's own clock, never earlier.
 */
async function spendSignIn(page: Page, press: () => Promise<void>): Promise<void> {
  const wait = lastSignIn + SIGN_IN_QUIET_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === SIGN_IN_PATH, {
    timeout: 30_000 * SLOW,
  });
  try {
    await press();
  } catch (error) {
    // The press failed, so no answer is coming: settle the waiter here
    // rather than leave it to reject, unheard, when its timeout runs out.
    void answered.catch(() => undefined);
    throw error;
  }
  await answered;
  lastSignIn = Date.now();
}

/** Sign in through `/login`'s form, on whatever `/login` URL the page is at. */
async function signInThroughForm(page: Page, email: string, password: string): Promise<void> {
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await spendSignIn(page, () => page.locator('form button[type="submit"]').click());
}

/**
 * A browser holding nothing, on either plane — the person following a
 * link out of their inbox. The config's default `storageState` is the
 * fixture owner's member session, which no one in this file is.
 */
function emptyContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ storageState: { cookies: [], origins: [] }, locale: "en-US" });
}

/** Sign up through the real form, and see the page that says a mail is on its way. */
async function signUp(page: Page, email: string): Promise<void> {
  await page.goto("/signup");
  await page.locator("#name").fill(NAME);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your email", {
    timeout: 30_000 * SLOW,
  });
}

test.describe("member account recovery", () => {
  test.beforeAll(() => {
    // As if the spec before this one had just signed in — `keymap.spec.ts`
    // does, twice — so the first sign-in here waits out ITS window too.
    lastSignIn = Date.now();
  });

  test.afterAll(async () => {
    await removeSpecUsers([CONFIRMED, UNCONFIRMED]);
  });

  test("sign up and open the mailed link: opening confirms nothing, a wrong password confirms nothing, the right one confirms AND signs in", async ({
    browser,
  }) => {
    const context = await emptyContext(browser);
    const page = await context.newPage();
    try {
      await signUp(page, CONFIRMED);

      // THE LINK, exactly as the person receives it. It is sent after the
      // response, so it may land a moment after the page said it would.
      let link: string | null = null;
      await expect
        .poll(() => (link = readMemberConfirmLink(CONFIRMED)), { timeout: 30_000 * SLOW })
        .toBeTruthy();

      await page.goto(link!);
      const heading = page.getByRole("heading", { level: 1 });
      const main = page.locator("main");
      await expect(heading).toHaveText("Confirm your email address");
      // Whose address is being confirmed is the first thing the page says.
      await expect(main).toContainText(CONFIRMED);

      // OPENING IS NOT CONFIRMING: a reload still asks for the password,
      // where a confirmed address would say "already confirmed".
      await page.reload();
      await expect(heading).toHaveText("Confirm your email address");
      const field = page.locator("#confirm-password");
      const confirm = page.getByRole("button", { name: "Confirm and sign in" });
      await expect(confirm).toBeVisible();

      // THE WRONG PASSWORD CONFIRMS NOTHING, and says where the way in is —
      // the owner of an address a stranger signed up first lands exactly here.
      await field.fill(`not-${PASSWORD}`);
      await confirm.click();
      await expect(main).toContainText("That is not this account's password", { timeout: 30_000 * SLOW });
      await expect(main.getByRole("link", { name: "Choose a new password" })).toBeVisible();
      await expect(heading).toHaveText("Confirm your email address");

      // THE RIGHT ONE CONFIRMS AND SIGNS IN, in one press. Somebody in no
      // workspace is sent on from `/home` to the workspace picker
      // (`requireTenantContext`), which greets them by the name they signed
      // up with. A PREDICATE ON THE PATHNAME: `/login?next=/dashboard` is
      // what a missing cookie would produce.
      await field.fill(PASSWORD);
      await confirm.click();
      await page.waitForURL((url) => url.pathname === "/dashboard", { timeout: 30_000 * SLOW });
      await expect(heading).toHaveText(`Welcome, ${NAME}`);
      const cookies = (await context.cookies()).map((c) => c.name);
      expect(cookies).toContain(sessionCookieName("member"));

      // The same link again: the address is confirmed already, and says so.
      await page.goto(link!);
      await expect(heading).toHaveText("Address already confirmed");
    } finally {
      await page.close();
      await context.close();
    }
  });

  test("an unconfirmed address: the right password mails a new link and keeps the person on /login; a wrong one mails nothing", async ({
    browser,
  }) => {
    const context = await emptyContext(browser);
    const page = await context.newPage();
    try {
      await signUp(page, UNCONFIRMED);
      // The sign-up's own mail FIRST, so the count below is the sign-in's.
      await expect
        .poll(() => countMemberConfirmMails(UNCONFIRMED), { timeout: 30_000 * SLOW })
        .toBe(1);

      await page.goto("/login");
      await signInThroughForm(page, UNCONFIRMED, PASSWORD);
      const main = page.locator("main");
      // The callout, on screen, naming the address…
      await expect(main).toContainText(`${UNCONFIRMED} is not confirmed yet`);
      // …and the SAME sentence in the live region a screen reader hears,
      // which exists before it fills (`login-form.tsx`).
      await expect(
        page.getByRole("status").filter({ hasText: "is not confirmed yet" }),
      ).toContainText(UNCONFIRMED);
      // Not an error, and not a sign-in: the form stays for the next try.
      await expect(main.getByRole("alert")).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe("/login");

      // THE NEW LINK. Also after the response, so polled.
      await expect
        .poll(() => countMemberConfirmMails(UNCONFIRMED), { timeout: 30_000 * SLOW })
        .toBe(2);
      // How long the mail took from the answer — the yardstick for the
      // silence asserted below.
      const mailLatency = Date.now() - lastSignIn;

      // A WRONG PASSWORD to the same account: the one generic refusal, and
      // the "not confirmed" sentence gone — it is a fact only the right
      // password may learn.
      await signInThroughForm(page, UNCONFIRMED, WRONG_PASSWORD);
      // Scoped to `main`: Next mounts its own `role="alert"` route announcer
      // outside it.
      await expect(main.getByRole("alert")).toContainText(
        "We could not sign you in with that email and password",
      );
      await expect(main).not.toContainText("is not confirmed yet");
      expect(new URL(page.url()).pathname).toBe("/login");

      // AND NOTHING MORE IN THE OUTBOX. A silence can only be asserted over
      // a time, so it is asserted over well past the time the real mail
      // took above — and never under five seconds.
      await sleep(Math.max(5_000, 3 * mailLatency));
      expect(countMemberConfirmMails(UNCONFIRMED)).toBe(2);
    } finally {
      await page.close();
      await context.close();
    }
  });

  test("a forgotten password: the sign-in page's link, a mailed link, a new password that signs in — then the spent link, a made-up one and the old password are all refused", async ({
    browser,
  }) => {
    const context = await emptyContext(browser);
    const page = await context.newPage();
    let link: string | null = null;
    try {
      // The door as a person finds it: the sign-in form's footer link.
      await page.goto("/login");
      await page.getByRole("link", { name: "Choose a new one" }).click();
      await page.waitForURL((url) => url.pathname === "/reset-password");
      await page.getByLabel("Email").fill(CONFIRMED);
      await page.getByRole("button", { name: "Email me a link" }).click();
      const heading = page.getByRole("heading", { level: 1 });
      await expect(heading).toHaveText("Check your email", { timeout: 30_000 * SLOW });

      // THE LINK, origin and all, as the mail carries it.
      await expect
        .poll(() => (link = readMemberResetLink(CONFIRMED)), { timeout: 30_000 * SLOW })
        .toBeTruthy();

      await page.goto(link!);
      await expect(heading).toHaveText("Choose a new password");
      // Which account is being changed is the first thing the page says.
      await expect(page.locator("main")).toContainText(CONFIRMED);
      await page.getByLabel("New password").fill(NEW_PASSWORD);
      await page.getByLabel("Repeat the password").fill(NEW_PASSWORD);
      // The save signs the person in with the new password, from the
      // browser — a sign-in like any other to the limiter.
      await spendSignIn(page, () =>
        page.getByRole("button", { name: "Save password and sign in" }).click(),
      );
      // The same destination a sign-in reaches: `/home`, and on to the
      // workspace picker for somebody in no workspace. A predicate on the
      // pathname, for the reason the first test gives.
      await page.waitForURL((url) => url.pathname === "/dashboard", { timeout: 30_000 * SLOW });
      await expect(heading).toHaveText(`Welcome, ${NAME}`);

      // THE SPENT LINK AND ONE THAT NEVER EXISTED render the SAME page:
      // which of the two a link is, is nobody's business.
      await page.goto(link!);
      await expect(page.locator("main")).toContainText("Link not available");
      const spent = await page.locator("main").innerText();
      await page.goto("/reset-password/a-link-that-never-existed");
      await expect(page.locator("main")).toContainText("Link not available");
      const unknown = await page.locator("main").innerText();
      expect(unknown).toBe(spent);
    } finally {
      await page.close();
      await context.close();
    }

    // AND THE OLD PASSWORD NO LONGER OPENS THE DOOR — in a browser of its
    // own, holding nothing, as anybody who still knew it would be.
    const stranger = await emptyContext(browser);
    const login = await stranger.newPage();
    try {
      await login.goto("/login");
      await signInThroughForm(login, CONFIRMED, PASSWORD);
      await expect(login.locator("main").getByRole("alert")).toContainText(
        "We could not sign you in with that email and password",
      );
      expect(new URL(login.url()).pathname).toBe("/login");
    } finally {
      await login.close();
      await stranger.close();
    }
  });
});
