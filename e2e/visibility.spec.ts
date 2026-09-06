import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
  type TestInfo,
} from "@playwright/test";

import {
  documentVisibility,
  requireSeed,
  setDocumentVisibility,
  type E2ESeed,
} from "./fixtures/tenant";

/**
 * BUG 1 — "I changed the visibility of a file to Private to team but it
 * goes back to Client can see."
 *
 * Visibility is the safety-critical lever of the whole product: a
 * control showing anything other than what the database holds is a data
 * leak waiting to be believed. So the spec pins all four halves — the
 * control after the round trip, the control after a reload, the ROW the
 * server rendered, and the stored value itself — in both directions, on
 * both surfaces that render the table.
 *
 * What the reproduction found: the action always succeeded and the row
 * always updated; React resets a <form> after its action has run, which
 * restored the native <select> to the value the server had rendered.
 * The control lied about the database — in both directions.
 *
 * The control is now READ-FIRST (founder mandate 1): at rest the cell is
 * the <VisibilityBadge> itself and the <select> does not exist, so every
 * assertion about "what the screen says" reads the badge and the row's
 * server-rendered data-visibility, and every change opens the picker
 * first. That is a stricter test than before, not a looser one: the
 * resting statement is now the same object a read-only row renders.
 */

type Visibility = "INTERNAL" | "CLIENT_VISIBLE";

let seed!: E2ESeed;

test.beforeAll(() => {
  seed = requireSeed();
});

// Each test starts from the fixture exactly as provisioned, so a
// failure never cascades into the next test's premise.
test.beforeEach(async () => {
  await setDocumentVisibility(seed.clientVisibleDocId, "CLIENT_VISIBLE");
  await setDocumentVisibility(seed.internalDocId, "INTERNAL");
});

type Trace = {
  readonly consoleErrors: string[];
  readonly navigations: string[];
  readonly actionPosts: { url: string; status: number }[];
};

const isActionPost = (request: Request): boolean =>
  request.method() === "POST" && Boolean(request.headers()["next-action"]);

/** Watch what the page actually does — an error redirect must not hide. */
function watch(page: Page): Trace {
  const trace: Trace = { consoleErrors: [], navigations: [], actionPosts: [] };
  page.on("console", (m) => {
    if (m.type() === "error") trace.consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => trace.consoleErrors.push(e.message));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) trace.navigations.push(frame.url());
  });
  page.on("response", (res) => {
    if (isActionPost(res.request())) {
      trace.actionPosts.push({ url: res.url(), status: res.status() });
    }
  });
  return trace;
}

const attach = (info: TestInfo, trace: Trace) =>
  info.attach("trace.json", {
    body: JSON.stringify(trace, null, 2),
    contentType: "application/json",
  });

const rowFor = (page: Page, name: string): Locator =>
  page.locator("tbody tr").filter({ hasText: name });

const selectIn = (row: Locator): Locator => row.locator('select[name="visibility"]');
const triggerIn = (row: Locator): Locator => row.locator("[data-slot=inline-edit]");
const badgeIn = (row: Locator): Locator => row.locator("[data-slot=visibility-badge]");

/**
 * What the CELL says, at rest — the chip, not a control. This is the
 * statement a member actually reads, and it is now byte-identical to the
 * one a read-only row renders.
 */
async function expectShows(row: Locator, value: Visibility): Promise<void> {
  await expect(badgeIn(row)).toHaveAttribute("data-visibility", value);
  await expect(selectIn(row)).toHaveCount(0);
}

/**
 * Change the visibility and wait for the server to have answered. The
 * row's data-visibility comes from the server-rendered page, so it — not
 * the control — is the proof that the change actually landed.
 */
async function change(page: Page, row: Locator, next: Visibility): Promise<void> {
  const answered = page.waitForResponse((res) => isActionPost(res.request()));
  await triggerIn(row).click();
  await selectIn(row).selectOption(next);
  await answered;
  await expect(row).toHaveAttribute("data-visibility", next);
}

