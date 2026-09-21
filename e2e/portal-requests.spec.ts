import { expect, test } from "@playwright/test";

import {
  CONTACT_STORAGE_STATE,
  STORAGE_STATE,
  clearPortalRequests,
  readPortalRequests,
  requireSeed,
} from "./fixtures/tenant";

/**
 * PORTAL REQUEST INTAKE, through a real contact session (Phase 3 slice
 * 6a).
 *
 * WHAT THIS PROVES THAT THE DBTEST CANNOT. `portal-writes.dbtest.ts`
 * calls the service with a principal an assertion built; this drives the
 * whole vertical — a contact cookie, `requirePortalContext()`, a server
 * action, `authorizePortal()`, a system transaction — and then reads the
 * ROW back out of the database. The property that can only be measured
 * this way is the **audit actor**: the contact's identity comes from a
 * cookie, so a service test and a browser test could both be green while
 * the real HTTP path attributed the request to SYSTEM and lost the only
 * name on the only thing a client can do.
 *
 * IT ALSO PROVES THE WRITE IS VISIBLE TO ITS AUTHOR, which is not a
 * cosmetic claim: the row is born CLIENT_VISIBLE precisely so the client
 * can read it back through `portal_gate`, and a form whose result the
 * submitter cannot see is a form that ate their words. The assertion is
 * on the rendered portal home rather than on the row.
 *
 * THE FIXTURE IS HANDED BACK IN `afterAll`, NOT IN A `finally`. A
 * Playwright test TIMEOUT abandons the body and every await inside a
 * `finally` fails immediately, so the undo would not run — and this
 * spec sorts BEFORE `view-as.spec.ts`, `visibility.spec.ts`,
 * `visual.spec.ts` and the Swedish width walk, so a leftover request
 * would put a "Requested" group into the portal's stop in the 204-shot
 * sweep whose presence depended on whether the whole suite or one file
 * had been run. That is the same cross-spec contamination the locale
 * restore in `view-as.spec.ts` records, and it takes the same shape of
 * fix.
 *
 * A SEPARATE BROWSER CONTEXT, never a second cookie in the member jar:
 * the planes are separate tables with separate secrets, and a browser
 * holding both is a state no real surface produces.
 */

const seed = requireSeed();

test.use({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });

test.describe("portal request intake", () => {
  test.afterAll(async () => {
    // Scoped to the one contact this harness can sign in as — see the
    // CLI's own note on why that is the key and a timestamp is not.
    await clearPortalRequests(seed.tenantId, seed.contactEmail);
  });

  test("a contact submits a request and reads it back as 'Requested'", async ({ page }) => {
    const title = `New landing page ${Date.now()}`;
    const body = "Please add a page for the spring campaign.";

    await page.goto("/portal");
    // THE LINK IS PART OF WHAT THE CLIENT SEES, and it is shown only
    // when the submit would work — the portal home asks the same
    // question the form's page does. Its presence here is therefore also
    // an assertion that the seeded client has a portal-enabled project
    // and that the contact's profile holds `portal.request.create`.
    const cta = page.getByRole("link", { name: "Ask for something" });
    await expect(cta).toBeVisible({ timeout: 30_000 });
    await cta.click();

    await expect(page.getByRole("heading", { name: "Ask for something" })).toBeVisible();
    await page.getByLabel("What do you need?").fill(title);
    await page.getByLabel("More detail").fill(body);
    await page.getByRole("button", { name: "Send request" }).click();

    // Success navigates back to the portal home, where the new row is in
    // the "Requested" group. Asserting on the ROW rather than on a
    // message is the confirmation that matters: the client sees the
    // thing itself.
    await expect(page).toHaveURL(/\/portal$/, { timeout: 30_000 });
    await expect(page.getByText(title)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Requested", { exact: true })).toBeVisible();

    // ── What the portal never shows, read from the database ──────────
    const rows = await readPortalRequests(seed.tenantId);
    const mine = rows.find((r) => r.title === title);
    expect(mine, "the submitted request is in the database").toBeDefined();
    expect(mine!.visibility).toBe("CLIENT_VISIBLE");
    expect(mine!.stateCategory).toBe("TRIAGE");
    expect(mine!.triageStatus).toBe("PENDING");
    // Trigger-derived from the project, never written by the service.
    expect(mine!.portalEnabled).toBe(true);
    expect(mine!.descriptionText).toBe(body);
    expect(mine!.clientId).toBe(seed.clientId);
    // Nobody at the agency did this.
    expect(mine!.createdByMemberId).toBeNull();
    // THE ONE THAT NEEDS A REAL COOKIE: the row and its audit event both
    // name the contact, and the audit event says CONTACT rather than
    // SYSTEM even though the transaction that wrote it was a system one.
    expect(mine!.reportedByContactId).not.toBeNull();
    expect(mine!.auditActorType).toBe("CONTACT");
    expect(mine!.auditActorId).toBe(mine!.reportedByContactId);
  });

  test("a member's session cannot reach the form at all", async ({ browser }) => {
    // The portal is a plane, not a page. A member holds no contact
    // session, so `requirePortalContext()` sends them to the portal's
    // sign-in surface — which is also what a member following the link
    // from inside View-as gets, and is the reason the FORM is not part of
    // the component View-as renders.
    const member = await browser.newContext({ storageState: STORAGE_STATE, locale: "en-US" });
    try {
      const page = await member.newPage();
      await page.goto("/portal/requests/new");
      // `?next=` and all: the portal's sign-in surface is handed the path
      // that was asked for, which is a fact the visitor already had, and
      // is what will let the invite flow return them to it. Pinned
      // rather than loosened away — the first cut of this assertion
      // anchored on `$` and failed on the parameter, which would have
      // been a real change going unnoticed if it were ever dropped.
      await expect(page).toHaveURL(
        /\/portal\/login\?next=%2Fportal%2Frequests%2Fnew$/,
        { timeout: 30_000 },
      );
      await expect(page.getByLabel("What do you need?")).toHaveCount(0);
    } finally {
      await member.close();
    }
  });
});
