import { expect, test } from "@playwright/test";

import { SLOW } from "./fixtures/keys";
import { STORAGE_STATE, clearUndeliverable, removeSpecContact, requireSeed, suppressAddress } from "./fixtures/tenant";

/**
 * "EMAILS TO THIS ADDRESS AREN'T BEING DELIVERED" (Phase 5 slice 103, founder
 * decision C71 (d)) — the note beside a person whose address Fortleva has
 * stopped mailing, on a client's Contacts tab and on Members, and what the
 * member invitation now says when its mail cannot go (C71 (e)).
 *
 * There is no SNS here to send a bounce, so the fixture blocks the address
 * the way a bounce would (`suppress-address`) — only an address of this
 * throwaway tenant's own, on the reserved `@e2e-undeliverable.invalid` domain.
 * The spec makes its own contact and invitation and clears both, and the
 * block, in `afterAll`: the Contacts tab and Members are photographed by the
 * specs that sort after this one.
 */

const seed = requireSeed();
const email = `e2e-undeliverable-${Date.now()}@e2e-undeliverable.invalid`;
const NOTE = "Emails to this address aren't being delivered";

test.describe.configure({ mode: "serial" });

test.describe("an address Fortleva no longer mails", () => {
  test.afterAll(async () => {
    // EACH STEP ON ITS OWN (the code review's low): a failed first step must
    // not leave the contact for the Contacts screenshots of later specs.
    // `allSettled`, then rethrow, so a failure is still reported.
    const results = await Promise.allSettled([clearUndeliverable(seed.tenantId, email), removeSpecContact(seed.tenantId, email)]);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  });

  test("the Contacts tab says so under the address, and Members under the invitation", async ({ browser }) => {
    const member = await browser.newContext({ storageState: STORAGE_STATE, locale: "en-US" });
    const page = await member.newPage();
    try {
      await page.goto(`/clients/${seed.clientId}/contacts`);
      // BY ID, as portal-invite.spec does: the rows' inline editors carry the
      // same labels as the add form.
      await page.locator("#ct-name").fill("Ulla Undelivered");
      await page.locator("#ct-email").fill(email);
      await page.getByRole("button", { name: "Add contact" }).click();
      const row = page.locator("li", { hasText: email });
      await expect(row).toBeVisible({ timeout: 30_000 * SLOW });
      // Not blocked yet: no note.
      await expect(row.locator("[data-slot=contact-undeliverable]")).toHaveCount(0);

      await suppressAddress(seed.tenantId, email);
      await page.reload();
      await expect(page.locator("li", { hasText: email }).locator("[data-slot=contact-undeliverable]")).toHaveText(NOTE);

      // Members: inviting the blocked address saves the invitation and SAYS the
      // mail did not go — a caution, never a plain "sent" (C71 (e)).
      await page.goto("/members");
      // Scoped to the invite form: the members' own role editors carry the
      // same role names.
      const invite = page.locator("form", { has: page.locator("#invite-email") });
      await invite.locator("#invite-email").fill(email);
      await invite.getByRole("checkbox", { name: "Employee" }).check();
      await invite.getByRole("button", { name: "Send invitation" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Invitation saved, but emails to" })).toContainText(
        email,
        { timeout: 30_000 * SLOW },
      );
      const pending = page.getByRole("row", { name: new RegExp(email.replace(/[.]/g, "\\.")) });
      await expect(pending.locator("[data-slot=invite-undeliverable]")).toHaveText(NOTE);
    } finally {
      await page.close();
      await member.close();
    }
  });
});
