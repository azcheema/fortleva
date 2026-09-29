import { expect, test, type Browser } from "@playwright/test";

import { SLOW } from "./fixtures/keys";
import { CONTACT_STORAGE_STATE, STORAGE_STATE, requireSeed, resetNotifications, resetSignoffs } from "./fixtures/tenant";

/**
 * VERSION SIGN-OFF, THROUGH BOTH PLANES (Phase 3, decision #7 v1-lite):
 * the client approves a version and asks for changes to a deliverable
 * in a real portal session, and the agency reads both answers in a
 * real member session — two cookies, two tables, one row each.
 *
 * WHAT ONLY A BROWSER CAN SAY. `src/portal/signoff.dbtest.ts` proves
 * the census write, the audit row and the inbox row; `portal-project.
 * spec.ts` and `portal-files.spec.ts` read the OFFER of the control.
 * This drives the control: that a click on the home's card lands on the
 * page where the decision is made, that "Request changes" refuses to
 * send with nothing written and sends with a note, that the island
 * adopts the server's answer in place with no toast, that the rail
 * gains the decision as an event, and that the member's Timeline tab
 * names the contact who signed while the Files tab shows the client's
 * words and offers to ask again.
 *
 * THE SEEDED ASKS ARE DECIDED HERE AND PUT BACK IN `afterAll`
 * (`resetSignoffs`): a contact cannot undo a decision and the member's
 * re-ask refuses an approved version by design, so the fixture reaches
 * into the database. The walks that follow this file alphabetically
 * (`view-as`, `visual`) therefore photograph the SEEDED state whether or
 * not this file ran — the rule `contact-tasks.spec.ts` records for its
 * own rows.
 *
 * It sorts after `portal-project.spec.ts` (workers: 1, alphabetical),
 * which pins the rail's order with the ask still open.
 */

const seed = requireSeed();
const NOTE = `Gör logotypen större ${seed.tenantSlug.slice("e2e-".length)}`;

async function contactPage(browser: Browser) {
  const context = await browser.newContext({ storageState: CONTACT_STORAGE_STATE, locale: "en-US" });
  return { context, page: await context.newPage() };
}

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await resetSignoffs(seed.tenantId);
  await resetNotifications(seed.tenantId);
});

