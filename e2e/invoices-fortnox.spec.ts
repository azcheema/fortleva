import { expect, test } from "@playwright/test";

import { STORAGE_STATE, readyFortnoxNightWorkspace, requireSeed, runFortnoxNight } from "./fixtures/tenant";

/**
 * THE NIGHTLY SEND, ON THE BOOKKEEPING PAGE (Phase 4 slice 114b; founder
 * decision C89 (b), (c)), against the harness's FAKE Fortnox.
 *
 * It runs in the fixture owner's SECOND workspace (the first is the invoice
 * method's, whose files the other specs count): `fortnox-night-workspace`
 * resets its books, issues two invoices and connects it to its fake Fortnox
 * company — no authenticator code spent (connecting in a browser is
 * `fortnox.spec.ts`'s). Then:
 *
 *   - Bookkeeping says the company's entries are sent every night, and that
 *     both go tonight; Make file has nothing to offer (no other company's);
 *   - one run of the nightly send (`run-fortnox-night`) → the night's file:
 *     made by the nightly send, both vouchers in Fortnox as F 1–2, their PDFs
 *     still to attach (the harness has no file storage — the dbtest attaches
 *     them), its SIE never offered and refused by the server, its list there.
 *
 * Runs after `invoices-bookkeeping.spec.ts` and before
 * `invoices-year-end.spec.ts`, whose seed resets this workspace again. The
 * sending itself — order, reconciling, refusals, the database's rules — is
 * `fortnox-send.dbtest.ts`'s.
 */

test.describe.serial("the nightly send to Fortnox", () => {
  test.use({ storageState: STORAGE_STATE, locale: "en-US" });

  // The workspace pointer lives on the SESSION ROW every spec shares
  // (`invoices-year-end.spec.ts`' note): back to the first workspace after
  // each test, in a hook, which runs even after a test timeout.
  test.afterEach(async ({ page }) => {
    const seed = requireSeed();
    await page.goto("/dashboard");
    await page.getByRole("button", { name: `Open ${seed.tenantName}`, exact: true }).click();
    await page.waitForURL("**/home");
  });

  test("says what goes tonight, then shows the night's file in Fortnox", async ({ page }) => {
    const seed = requireSeed();
    const ready = await readyFortnoxNightWorkspace(seed.secondTenantId);
    expect(ready).toEqual({ ready: true, invoices: 2 });

    await page.goto("/dashboard");
    await page.getByRole("button", { name: `Open ${seed.secondTenantName}`, exact: true }).click();
    await page.waitForURL("**/home");

    // Before the night: connected, both entries go tonight, nothing for Make file.
    await page.goto("/invoices/bookkeeping");
    const card = page.getByTestId("bookkeeping-fortnox");
    await expect(card).toHaveAttribute("data-status", "ACTIVE");
    // The company is named in the card's header — the section around the testid'd body (the code review's high).
    await expect(page.locator("section", { has: card })).toContainText("E2E Fortnox AB");
    await expect(card).toContainText("Connected — sending every night.");
    await expect(page.getByTestId("bookkeeping-fortnox-tonight")).toHaveText("2 entries go tonight.");
    await expect(page.getByTestId("bookkeeping-next")).toHaveCount(0);
    await expect(page.getByTestId("bookkeeping-nothing")).toHaveCount(0);

    // The night.
    const night = await runFortnoxNight(seed.secondTenantId);
    expect(night).toEqual({ skipped: null, booked: 2, files: 1, stopped: null });

    await page.reload();
    await expect(page.getByTestId("bookkeeping-fortnox-tonight")).toHaveText("Nothing new goes tonight.");
    const file = page.getByTestId("bookkeeping-file").first();
    await expect(file).toHaveAttribute("data-destination", "FORTNOX");
    await expect(file.getByTestId("bookkeeping-file-fortnox")).toHaveText("In Fortnox: F 1–2 · 2 PDFs to attach");
    await expect(file).toContainText("Nightly send");
    // Its vouchers were SENT: no SIE to import as well — and the server refuses one.
    await expect(file.getByTestId("bookkeeping-sie")).toHaveCount(0);
    const list = file.getByTestId("bookkeeping-xlsx");
    await expect(list).toBeVisible();
    const href = await list.getAttribute("href");
    expect(href).toMatch(/^\/invoices\/bookkeeping\/[0-9a-f-]{36}\/xlsx$/);
    const status = await page.evaluate(async (u) => (await fetch(u, { credentials: "same-origin", redirect: "manual" })).status, href!.replace(/xlsx$/, "sie"));
    expect(status).toBe(404);
  });
});
