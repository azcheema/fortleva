import { expect, test } from "@playwright/test";

import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * The item side-peek + work-item attachments (2W-A/B).
 *
 * The UI half always runs: the backlog key opens the peek, the header
 * and properties render, and an INTERNAL task locks the visibility
 * select with the "follows the task" hint.
 *
 * The BYTE half (presign → PUT → commit → download) is gated on the R2
 * env: the harness runs the production build, where the local-disk
 * transport refuses by design — exactly the pinned decision in the
 * work-management plan's provisioning table ("local-disk
 * StorageTransport; integration test skipped without env"). The same
 * three hops run with real bytes in documents.dbtest.ts under the test
 * transport; when the founder provisions R2 for CI, this test arms
 * itself.
 */

let seed!: E2ESeed;
const SLOW = process.env["CI"] ? 3 : 1;
const HAS_R2 = Boolean(process.env["R2_BUCKET"]);
let uploadedName: string | null = null;

test.beforeAll(() => {
  seed = requireSeed();
});

test.afterEach(async ({ page }) => {
  if (!uploadedName) return;
  const name = uploadedName;
  uploadedName = null;
  await page.goto(`/projects/${seed.projectKey}/backlog?item=${seed.projectKey}-1`);
  const peek = page.getByTestId("item-peek");
  await expect(peek).toBeVisible();
  const row = peek.locator('[data-slot="table-row"]', { hasText: name });
  if ((await row.count()) === 0) return;
  await row.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Yes" }).click();
  await expect(peek.locator('[data-slot="table-row"]', { hasText: name })).toHaveCount(0, {
    timeout: 20_000 * SLOW,
  });
});

test("the backlog key opens the item peek; an INTERNAL task locks the upload's visibility to itself", async ({
  page,
}) => {
  await page.goto(`/projects/${seed.projectKey}/backlog`);
  await page.getByRole("link", { name: `${seed.projectKey}-1` }).click();
  const peek = page.getByTestId("item-peek");
  await expect(peek).toBeVisible();

  // Header + read-only properties come from the same list the table
  // renders — one truth, two surfaces.
  await expect(peek.getByRole("heading", { level: 2 }).first()).toContainText("Sätt upp staging-miljö");
  await expect(peek.getByText(`${seed.projectKey}-1`, { exact: true })).toBeVisible();

  // The INTERNAL task locks the select and says why.
  const visibility = peek.locator("#upload-visibility");
  await expect(visibility).toBeDisabled();
  await expect(visibility).toHaveValue("INTERNAL");
  await expect(peek.getByText(`Follows ${seed.projectKey}-1`, { exact: false })).toBeVisible();

  // Closing lands back on the clean list URL.
  await peek.getByRole("button", { name: "Close" }).click();
  await expect(peek).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${seed.projectKey}/backlog$`));
});

test("upload from the peek follows the task's visibility, downloads back, and the paperclip counts it", async ({
  page,
}) => {
  test.skip(
    !HAS_R2,
    "byte round-trip needs the R2 env (the production harness refuses the dev transport by design — provisioning item); the same hops run in documents.dbtest.ts",
  );
  await page.goto(`/projects/${seed.projectKey}/backlog`);
  await page.getByRole("link", { name: `${seed.projectKey}-1` }).click();
  const peek = page.getByTestId("item-peek");
  await expect(peek).toBeVisible();

  const name = `leverans-${Date.now()}.txt`;
  uploadedName = name; // afterEach removes it, pass or fail
  await peek
    .locator("#upload-file")
    .setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from("delivered work\n") });
  await peek.getByRole("button", { name: "Upload" }).click();

  const row = peek.locator('[data-slot="table-row"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 30_000 * SLOW });
  await expect(row).toHaveAttribute("data-visibility", "INTERNAL");

  // The download is a presigned redirect the browser saves.
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 * SLOW }),
    row.getByRole("button", { name: `Download ${name}` }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(name);

  // One list, one truth: the backlog row now wears the paperclip.
  await page.goto(`/projects/${seed.projectKey}/backlog`);
  const backlogRow = page.locator('[data-slot="table-row"]', {
    has: page.getByRole("link", { name: `${seed.projectKey}-1` }),
  });
  await expect(backlogRow.getByTestId("attachment-count")).toContainText("1");
});