test.describe("document visibility", () => {
  test("switching a client-visible file to Private to team sticks", async ({ page }, info) => {
    const trace = watch(page);
    await page.goto(`/clients/${seed.clientId}/files`);

    const row = rowFor(page, seed.clientVisibleDocName);
    await expectShows(row, "CLIENT_VISIBLE");

    await change(page, row, "INTERNAL");
    await attach(info, trace);

    // (a) what the cell says once it settles — the reported symptom
    await expectShows(rowFor(page, seed.clientVisibleDocName), "INTERNAL");
    // an action failure must never be silent: no error bounce, no crash
    expect(trace.navigations.filter((u) => u.includes("error="))).toEqual([]);
    expect(trace.consoleErrors).toEqual([]);

    // (b) after a full reload
    await page.reload();
    await expectShows(rowFor(page, seed.clientVisibleDocName), "INTERNAL");

    // (c) the stored row
    expect(await documentVisibility(seed.clientVisibleDocId)).toBe("INTERNAL");

    // (d) and back again — the reverse direction persists too
    await change(page, rowFor(page, seed.clientVisibleDocName), "CLIENT_VISIBLE");
    await expectShows(rowFor(page, seed.clientVisibleDocName), "CLIENT_VISIBLE");
    await page.reload();
    await expectShows(rowFor(page, seed.clientVisibleDocName), "CLIENT_VISIBLE");
    expect(await documentVisibility(seed.clientVisibleDocId)).toBe("CLIENT_VISIBLE");
  });

  test("the same control on /files behaves identically", async ({ page }, info) => {
    const trace = watch(page);
    await page.goto("/files");

    const row = rowFor(page, seed.internalDocName);
    await expectShows(row, "INTERNAL");

    await change(page, row, "CLIENT_VISIBLE");
    await attach(info, trace);
    await expectShows(rowFor(page, seed.internalDocName), "CLIENT_VISIBLE");
    expect(await documentVisibility(seed.internalDocId)).toBe("CLIENT_VISIBLE");

    // and back, so the fixture stays as the other specs found it
    await change(page, rowFor(page, seed.internalDocName), "INTERNAL");
    await expectShows(rowFor(page, seed.internalDocName), "INTERNAL");
    expect(await documentVisibility(seed.internalDocId)).toBe("INTERNAL");
    expect(trace.consoleErrors).toEqual([]);
  });

  test("a failed change says so instead of looking like a silent revert", async ({ page }) => {
    await page.goto(`/clients/${seed.clientId}/files`);
    const row = rowFor(page, seed.clientVisibleDocName);
    await expectShows(row, "CLIENT_VISIBLE");

    // Kill the server action mid-flight: the UI must explain itself.
    await page.route("**/*", async (route) => {
      if (isActionPost(route.request())) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    // THE SAFETY PROPERTY IS ASSERTED FIRST. If the toast assertion
    // below times out, these two never run, and the failure report then
    // says nothing about the thing that actually matters — whether the
    // cell and the database still agree. They do not depend on the
    // toast, so they go above it (PLAN §0's prescription for this test).
    await expectShows(rowFor(page, seed.clientVisibleDocName), "CLIENT_VISIBLE");
    expect(await documentVisibility(seed.clientVisibleDocId)).toBe("CLIENT_VISIBLE");

    // RECORD the toast rather than poll for it, and record WHEN.
    //
    // This test has flaked in CI on 2026-08-21, 2026-09-02 and
    // 2026-09-06 (run 34027077878), always on the toast. The old
    // assertion polled a locator, which can only see the toast while it
    // is on screen — sonner dismisses after 4.2 s (TOAST_LIFETIME 4000
    // + TIME_BEFORE_UNMOUNT 200; the Toaster passes no `duration`).
    //
    // THE ROOT CAUSE IS NOT ESTABLISHED, and this recorder exists to
    // establish it rather than to paper over it. A dismissal race is a
    // WEAK explanation: Playwright's retry backoff settles at 500 ms, so
    // a 30 s expect budget samples ~60 times, and every one of them
    // would have to miss a window that opened once. The likelier reading
    // is that the toast sometimes does not arrive at all — which on THIS
    // control would be a product defect, because the component's own
    // header says it must never revert quietly.
    //
    // So the sweep runs in the page, at 25 ms, appending to an array
    // that is never cleared: monotonic, immune to dismissal, and — via
    // the timestamp — able to tell "late" from "never" the next time it
    // fails. It cannot miss a toast that lives 4 s; if any call site
    // ever passes a shorter `duration`, revisit this interval.
    await page.evaluate(() => {
      const w = window as unknown as {
        __toasts?: { at: number; text: string; type: string | null }[];
        __sweeps?: number;
        __sweeper?: number;
      };
      w.__toasts = [];
      w.__sweeps = 0;
      w.__sweeper = window.setInterval(() => {
        w.__sweeps = (w.__sweeps ?? 0) + 1;
        for (const el of document.querySelectorAll("[data-sonner-toast]")) {
          const text = (el.textContent ?? "").trim();
          if (!w.__toasts!.some((t) => t.text === text)) {
            w.__toasts!.push({
              at: Math.round(performance.now()),
              text,
              type: el.getAttribute("data-type"),
            });
          }
        }
      }, 25);
    });

    await triggerIn(row).click();
    // The clock starts HERE, not at install: `started` used to be taken
    // before these two calls, so the reported latency folded in two
    // Playwright round trips and over-stated it. What is being judged is
    // action -> toast.
    const started = await page.evaluate(() => Math.round(performance.now()));
    await selectIn(row).selectOption("INTERNAL");

    // `?? []` and `?? -1`: a navigation would leave a fresh document with
    // no recorder, and a throwing poll callback ABORTS the poll rather
    // than retrying — the report would then be a raw TypeError instead of
    // the diagnosis below.
    const seen = () =>
      page.evaluate(
        () =>
          (window as unknown as { __toasts?: { at: number; text: string; type: string | null }[] })
            .__toasts ?? [],
      );
    const sweeps = () =>
      page.evaluate(() => (window as unknown as { __sweeps?: number }).__sweeps ?? -1);

    // The exact string the failure path produces (files.errors.visibilityFailed).
    // Asserting the TEXT is what makes this test its own name: a future
    // change that reported success on a failed flip would otherwise keep
    // it green while the product told the user the opposite of the truth.
    const expected = "Could not change visibility";
    await expect
      .poll(async () => (await seen()).some((t) => t.text.includes(expected)))
      .toBe(true);

    const toasts = await seen();
    // Timing and type, logged on every run: a green run that reports the
    // toast arriving at 9 s is a finding, not a pass to shrug at.
    console.log(
      `[toast] ${toasts.length} recorded after ${(await sweeps()) * 25} ms of sweeping; ` +
        toasts.map((t) => `${t.at - started}ms type=${t.type ?? "-"}`).join(", "),
    );
    expect(toasts.some((t) => t.type === "error")).toBe(true);
    await page.evaluate(() => {
      const w = window as unknown as { __sweeper?: number };
      if (w.__sweeper !== undefined) window.clearInterval(w.__sweeper);
    });
  });

  /**
   * FOUNDER MANDATE 2 — destroying a stored file used to be one click on
   * the loudest object in the row. It must now take two interactions,
   * and the first must not touch the server.
   */
  test("deleting a document asks first, and asking posts nothing", async ({ page }) => {
    const trace = watch(page);
    await page.goto("/files");

    const row = rowFor(page, seed.internalDocName);
    // No solid destructive button survives in a table row.
    await expect(row.locator('button[data-variant="destructive"]')).toHaveCount(0);

    await row.getByRole("button", { name: /./ }).last().click();
    const before = trace.actionPosts.length;
    await page.getByRole("menuitem").filter({ hasText: /./ }).last().click();

    // The question is asked in the row, and nothing has happened yet.
    await expect(row.getByRole("group")).toBeVisible();
    expect(trace.actionPosts.length).toBe(before);
    expect(await documentVisibility(seed.internalDocId)).not.toBeNull();

    // Escaping the question leaves the document exactly where it was.
    await page.keyboard.press("Escape");
    await expect(rowFor(page, seed.internalDocName)).toBeVisible();
    expect(await documentVisibility(seed.internalDocId)).not.toBeNull();
  });

  /**
   * THE CUE MUST SURVIVE THE LAST ROW — the guard `UI.md` §10.4 has
   * always claimed and, until this test, did not have.
   *
   * The standing trap: `[&_tr:last-child]:border-0` on a table body
   * zeroes ALL FOUR border widths, including the `border-left` that
   * `visibilityRowCue()` paints — so the last client-visible row of
   * every table in the product silently lost its safety marking while
   * the legend beside it asserted it in words. `TableBody` therefore
   * carries `border-b-0`, and nothing had been checking.
   *
   * Nothing else can catch it. The craft audit's `rowPitch` measures row
   * HEIGHT, which a missing left border does not change, so a regression
   * here is invisible to all 168 stops. This is the only tripwire.
   *
   * It asserts the reserved width on EVERY row rather than only the
   * client-visible one, because `visibilityRowCue` deliberately reserves
   * the same 2px on an INTERNAL row (in `transparent`) so rows do not
   * jump — and it is exactly that reservation that `border-0` destroys.
   */
  test("the client-visible row cue survives, including on the last row of a table", async ({ page }) => {
    await page.goto("/files");
    const rows = page.locator("tbody tr");
    await expect(rows.first()).toBeVisible();

    const widths = await rows.evaluateAll((els) =>
      els.map((el) => window.getComputedStyle(el).borderLeftWidth),
    );
    expect(widths.length).toBeGreaterThan(1);
    // Including the last — the row the trap ate.
    expect(new Set(widths)).toEqual(new Set(["2px"]));

    // And the cue is a real colour on a client-visible row, not merely a
    // reserved gap: the two states must differ on this channel.
    const clientRow = rowFor(page, seed.clientVisibleDocName);
    await expect(clientRow).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");
    const cue = await clientRow.evaluate((el) => window.getComputedStyle(el).borderLeftColor);
    const internalCue = await rowFor(page, seed.internalDocName).evaluate(
      (el) => window.getComputedStyle(el).borderLeftColor,
    );
    expect(cue).not.toBe(internalCue);
    // `transparent` computes to an alpha-0 colour; the cue must not be one.
    expect(cue).not.toMatch(/,\s*0\)$/);
  });
});