test.describe("portal sign-off", () => {
  test("the home lists what is waiting, and leads to the page", async ({ browser }) => {
    const { context, page } = await contactPage(browser);
    try {
      await page.goto("/portal");
      await expect(page.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 * SLOW });
      const card = page.locator('[data-slot="section-card"]', { hasText: "Waiting on you" });
      await expect(card).toBeVisible();
      // THE ASKS, not every row: since slice 76 the card also lists "Your
      // agency replied" rows (C45), and the seed's shared spec task carries
      // an agency comment as its newest — a real reply row, not this spec's.
      const items = card.locator(
        '[data-slot="portal-action-item"][data-kind="version"], [data-slot="portal-action-item"][data-kind="deliverable"]',
      );
      await expect(items).toHaveCount(2);
      await expect(card.locator('[data-slot="portal-action-item"][data-kind="version"]')).toContainText(
        `Sign off version ${seed.pendingVersion}`,
      );
      await expect(card.locator('[data-slot="portal-action-item"][data-kind="deliverable"]')).toContainText(
        `Sign off ${seed.deliverableDocName} (version 2)`,
      );
      // "Review" opens the project page — where the control is.
      await card.locator('[data-slot="portal-action-item"][data-kind="version"]').getByRole("link", { name: "Review" }).click();
      await expect(page).toHaveURL(new RegExp(`/portal/projects/${seed.projectKey}$`), { timeout: 30_000 * SLOW });
    } finally {
      await context.close();
    }
  });

  test("the client approves the version and asks for changes to the deliverable", async ({ browser }) => {
    const { context, page } = await contactPage(browser);
    try {
      await page.goto(`/portal/projects/${seed.projectKey}`);
      await expect(page.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 * SLOW });
      const card = page.locator('[data-slot="section-card"]', { hasText: "Waiting on you" });
      const versionAsk = card.locator('[data-slot="portal-action-item"][data-kind="version"]');
      const deliverableAsk = card.locator('[data-slot="portal-action-item"][data-kind="deliverable"]');
      await expect(versionAsk).toBeVisible();
      await expect(deliverableAsk).toBeVisible();
      // The card LINKS to the control (one per subject, on an element
      // that stays); "Review" jumps to the rail entry.
      await versionAsk.getByRole("link", { name: "Review" }).click();
      await expect(page).toHaveURL(/#version-/);
      const rail = page.locator('[data-slot="portal-timeline"]');
      const shipped = rail.locator('[data-kind="version_shipped"]', { hasText: `Version ${seed.pendingVersion}` });
      const shippedControl = shipped.locator('[data-slot="portal-signoff"]');

      // ── Approve the version, in place: the control becomes the
      //    decision — a status region that takes focus — with no toast
      //    and no navigation. ─────────────────────────────────────────
      await shipped.getByTestId("portal-signoff-approve").click();
      await expect(shippedControl).toHaveAttribute("data-status", "APPROVED", { timeout: 30_000 * SLOW });
      await expect(shippedControl).toContainText(/Approved \w+ \d+, \d{4}/);
      await expect(shippedControl).toHaveAttribute("role", "status");
      // FOCUS IS ASSERTED AFTER THE REVALIDATION HAS LANDED — the card's
      // version row vanishing is the signal — because the revalidated
      // tree re-keys the island and React remounts it: an assertion made
      // before that would pass in the window between the action's answer
      // and the transition's commit and prove nothing about where the
      // reader ends up (the fix-pass review traced it).
      await expect(versionAsk).toHaveCount(0, { timeout: 30_000 * SLOW });
      await expect(shippedControl).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`/portal/projects/${seed.projectKey}(#.*)?$`));

      // ── Request changes on the deliverable, on its file row: the
      //    words first. Cancel returns focus to the button; the send
      //    button is dead until something is written. ─────────────────
      const row = page.locator('[data-slot="portal-project-files"] [data-slot="portal-file"]', {
        hasText: seed.deliverableDocName,
      });
      await row.getByTestId("portal-signoff-changes").click();
      const note = row.getByLabel("What should change?");
      await expect(note).toBeFocused();
      await expect(row.getByTestId("portal-signoff-send")).toBeDisabled();
      await row.getByRole("button", { name: "Cancel" }).click();
      await expect(row.getByTestId("portal-signoff-changes")).toBeFocused();
      await row.getByTestId("portal-signoff-changes").click();
      await row.getByLabel("What should change?").fill(NOTE);
      await row.getByTestId("portal-signoff-send").click();
      await expect(row.locator('[data-slot="portal-signoff"]')).toHaveAttribute("data-status", "CHANGES_REQUESTED", {
        timeout: 30_000 * SLOW,
      });
      await expect(row).toContainText(NOTE);

      // ── After the revalidation, the page says so everywhere: the rail
      //    has both decisions as events, the version's own entry stands
      //    approved with no control, the file row carries the words, and
      //    no ASK is left on the card (nothing waits for a decision). The
      //    card itself may stay since slice 76: a "Your agency replied"
      //    row on another task of the project is not this spec's (C45). ─
      await page.reload();
      await expect(page.locator("[data-portal-surface]")).toBeVisible({ timeout: 30_000 * SLOW });
      await expect(
        page.locator('[data-slot="portal-action-item"][data-kind="version"], [data-slot="portal-action-item"][data-kind="deliverable"]'),
      ).toHaveCount(0);
      const decided = rail.locator('[data-slot="portal-event"][data-kind="approval_decided"]');
      await expect(decided).toHaveCount(2);
      const versionDecided = rail.locator('[data-kind="approval_decided"][data-subject="version"]');
      await expect(versionDecided).toHaveAttribute("data-outcome", "APPROVED");
      await expect(versionDecided).toContainText(`Version ${seed.pendingVersion} approved`);
      const deliverableDecided = rail.locator('[data-kind="approval_decided"][data-subject="deliverable"]');
      await expect(deliverableDecided).toHaveAttribute("data-outcome", "CHANGES_REQUESTED");
      await expect(deliverableDecided).toContainText(`Changes requested on ${seed.deliverableDocName} (version 2)`);
      await expect(deliverableDecided).toContainText(NOTE);
      // The decisions sit at the top: they are today's newest events.
      await expect(rail.locator('[data-slot="portal-event"]').first()).toHaveAttribute("data-kind", "milestone_due");
      await expect(rail.locator('[data-slot="portal-event"]').nth(1)).toHaveAttribute("data-kind", "approval_decided");
      await expect(shippedControl).toHaveAttribute("data-status", "APPROVED");
      await expect(shipped.getByTestId("portal-signoff-approve")).toHaveCount(0);
      await expect(row.locator('[data-slot="portal-signoff"]')).toHaveAttribute("data-status", "CHANGES_REQUESTED");
      await expect(row).toContainText(NOTE);
    } finally {
      await context.close();
    }
  });

  test("the agency reads both answers, and can ask again about the deliverable", async ({ browser }) => {
    const member = await browser.newContext({ storageState: STORAGE_STATE, locale: "en-US" });
    try {
      const page = await member.newPage();
      // The Timeline tab: the version's approval, by name.
      await page.goto(`/projects/${seed.projectKey}/timeline`);
      const version = page.locator('[data-slot="version-signoff"]');
      await expect(version).toHaveCount(1, { timeout: 30_000 * SLOW });
      await expect(version).toHaveAttribute("data-status", "APPROVED");
      await expect(version).toContainText(`Approved by ${seed.contactName}`);
      // …and no "Request sign-off" on an approved version, nor on the
      // one nobody asked about? The latter IS offered: it is shipped,
      // the portal is on, and nothing is open.
      await expect(page.getByRole("button", { name: "Request sign-off" })).toHaveCount(1);

      // The Files tab: the deliverable's answer, the client's words, and
      // the way to ask again.
      await page.goto(`/projects/${seed.projectKey}/files`);
      const row = page.locator("tr", { hasText: seed.deliverableDocName });
      await expect(row.locator('[data-slot="document-signoff"]')).toHaveAttribute("data-status", "CHANGES_REQUESTED", {
        timeout: 30_000 * SLOW,
      });
      await expect(row).toContainText(`The client wrote: ${NOTE}`);
      await row.getByRole("button", { name: `Actions for ${seed.deliverableDocName}` }).click();
      await page.getByRole("menuitem", { name: "Request sign-off" }).click();
      await expect(row.locator('[data-slot="document-signoff"]')).toHaveAttribute("data-status", "PENDING", {
        timeout: 30_000 * SLOW,
      });
      await expect(row).not.toContainText(NOTE);
      // NOT asserted here: the inbox row. A decision is announced to the
      // project's assignees and its lead (`signoff-announce.ts`), and the
      // seeded owner reaches the project through a tenant-wide role with
      // no `MemberProject` row — the empty-receivers case `requestReceivers`
      // documents. `src/portal/signoff.dbtest.ts` proves the row, its
      // receiver and its params against an assigned member.
    } finally {
      await member.close();
    }
  });
});
