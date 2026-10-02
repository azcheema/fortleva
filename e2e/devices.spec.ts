import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * "YOUR DEVICES" ON `/account` (slice 84, founder decision C50), in a
 * browser: a device signed out from another really is signed out.
 *
 * As the fixture EMPLOYEE, never the owner: the owner's session is the
 * storage state every other spec shares, and "Sign out everywhere else"
 * from it would end them all. The second device is told apart by its user
 * agent — the list names a device by what its browser says it is.
 *
 * The DB suite (`src/auth/account-security.dbtest.ts`) proves the rows;
 * this proves the screen reaches them, that the question is asked before
 * anything happens (`InlineConfirm`), and that the signed-out device lands
 * on the sign-in page.
 *
 * RE-RUNNABLE: a failed first attempt leaves its devices signed in, and
 * the employee has sessions from other specs too, so the test first signs
 * every other device out from the one it is holding. And it rides out
 * Better Auth's own sign-in limiter (on under `next start`: three sign-ins
 * per ten seconds, one bucket for the whole run on localhost) by retrying
 * a refused sign-in rather than asserting on the first.
 */

let seed!: E2ESeed;

test.beforeAll(() => {
  seed = requireSeed();
});

const FIREFOX_ON_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";

async function signedIn(browser: Browser, userAgent?: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    storageState: { cookies: [], origins: [] },
    serviceWorkers: "block",
    ...(userAgent ? { userAgent } : {}),
  });
  const page = await context.newPage();
  await expect(async () => {
    // A sign-in that SUCCEEDED but was slow to land on /home must not be
    // repeated: `/login` does not redirect a signed-in visitor, so a second
    // pass would mint a second session for this context (the fix-pass
    // review's low) — an extra device row after the purge below.
    if (/\/home(?:$|[?#])/.test(page.url())) return;
    await page.goto("/login");
    await page.locator("#email").fill(seed.employeeEmail);
    await page.locator("#password").fill(seed.employeePassword);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("**/home", { timeout: 15_000 });
  }).toPass({ timeout: 60_000, intervals: [2_000, 4_000, 6_000] });
  return { context, page };
}

test("a device signed out from \"Your devices\" is signed out, and \"everywhere else\" leaves only this one", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const here = await signedIn(browser);
  const opened: BrowserContext[] = [here.context];
  try {
    const devices = here.page.getByTestId("device");
    const signOutOthers = here.page.getByRole("button", { name: "Sign out everywhere else" });

    // Start from this device alone, whatever a retry or another spec left.
    await here.page.goto("/account");
    await expect(devices.first()).toBeVisible();
    if ((await devices.count()) > 1) {
      await signOutOthers.click();
      await here.page.getByRole("button", { name: "Yes" }).click();
      await expect(devices).toHaveCount(1);
    }

    const laptop = await signedIn(browser, FIREFOX_ON_LINUX);
    opened.push(laptop.context);
    const spare = await signedIn(browser);
    opened.push(spare.context);

    await here.page.reload();
    await expect(devices).toHaveCount(3);
    await expect(devices.and(here.page.locator("[data-current]"))).toHaveCount(1);

    // One device, by name: the question first, nothing until "Yes".
    const row = devices.filter({ hasText: "Firefox on Linux" });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Sign out" }).click();
    await expect(row.getByText("Sign out Firefox on Linux?")).toBeVisible();
    await row.getByRole("button", { name: "Yes" }).click();
    await expect(here.page.locator("[data-sonner-toast]", { hasText: "Firefox on Linux was signed out." })).toBeVisible();
    await expect(devices).toHaveCount(2);

    await laptop.page.goto("/home");
    await laptop.page.waitForURL("**/login**", { timeout: 30_000 });

    // Everywhere else: the spare goes, this device stays.
    await signOutOthers.click();
    await here.page.getByRole("button", { name: "Yes" }).click();
    // The plural's own words: the single device's toast may still be up.
    await expect(here.page.locator("[data-sonner-toast]", { hasText: /\bdevices? signed out\./ })).toBeVisible();
    await expect(devices).toHaveCount(1);
    await expect(devices.first()).toHaveAttribute("data-current", "true");

    await spare.page.goto("/home");
    await spare.page.waitForURL("**/login**", { timeout: 30_000 });
    await here.page.goto("/home");
    await expect(here.page).toHaveURL(/\/home/);
  } finally {
    await Promise.all(opened.map((context) => context.close()));
  }
});
