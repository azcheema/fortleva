import { expect, test } from "@playwright/test";

import { CONTACT_STORAGE_STATE, requireSeed } from "./fixtures/tenant";

/**
 * THE PORTAL'S FILES AND COMPANY PAGES, through a real contact session
 * (Phase 3, the portal files-and-services slice; UI.md §4).
 *
 * WHAT THIS PROVES THAT THE DBTESTS CANNOT. `src/documents/portal.dbtest.ts`
 * and `src/services/portal.dbtest.ts` call the projections with a
 * principal an assertion built and read their JSON. This drives the
 * whole vertical — a contact cookie, `requirePortalContext()`, the reads
 * under the contact principal, the file layer's broker — and reads the
 * RENDER: that the deliverable the seed shared sits first with its
 * second version, that the company's own file and the project's file
 * are each under the right card, that the agreement the seed shared is
 * on the company page with its fee, and that the three negative
 * controls the seed planted — an INTERNAL file, an INTERNAL
 * deliverable, and the staff-only notes on the shared agreement — are
 * on no part of either page.
 *
 * THE DOWNLOAD BYTES ARE GATED ON THE R2 ENV, as in `attachments.spec.ts`:
 * the harness runs the production build, where the local-disk transport
 * refuses by design, so the presign cannot be minted here. The same
 * hops run with real bytes in `src/documents/portal.dbtest.ts`. What CAN
 * be driven without storage is the REFUSAL: a download the contact may
 * not have is refused before any storage is touched, and the page must
 * say so in place, with no reason.
 */

const seed = requireSeed();
const HAS_R2 = Boolean(process.env["R2_BUCKET"]);

test.use({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });

test.describe("portal files", () => {
  test("lists the shared files under their cards — and nothing internal", async ({ page }) => {
    await page.goto("/portal/files");
    const surface = page.locator("[data-portal-surface]");
    await expect(surface).toBeVisible({ timeout: 30_000 });

    // The nav marks this page, and offers the other two.
    const nav = surface.locator('[data-slot="portal-nav"]');
    await expect(nav.getByRole("link", { name: "Files" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Your company" })).toBeVisible();

    // The company's own file, under its card.
    const company = page.locator('[data-slot="section-card"]', { hasText: "Shared with your company" });
    await expect(company.locator('[data-slot="portal-file"]', { hasText: seed.clientVisibleDocName })).toBeVisible();

    // The project's card: the deliverable first, at version 2, and the
    // project's ordinary file after it.
    const project = page.locator('[data-slot="section-card"]', { hasText: "E2E Project" });
    const files = project.locator('[data-slot="portal-file"]');
    await expect(files.first()).toHaveAttribute("data-kind", "DELIVERABLE");
    await expect(files.first()).toContainText(seed.deliverableDocName);
    await expect(files.first()).toContainText("Version 2");
    await expect(project.locator('[data-slot="portal-file-group"][data-kind="DELIVERABLE"]')).toBeVisible();
    await expect(project.locator('[data-slot="portal-file-group"][data-kind="GENERAL"]')).toContainText(
      `e2e-projekt-${seed.tenantSlug.slice("e2e-".length)}.txt`,
    );
    // Every row offers the download; the seeded deliverable, asked about
    // at version 2, also carries the sign-off control (the sign-off
    // slice — `portal-signoff.spec.ts` drives it), and the ordinary file
    // does not.
    await expect(files.first().getByRole("button", { name: `Download ${seed.deliverableDocName}` })).toBeVisible();
    await expect(files.first().locator('[data-slot="portal-signoff"]')).toHaveAttribute("data-status", "PENDING");
    await expect(files.first().getByTestId("portal-signoff-approve")).toBeVisible();
    await expect(
      project.locator('[data-slot="portal-file-group"][data-kind="GENERAL"] [data-slot="portal-signoff"]'),
    ).toHaveCount(0);

    // ── THE NEGATIVE CONTROLS, on the whole surface ──────────────────
    await expect(surface).not.toContainText(seed.internalDocName);
    await expect(surface).not.toContainText(seed.internalDeliverableDocName);
  });

  test("a refused download lands back on the page with a banner and no reason", async ({ page }) => {
    await page.goto("/portal/files");
    await expect(page.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 });
    // Point the first row's form at a file that is not this client's —
    // an id the browser chooses is exactly what the action must refuse.
    // No storage is touched on the way to a NOT_FOUND, so this runs
    // without R2.
    const form = page.locator('[data-slot="portal-file"]').first().locator("form");
    await form.locator('input[name="documentId"]').evaluate((el) => {
      (el as HTMLInputElement).value = "00000000-0000-7000-8000-000000000000";
    });
    await form.getByRole("button").click();
    await expect(page).toHaveURL(/\/portal\/files\?error=download$/, { timeout: 30_000 });
    const banner = page.getByTestId("portal-file-error");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("could not be downloaded");
    // The word is the plane's one refusal — it names no reason.
    await expect(banner).not.toContainText(/not found|forbidden|permission/i);
  });

  test("the download is a real attachment", async ({ page }) => {
    test.skip(
      !HAS_R2,
      "the byte round-trip needs the R2 env (the production harness refuses the dev transport by design); the same hops run in src/documents/portal.dbtest.ts",
    );
    await page.goto("/portal/files");
    await expect(page.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 });
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: `Download ${seed.deliverableDocName}` }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(seed.deliverableDocName);
  });
});

test.describe("portal company", () => {
  test("shows the company's own record and the shared agreement — and never the staff notes", async ({ page }) => {
    await page.goto("/portal/company");
    const surface = page.locator("[data-portal-surface]");
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await expect(surface.locator('[data-slot="portal-nav"]').getByRole("link", { name: "Your company" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    // The record: the name as the h1, the org number as the seed set it.
    await expect(page.locator('[data-slot="page-header"] h1')).toContainText(seed.clientName);
    const record = page.locator('[data-slot="portal-company"]');
    await expect(record).toContainText("556677-8899");
    await expect(record).toContainText("Stockholm");

    // The agreement the seed shared — Förvaltning, recurring monthly,
    // 7 500 SEK ex. VAT — and not "Migrering", which is INTERNAL and on
    // a project whose portal is off.
    const agreements = page.locator('[data-slot="portal-agreement"]');
    await expect(agreements).toHaveCount(1);
    await expect(agreements.first()).toContainText(seed.serviceName);
    await expect(agreements.first()).toContainText("Recurring");
    await expect(agreements.first()).toContainText("monthly");
    await expect(agreements.first()).toContainText("ex. VAT");
    await expect(agreements.first().locator('[data-slot="status-badge"]')).toHaveAttribute("data-value", "ACTIVE");
    await expect(surface).not.toContainText("Migrering");

    // ── THE NEGATIVE CONTROL: the staff-only notes, on the whole
    // surface's markup rather than its visible text, because an
    // attribute or a hidden node would be a leak too. ────────────────
    const html = await surface.evaluate((el) => el.innerHTML);
    expect(html).not.toContain(seed.serviceNotesSentinel);
  });
});
