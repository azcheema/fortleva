import { expect, test } from "@playwright/test";

import { readReplyAddressMailLink, requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * The 2T settings surfaces in a browser (PLAN.md 2T screens; UI.md §3.1
 * "Settings", rule 12, rule 14): /settings/rates lists the seeded bill
 * cards, adds a member card with the pinned rate-change wording in the
 * toast and closes it again; the COST half is offered only behind a
 * two-factor confirmation (the owner has no factor enrolled, so the
 * section shows the confirm link and no amounts); /settings/time shows
 * the acknowledgment table and manages work types (add, rename inline,
 * archive, restore); the client's Agreements tab shows the seeded
 * agreement with its rate and the agreement-rate cards. The employee
 * (no rate:view_bill, no settings:view) reaches neither settings page.
 * Everything happens inside the throwaway e2e tenant and is removed by
 * teardown.
 */

let seed!: E2ESeed;
const SLOW = process.env["CI"] ? 3 : 1;

test.beforeAll(() => {
  seed = requireSeed();
});

test.describe("rates (owner)", () => {
  test("lists the seeded bill cards; adds and closes a member card with the pinned wording; cost is behind two-factor", async ({ page }) => {
    await page.goto("/settings/rates");
    await expect(page.getByRole("heading", { name: "Rates", level: 1 })).toBeVisible();
    const rows = page.getByTestId("rate-card-row");
    // The fixture seeds a workspace default (950 SEK) and an agreement card (1 200 SEK).
    await expect(rows.filter({ hasText: "Workspace default" }).first()).toBeVisible();
    await expect(rows.filter({ hasText: "Förvaltning" }).first()).toBeVisible();
    await expect(rows.filter({ hasText: "Workspace default" }).first()).toContainText("950");

    // COST: the owner holds rate:view_cost but has no factor enrolled —
    // the section offers the confirmation, lists nothing, reveals nothing.
    await expect(page.getByRole("heading", { name: /Internal cost rates/ })).toBeVisible();
    await expect(page.getByTestId("cost-mfa-link")).toBeVisible();
    await expect(page.getByTestId("cost-reveal")).toHaveCount(0);
    await expect(page.getByTestId("rate-bill-form")).toBeVisible();
    await expect(page.getByTestId("rate-cost-form")).toHaveCount(0);

    // Add a member card (a dimension nothing else uses, so the fixture is untouched).
    const form = page.getByTestId("rate-bill-form");
    await form.locator("#rate-bill-scope").selectOption("MEMBER");
    await form.locator("#rate-bill-member").selectOption({ label: "E2E Owner" });
    await page.getByTestId("rate-bill-amount").fill("875");
    await page.getByTestId("rate-bill-submit").click();
    await expect(page.getByText(/past entries unchanged; use Reprice to correct history/)).toBeVisible({ timeout: 15_000 * SLOW });
    const memberRow = rows.filter({ hasText: "E2E Owner" }).first();
    await expect(memberRow).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(memberRow).toContainText("875");
    await expect(memberRow).toHaveAttribute("data-open", "1");

    // Close it in place: the row menu → "Close card…" → the date form below the table.
    await memberRow.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Close card…" }).click();
    const closeForm = page.getByTestId("rate-card-close-form");
    await expect(closeForm).toBeVisible();
    await page.getByTestId("rate-card-row-form-submit").click();
    await expect(page.getByText("Card closed.")).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(rows.filter({ hasText: "E2E Owner" }).first()).toHaveAttribute("data-open", "0", { timeout: 15_000 * SLOW });
  });
});

test.describe("time tracking settings (owner)", () => {
  test("shows the notice status and manages work types: add, rename inline, archive, restore", async ({ page }) => {
    await page.goto("/settings/time");
    await expect(page.getByRole("heading", { name: "Time tracking", level: 1 })).toBeVisible();
    await expect(page.getByText(/Version 1, published/)).toBeVisible();
    // Every fixture member is listed with their standing against version 1:
    // the owner, the employee, (slice 85) the vault manager and (slice 93b)
    // the vault owner.
    const ackRows = page.getByTestId("notice-ack-row");
    await expect(ackRows).toHaveCount(4);
    await expect(page.getByText(/of 4 members have read version 1/)).toBeVisible();
    // The publish editor waits behind the disclosure; opening it reveals both locales' fields.
    await page.locator('summary[data-slot="disclosure-trigger"]', { hasText: "Edit the text and publish" }).click();
    await expect(page.getByTestId("notice-publish-form")).toBeVisible();
    await expect(page.locator("#notice-title-sv")).toHaveValue(/Fortleva/);

    // Six seeded work types (in the tenant's default locale, sv).
    const typeRows = page.getByTestId("work-type-row");
    await expect(typeRows).toHaveCount(6);

    // Add one.
    await page.getByTestId("work-type-name").fill("E2E Review");
    await page.locator("#work-type-billable").selectOption("no");
    await page.getByTestId("work-type-submit").click();
    const row = typeRows.filter({ hasText: "E2E Review" }).first();
    await expect(row).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(row).toContainText("Not billable");

    // Rename it through the inline edit (Enter opens, type, Enter commits — AutoForm posts on blur).
    // While editing, the value lives in the control, not in the row's text, so the open
    // control is found by its accessible name rather than through the row's hasText filter.
    const trigger = row.getByRole("button", { name: /Edit name, currently E2E Review/ });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const input = page.getByRole("textbox", { name: "Edit name" });
    await expect(input).toBeVisible();
    await input.fill("E2E Review renamed");
    await page.keyboard.press("Enter");
    // AutoForm's success is its quiet "Saved" tick (the action's message is only used for errors).
    await expect(typeRows.filter({ hasText: "E2E Review renamed" }).first()).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(typeRows.filter({ hasText: "E2E Review renamed" }).first().getByText("Saved")).toBeVisible({ timeout: 15_000 * SLOW });

    // Archive → it leaves the live table, reappears under the disclosure; restore brings it back.
    const renamed = typeRows.filter({ hasText: "E2E Review renamed" }).first();
    await renamed.getByRole("button", { name: /Actions for/ }).click();
    // Reversible, so the menu item acts at once — no confirm question.
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(page.getByText("Work type archived.")).toBeVisible({ timeout: 15_000 * SLOW });
    const archivedRow = typeRows.filter({ hasText: "E2E Review renamed" }).first();
    await expect(archivedRow).toHaveAttribute("data-archived", "1", { timeout: 15_000 * SLOW });
    // The archived list waits behind the product's one disclosure (<details>/<summary>).
    await page.locator('summary[data-slot="disclosure-trigger"]', { hasText: "Archived types" }).click();
    await expect(archivedRow).toBeVisible();
    await archivedRow.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Restore" }).click();
    await expect(page.getByText("Work type restored.")).toBeVisible({ timeout: 15_000 * SLOW });
    await expect(typeRows.filter({ hasText: "E2E Review renamed" }).first()).toHaveAttribute("data-archived", "0", {
      timeout: 15_000 * SLOW,
    });
  });
});

test.describe("client agreements tab (owner)", () => {
  test("lists the agreements with their rate and the agreement rate cards", async ({ page }) => {
    await page.goto(`/clients/${seed.clientId}`);
    const tabs = page.locator('nav[data-slot="tab-strip"]');
    await tabs.getByRole("link", { name: "Agreements", exact: true }).click();
    await page.waitForURL(/\/clients\/[^/]+\/agreements$/);
    await expect(tabs.getByRole("link", { name: "Agreements", exact: true })).toHaveAttribute("aria-current", "page");
    // The Overview no longer carries the services card; this tab does.
    const maintenance = page.getByRole("row").filter({ hasText: "Förvaltning" }).first();
    await expect(maintenance).toBeVisible();
    await expect(maintenance.getByTestId("agreement-rate")).toContainText("1,200.00");
    const cards = page.getByTestId("rate-card-row");
    await expect(cards.filter({ hasText: "Förvaltning" }).first()).toBeVisible();
    await expect(page.getByTestId("rate-bill-form")).toBeVisible();
    // Pinned to SERVICE: the scope select is fixed and only this client's agreements are offered.
    await expect(page.locator("#rate-bill-scope")).toBeDisabled();
    await expect(page.locator("#rate-bill-service option")).toHaveCount(3); // placeholder + 2 agreements
  });
});

/**
 * `/settings/notifications` — the one Settings page that is NOT gated,
 * because it administers one person's own mail rather than the
 * workspace. Both halves of it are asserted through a full reload, so
 * what is checked is the stored row and not the DOM the click left
 * behind.
 */
test.describe("notification settings", () => {
  type P = import("@playwright/test").Page;
  const level = (page: P) => page.locator("#n-email-level");
  const weekly = (page: P) => page.locator("#n-weekly");

  /**
   * `<AutoForm>` saves in a React transition with no navigation, so a
   * `page.reload()` fired straight after a `selectOption` CANCELS the
   * in-flight action and the page comes back with the old value — which
   * is exactly how this suite first went red.
   *
   * Waiting on the "Saved" tick would not fix it either: that live
   * region is per form, so the email form's tick can satisfy an
   * assertion while the CHECKBOX form's save is still in flight. Both
   * halves therefore confirm the same way — reload until the stored
   * value comes back changed. The reload is the assertion: what it
   * reads is the database, not the DOM the click left behind.
   */
  const savedLevel = async (page: P, value: string) => {
    await level(page).selectOption(value);
    await expect
      .poll(
        async () => {
          await page.reload();
          return level(page).inputValue();
        },
        { timeout: 20_000 * SLOW },
      )
      .toBe(value);
  };
  const savedWeekly = async (page: P, on: boolean) => {
    await weekly(page).setChecked(on);
    await expect
      .poll(
        async () => {
          await page.reload();
          return weekly(page).isChecked();
        },
        { timeout: 20_000 * SLOW },
      )
      .toBe(on);
  };

  test.afterEach(async ({ page }) => {
    // Restore the defaults, pass or fail: the owner's preference row
    // decides whether later specs get assignment mail, and a leftover
    // NONE would make a future test pass for the wrong reason.
    await page.goto("/settings/notifications");
    if (await weekly(page).isChecked()) await savedWeekly(page, false);
    if ((await level(page).inputValue()) !== "PARTICIPATING") {
      await savedLevel(page, "PARTICIPATING");
    }
  });

  test("the email level and the weekly reminder both survive a reload, and NONE says the reminder will not arrive", async ({
    page,
  }) => {
    await page.goto("/settings/notifications");
    await expect(page.getByRole("heading", { name: "Notifications", level: 1 })).toBeVisible();
    // The default is the schema's, with no row written yet.
    await expect(level(page)).toHaveValue("PARTICIPATING");
    await expect(weekly(page)).not.toBeChecked();

    await savedLevel(page, "NONE");

    // Opting in while email is off is not an error — it is two settings
    // of the member's own that disagree, and the page says which wins.
    // The note is local state, so it appears on the click rather than
    // after the save.
    await weekly(page).check();
    await expect(page.getByText("this reminder will not be sent", { exact: false })).toBeVisible();
    await expect
      .poll(
        async () => {
          await page.reload();
          return weekly(page).isChecked();
        },
        { timeout: 20_000 * SLOW },
      )
      .toBe(true);
    // Neither form clobbered the other.
    await expect(level(page)).toHaveValue("NONE");
  });
});

/**
 * THE SUMMARY EMAIL's controls (Phase 5 slice 100; C68 (b)): how often, on
 * what day when weekly, at what hour of the member's own day — each asserted
 * through a reload, as above. The weekday select exists only while "Every
 * week" is chosen, and "Never" leaves no time to choose.
 */
test.describe("summary email settings", () => {
  type P = import("@playwright/test").Page;
  const cadence = (page: P) => page.locator("#n-summary-cadence");
  const hour = (page: P) => page.locator("#n-summary-hour");
  const weekday = (page: P) => page.locator("#n-summary-weekday");
  const saved = async (page: P, field: (p: P) => import("@playwright/test").Locator, value: string) => {
    await field(page).selectOption(value);
    await expect
      .poll(
        async () => {
          await page.reload();
          return field(page).inputValue();
        },
        { timeout: 20_000 * SLOW },
      )
      .toBe(value);
  };

  test.afterEach(async ({ page }) => {
    // Back to the defaults — every day at 08:00, Monday when weekly — pass or
    // fail: the shared owner's summary must not move for later specs.
    await page.goto("/settings/notifications");
    if ((await cadence(page).inputValue()) !== "WEEKLY") await saved(page, cadence, "WEEKLY");
    if ((await weekday(page).inputValue()) !== "1") await saved(page, weekday, "1");
    if ((await hour(page).inputValue()) !== "8") await saved(page, hour, "8");
    await saved(page, cadence, "DAILY");
  });

  test("cadence, weekday and hour survive a reload; the weekday shows only when weekly; Never leaves no time", async ({
    page,
  }) => {
    await page.goto("/settings/notifications");
    await expect(page.getByRole("heading", { name: "Summary email" })).toBeVisible();
    await expect(cadence(page)).toHaveValue("DAILY");
    await expect(hour(page)).toHaveValue("8");
    await expect(weekday(page)).toHaveCount(0);
    await expect(page.getByText("Your time zone:", { exact: false })).toBeVisible();

    await saved(page, cadence, "WEEKLY");
    await expect(weekday(page)).toHaveValue("1");
    await saved(page, weekday, "5");
    await saved(page, hour, "16");
    await expect(weekday(page)).toHaveValue("5");
    await expect(cadence(page)).toHaveValue("WEEKLY");

    await cadence(page).selectOption("NONE");
    await expect(hour(page)).toHaveCount(0);
    await expect(weekday(page)).toHaveCount(0);
    await expect
      .poll(
        async () => {
          await page.reload();
          return cadence(page).inputValue();
        },
        { timeout: 20_000 * SLOW },
      )
      .toBe("NONE");
  });
});

/**
 * THE WORKSPACE'S REPLY ADDRESS (Phase 5 slice 100; C68 (k)): asking for one
 * takes a FRESH second factor, and this shared owner has no authenticator at
 * all — so the press sends them to set one up, and nothing is mailed. The
 * whole flow, with a factor, is `vault-owner.spec.ts`'s.
 */
test.describe("reply address (owner without an authenticator)", () => {
  test("shows where replies go, and asking for an address sends them to set up an authenticator first", async ({ page }) => {
    const address = `replies-nofactor-${Date.now()}@test.invalid`;
    await page.goto("/settings/preferences");
    const card = page.getByTestId("reply-address");
    await expect(card.getByTestId("reply-address-now")).toContainText("the owner's address");
    await card.getByLabel("New address for replies").fill(address);
    await card.getByRole("button", { name: "Send confirmation link" }).click();
    await page.waitForURL(/\/account\?notice=mfa_required/, { timeout: 15_000 * SLOW });
    expect(readReplyAddressMailLink(address)).toBeNull();
  });
});

test.describe("as the employee", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill(seed.employeeEmail);
    await page.locator("#password").fill(seed.employeePassword);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("**/home", { timeout: 30_000 });
  });

  test("has neither settings page and sees no rate anywhere on the client", async ({ page }) => {
    await page.goto("/settings/rates");
    await expect(page.getByText("You do not have permission to see rate cards.")).toBeVisible();
    await expect(page.getByTestId("rate-card-row")).toHaveCount(0);
    await page.goto("/settings/time");
    await expect(page.getByText("You do not have permission to see time-tracking settings.")).toBeVisible();
    await expect(page.getByTestId("notice-ack-row")).toHaveCount(0);
    // The employee is assigned to the client: agreements show names, never rates (UI.md rule 14).
    await page.goto(`/clients/${seed.clientId}/agreements`);
    await expect(page.getByRole("row").filter({ hasText: "Förvaltning" }).first()).toBeVisible();
    await expect(page.getByTestId("agreement-rate")).toHaveCount(0);
    await expect(page.getByTestId("rate-card-row")).toHaveCount(0);
    await expect(page.getByText("1,200.00")).toHaveCount(0);
  });

  test("but DOES reach /settings/notifications — that page is nobody else's to administer", async ({
    page,
  }) => {
    await page.goto("/settings/notifications");
    await expect(page.getByRole("heading", { name: "Notifications", level: 1 })).toBeVisible();
    await expect(page.locator("#n-email-level")).toHaveValue("PARTICIPATING");
  });
});
