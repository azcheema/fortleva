import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { INVOICE_DETAILS_CHANGED_MAIL } from "./invoice-details-mail-key";
import { INVOICE_PAY_LINK_ISSUED_MAIL } from "./invoice-pay-link-mail-key";
import { DOOR_ALARM_CONTACT_MAIL, DOOR_ALARM_MEMBER_MAIL } from "./door-alarm-mail-keys";
import { LOGIN_ASK_MAIL } from "./login-ask-mail-key";
import { MAIL_WITHOUT_REPLY_TO } from "./reply-address-resolve";
import { REPLY_ADDRESS_CHANGED_MAIL } from "./reply-address-mail-key";
import { SEALED_CONTACT_MAIL, SEALED_MEMBER_MAIL } from "./sealed-mail-keys";
import { VAULT_EXPORTED_MAIL } from "./vault-export-mail-key";

/**
 * WHICH MAIL CARRIES NO `Reply-To` (Phase 5 slice 100; founder decision C68
 * (c), (j)) — the two lists a later change could quietly break.
 */
describe("mail without a reply address", () => {
  it("every security notice to a workspace's own members is in the outbox's list", () => {
    const notices = [
      REPLY_ADDRESS_CHANGED_MAIL,
      INVOICE_DETAILS_CHANGED_MAIL,
      INVOICE_PAY_LINK_ISSUED_MAIL,
      VAULT_EXPORTED_MAIL,
      DOOR_ALARM_MEMBER_MAIL,
      ...Object.values(SEALED_MEMBER_MAIL),
    ];
    expect([...MAIL_WITHOUT_REPLY_TO].sort()).toEqual([...notices].sort());
  });

  it("mail to a client that names no secret keeps the agency's address", () => {
    for (const key of [LOGIN_ASK_MAIL, DOOR_ALARM_CONTACT_MAIL, SEALED_CONTACT_MAIL]) {
      expect(MAIL_WITHOUT_REPLY_TO.has(key)).toBe(false);
    }
  });

  it("the four sends that carry a client's live link or code never resolve one (C68 (j))", () => {
    for (const file of [
      "src/auth/portal.ts",
      "src/clients/contact-access.ts",
      "src/modules/vault/portal-writes.ts",
      "src/modules/vault/share-open.ts",
    ]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/from "@\/notify\/reply-address/);
      expect(source, file).not.toMatch(/\breplyTo\b/);
      // …and each says why, so nobody "fixes" it back.
      expect(source, file).toMatch(/C68 \(j\)/);
    }
  });
});
