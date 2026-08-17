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

    await triggerIn(row).click();
    await selectIn(row).selectOption("INTERNAL");

    const toast = page.locator("[data-sonner-toast]");
    await expect(toast).toBeVisible();
    await expect(toast).not.toBeEmpty();
    // and the cell falls back to the truth, not to a guess
    await expectShows(rowFor(page, seed.clientVisibleDocName), "CLIENT_VISIBLE");
    expect(await documentVisibility(seed.clientVisibleDocId)).toBe("CLIENT_VISIBLE");
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
});
