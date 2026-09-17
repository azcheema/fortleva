import { expect, test } from "@playwright/test";

import { requireSeed, resetNotifications, type E2ESeed } from "./fixtures/tenant";

/**
 * `/home` — "My Work" (UI.md rule 8) in a browser: the queue and the
 * inbox card. (The time strip is `time.spec.ts`'s.)
 *
 * The fixture's owner holds three open tasks, dated by the seed three
 * days either side of today so each lands in its own group whatever the
 * hour: "Sätt upp staging-miljö" overdue, "Designgranskning med kunden"
 * within the next seven days, "Skriv kravspecifikation" undated. The
 * seed's other two tasks are the negative space — one DONE, one
 * unassigned — and must never appear. Other specs may add tasks of their
 * own, so every assertion names its row rather than counting the queue.
 *
 * What the queue must NOT show on scope and permission grounds is the
 * dbtest's (`my-work.dbtest.ts`): the harness's employee sign-in is the
 * suite's recorded flake, and those properties live in the read.
 */

let seed!: E2ESeed;

// A navigation to a task's peek compiles and renders the backlog; on CI
// (US runner, EU database) the same waits get three times the leash.
const SLOW = process.env["CI"] ? 3 : 1;

test.beforeAll(() => {
  seed = requireSeed();
});

test.beforeEach(async () => {
  // The inbox card is drawn only while something is unread, and a spec
  // before this one may have read the fixture's notification.
  await resetNotifications(seed.tenantId);
});

test.describe("home (owner)", () => {
  test("the queue groups the owner's open tasks by due date, and a row opens the task's peek", async ({ page }) => {
    await page.goto("/home");
    const queue = page.getByTestId("home-queue");
    await expect(queue).toBeVisible();

    const group = (name: string) => queue.locator(`[data-testid="home-queue-group"][data-group="${name}"]`);
    const row = (title: string) => queue.getByTestId("home-queue-row").filter({ hasText: title });

    // Each group's heading says what it is — the words carry "overdue",
    // never the colour alone (UI.md §9) — with its count.
    await expect(group("overdue").getByRole("heading", { level: 3 })).toHaveText(/^Overdue\s*\d+$/);
    await expect(group("overdue").getByTestId("home-queue-row").filter({ hasText: "Sätt upp staging-miljö" })).toHaveCount(1);
    await expect(group("soon").getByTestId("home-queue-row").filter({ hasText: "Designgranskning med kunden" })).toHaveCount(1);
    await expect(group("later").getByTestId("home-queue-row").filter({ hasText: "Skriv kravspecifikation" })).toHaveCount(1);

    // Done and unassigned work is not the member's queue.
    await expect(row("Migrera DNS till ny leverantör")).toHaveCount(0);
    await expect(row("Tillgänglighetsgranskning")).toHaveCount(0);

    // The overdue row says when, as a machine-readable day; the undated
    // row has no date to say; the priority is spoken, not only drawn.
    const overdue = row("Sätt upp staging-miljö");
    await expect(overdue.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}$/);
    await expect(row("Skriv kravspecifikation").locator("time")).toHaveCount(0);
    await expect(overdue).toContainText("Priority: High");
    await expect(overdue).toContainText(`${seed.projectKey}-1`);

    // A row is ONE link, to the task's peek over its project's backlog —
    // the address the inbox links a task by.
    const link = overdue.getByRole("link");
    await expect(link).toHaveAttribute("href", `/projects/${seed.projectKey}/backlog?item=${seed.projectKey}-1`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${seed.projectKey}/backlog\\?item=${seed.projectKey}-1$`));
    await expect(page.getByTestId("item-peek")).toBeVisible({ timeout: 20_000 * SLOW });
  });

  test("the inbox card shows the unread notification with its subject, and leads to the inbox", async ({ page }) => {
    await page.goto("/home");
    const card = page.getByTestId("home-inbox");
    await expect(card).toBeVisible();

    const assigned = card.getByTestId("home-inbox-row").filter({ hasText: "A task was assigned to you" });
    await expect(assigned.first()).toBeVisible();
    // The subject resolved through the inbox's own scope-filtered read.
    const subject = assigned.getByRole("link", { name: "Designgranskning med kunden" });
    await expect(subject).toHaveAttribute("href", new RegExp(`/projects/${seed.projectKey}/backlog\\?item=${seed.projectKey}-\\d+$`));
    await expect(page.getByText(/\d+ unread notifications?/)).toBeVisible();

    await page.getByRole("link", { name: "Open inbox", exact: true }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByTestId("inbox-row").first()).toBeVisible({ timeout: 20_000 * SLOW });
  });
});
