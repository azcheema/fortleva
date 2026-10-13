import { expect, test, type Page } from "@playwright/test";

import {
  STORAGE_STATE,
  disconnectFortnoxWorkspace,
  readyFortnoxNightWorkspace,
  requireSeed,
  runFortnoxNight,
  stopFortnoxWorkspace,
} from "./fixtures/tenant";

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
 * Slice 114c (C89 (c), (e), C90) — the people's side, on from that night:
 *
 *   - Fortnox stops (`fortnox-stop-workspace`: one more invoice, no financial
 *     year in the fake): the card says why, the entry it stopped at waits for
 *     a person, Booked by hand takes it out — and the owner was told in the
 *     inbox, naming the company; the next run is restored, and says so;
 *   - a disconnect (`fortnox-disconnect`) with an entry never sent: the card
 *     offers it as a file — the download starts — and the file's row offers
 *     it again ("Not sent (SIE)"), the same SIE, holding just that entry.
 *
 * Runs after `invoices-bookkeeping.spec.ts` and before
 * `invoices-year-end.spec.ts`, whose seed resets this workspace again. The
 * sending itself — order, reconciling, refusals, the database's rules — is
 * `fortnox-send.dbtest.ts`'s; the people's rules `fortnox-people.dbtest.ts`'s.
 */

/** Into the owner's second workspace — the Fortnox one. */
async function openSecondWorkspace(page: Page): Promise<void> {
  const seed = requireSeed();
  await page.goto("/dashboard");
  await page.getByRole("button", { name: `Open ${seed.secondTenantName}`, exact: true }).click();
  await page.waitForURL("**/home");
}

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

  test("when Fortnox stops: the owner is told, and Booked by hand moves the line on", async ({ page }) => {
    const seed = requireSeed();
    const stop = await stopFortnoxWorkspace(seed.secondTenantId);
    expect(stop.ready).toBe(true);
    expect(await runFortnoxNight(seed.secondTenantId)).toEqual({ skipped: null, booked: 0, files: 1, stopped: "NO_FINANCIAL_YEAR" });

    await openSecondWorkspace(page);
    await page.goto("/invoices/bookkeeping");
    await expect(page.getByTestId("bookkeeping-fortnox")).toHaveAttribute("data-status", "BROKEN");
    await expect(page.getByTestId("bookkeeping-fortnox-broken")).toHaveAttribute("data-kind", "NO_FINANCIAL_YEAR");
    // The entry it stopped at, and only that one, waits for a person.
    const need = page.getByTestId("bookkeeping-need");
    await expect(need).toHaveCount(1);
    await expect(need).toHaveAttribute("data-invoice", stop.invoice);
    await expect(need).toHaveAttribute("data-state", "QUEUED");
    await need.getByRole("button", { name: `Actions for ${stop.invoice}` }).click();
    await page.getByRole("menuitem", { name: "Booked by hand…" }).click();
    // Asked first: Fortleva will never send it.
    await expect(need).toContainText("Fortleva will never send it to Fortnox.");
    await need.getByRole("button", { name: "Yes" }).click();
    await expect(page.getByText("Marked. Fortleva won't send it.")).toBeVisible();
    await expect(page.getByTestId("bookkeeping-needs")).toHaveCount(0);
    // The card went with its last entry: focus to the newest file's link, never <body> (the code review's L1).
    await expect(page.locator("#bookkeeping-newest-list")).toBeFocused();
    await expect(page.getByTestId("bookkeeping-file").first().getByTestId("bookkeeping-file-fortnox")).toHaveText("1 booked by hand");

    // The owner was told — in the inbox, naming the company, opening the Bookkeeping page.
    await page.goto("/inbox");
    const told = page.getByTestId("inbox-row").filter({ hasText: "Sending to Fortnox needs attention" });
    await expect(told).toHaveCount(1);
    await expect(told.getByRole("link", { name: "E2E Fortnox AB" })).toHaveAttribute("href", "/invoices/bookkeeping");

    // The next run: nothing left in the way — restored, and the owner hears it (a note, no mail).
    expect(await runFortnoxNight(seed.secondTenantId)).toEqual({ skipped: null, booked: 0, files: 0, stopped: null });
    await page.reload();
    await expect(page.getByTestId("inbox-row").filter({ hasText: "Sending to Fortnox works again" })).toHaveCount(1);
    await page.goto("/invoices/bookkeeping");
    await expect(page.getByTestId("bookkeeping-fortnox")).toHaveAttribute("data-status", "ACTIVE");
  });

  test("after a disconnect, the entries never sent download as a file — and again from the file's row", async ({ page }) => {
    const seed = requireSeed();
    const stop = await stopFortnoxWorkspace(seed.secondTenantId);
    expect(await runFortnoxNight(seed.secondTenantId)).toEqual({ skipped: null, booked: 0, files: 1, stopped: "NO_FINANCIAL_YEAR" });
    expect(await disconnectFortnoxWorkspace(seed.secondTenantId)).toEqual({ disconnected: 1 });

    await openSecondWorkspace(page);
    await page.goto("/invoices/bookkeeping");
    await expect(page.getByTestId("bookkeeping-fortnox")).toHaveCount(0);
    const unsent = page.getByTestId("bookkeeping-unsent");
    await expect(unsent).toHaveCount(1);
    await expect(unsent).toContainText("1 entry wasn't sent to Fortnox before it was disconnected.");
    // Every entry the connection still owed is a person's now: the one never sent — and the first
    // night's two vouchers whose PDFs never attached (the harness has no file storage).
    const queued = page.locator('[data-testid="bookkeeping-need"][data-state="QUEUED"]');
    await expect(queued).toHaveCount(1);
    await expect(queued).toHaveAttribute("data-invoice", stop.invoice);
    await expect(page.locator('[data-testid="bookkeeping-need"][data-state="BOOKED"]')).toHaveCount(2);

    await unsent.getByTestId("bookkeeping-hand-over").click();
    const dialog = page.getByTestId("bookkeeping-hand-over-dialog");
    await expect(dialog).toContainText("Fortleva will never send them to Fortnox.");
    const download = page.waitForEvent("download");
    await dialog.getByTestId("bookkeeping-hand-over-confirm").click();
    expect((await download).suggestedFilename()).toMatch(/^fortleva-fakt-\d+-ej-skickade\.si$/);
    await expect(page.getByTestId("bookkeeping-unsent")).toHaveCount(0);
    await expect(queued).toHaveCount(0);
    // Its button went with the hand-over: focus is somewhere, never <body> (the code review's L1).
    await expect.poll(() => page.evaluate(() => document.activeElement !== null && document.activeElement !== document.body)).toBe(true);
    await expect(page.locator('[data-testid="bookkeeping-need"][data-state="BOOKED"]')).toHaveCount(2);

    // The file's row says where it stands and downloads it again — the same SIE, just that entry
    // (an in-page fetch: Playwright's own requests drop the Secure cookie on an http host).
    const row = page.getByTestId("bookkeeping-file").first();
    await expect(row.getByTestId("bookkeeping-file-fortnox")).toHaveText("1 downloaded as a file");
    const href = await row.getByTestId("bookkeeping-unsent-sie").getAttribute("href");
    expect(href).toMatch(/^\/invoices\/bookkeeping\/[0-9a-f-]{36}\/unsent$/);
    const again = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: "same-origin" });
      return { status: r.status, text: new TextDecoder("windows-1252").decode(await r.arrayBuffer()) };
    }, href!);
    expect(again.status).toBe(200);
    expect(again.text.match(/#VER /g)).toHaveLength(1);
  });
});
