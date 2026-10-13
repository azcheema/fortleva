import { describe, expect, it } from "vitest";

import { CONTRACT_SENT_MAIL, CONTRACT_SIGNED_MAIL } from "./contract-mail-keys";
import { DOOR_ALARM_CONTACT_MAIL, DOOR_ALARM_MEMBER_MAIL } from "./door-alarm-mail-keys";
import { isEmailTemplate, renderEmail } from "./templates";

/**
 * THE DOOR'S ALARM MAILS (Phase 3V slice 99; founder decision C67 (c)) —
 * both template keys render in both languages, carry links and no data
 * (ARC-09), and lead where the decision says: the owners to the client's
 * Contacts tab (where that person's access is paused), the client person to
 * the portal's "forgot your password" page. An id that is not a uuid never
 * reaches a path.
 */
describe("the door's alarm mails", () => {
  const CLIENT = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
  const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

  it("are known templates", () => {
    expect(isEmailTemplate(DOOR_ALARM_MEMBER_MAIL)).toBe(true);
    expect(isEmailTemplate(DOOR_ALARM_CONTACT_MAIL)).toBe(true);
  });

  it("the owners' opens the client's Contacts tab, in either language", () => {
    for (const locale of ["en", "sv"]) {
      const mail = renderEmail(DOOR_ALARM_MEMBER_MAIL, locale, { clientId: CLIENT });
      expect(mail.subject.length).toBeGreaterThan(0);
      expect(new URL(lastLine(mail.text)).pathname).toBe(`/clients/${CLIENT}/contacts`);
    }
  });

  it("…and falls back to the clients list when the id is not a uuid", () => {
    const mail = renderEmail(DOOR_ALARM_MEMBER_MAIL, "en", { clientId: "../../admin" });
    expect(new URL(lastLine(mail.text)).pathname).toBe("/clients");
  });

  it("the person's opens the portal's password reset, in either language, and differs by language", () => {
    const en = renderEmail(DOOR_ALARM_CONTACT_MAIL, "en", {});
    const sv = renderEmail(DOOR_ALARM_CONTACT_MAIL, "sv", {});
    for (const mail of [en, sv]) expect(new URL(lastLine(mail.text)).pathname).toBe("/portal/reset-password");
    expect(en.subject).not.toBe(sv.subject);
  });

  it("name nothing: no client id in the person's mail, nothing but the link in the owners'", () => {
    const owners = renderEmail(DOOR_ALARM_MEMBER_MAIL, "en", { clientId: CLIENT });
    expect(owners.text.split(CLIENT)).toHaveLength(2); // once — in the link
    expect(lastLine(owners.text)).toContain(CLIENT);
    const person = renderEmail(DOOR_ALARM_CONTACT_MAIL, "en", { clientId: CLIENT });
    expect(person.text).not.toContain(CLIENT);
  });
});

/**
 * A CONTRACT'S MAILS (Phase 4 slice 112b2; founder decision C85 (a), (b)) — the
 * client signer's two open the contract in their portal, the sender's open it
 * on its page; each in both languages, a link and no data (ARC-09), and an id
 * that is not a uuid never reaches a path.
 */
describe("a contract's mails", () => {
  const CONTRACT = "0192f3a4-5b6c-7d8e-9f01-23456789abce";
  const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

  it("the signer's open the contract in their portal, in either language", () => {
    for (const key of [CONTRACT_SENT_MAIL, CONTRACT_SIGNED_MAIL]) {
      expect(isEmailTemplate(key)).toBe(true);
      const en = renderEmail(key, "en", { contractId: CONTRACT });
      const sv = renderEmail(key, "sv", { contractId: CONTRACT });
      for (const mail of [en, sv]) {
        expect(new URL(lastLine(mail.text)).pathname).toBe(`/portal/contracts/${CONTRACT}`);
        expect(mail.text.split(CONTRACT)).toHaveLength(2); // once — in the link
      }
      expect(en.subject).not.toBe(sv.subject);
      expect(new URL(lastLine(renderEmail(key, "en", { contractId: "../x" }).text)).pathname).toBe("/portal");
    }
  });

  it("the sender's open the contract's page", () => {
    for (const key of ["contract.signed", "contract.declined"] as const) {
      expect(new URL(lastLine(renderEmail(key, "en", { contractId: CONTRACT }).text)).pathname).toBe(`/contracts/${CONTRACT}`);
      expect(new URL(lastLine(renderEmail(key, "sv", { contractId: "nope" }).text)).pathname).toBe("/contracts");
    }
  });
});

/**
 * FORTNOX STOPPED, STILL STOPPED, WORKS AGAIN (Phase 4 slice 114c; C89 (e),
 * C90): the owners' mails open the Bookkeeping page, which says which entry
 * and why — the mail names nothing (S8, ARC-09), in either language.
 */
describe("the Fortnox stop's mails", () => {
  const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

  it("open the Bookkeeping page and carry nothing but the link", () => {
    for (const key of ["integration.fortnox_stopped", "integration.fortnox_still_stopped", "integration.fortnox_restored"] as const) {
      expect(isEmailTemplate(key), key).toBe(true);
      for (const locale of ["en", "sv"]) {
        const mail = renderEmail(key, locale, { ignored: "a stray param never reaches the mail" });
        expect(new URL(lastLine(mail.text)).pathname, `${key} ${locale}`).toBe("/invoices/bookkeeping");
        expect(mail.text).not.toContain("stray");
      }
    }
    // The first notice and the reminder read differently, in both languages.
    expect(renderEmail("integration.fortnox_stopped", "en", null).subject).not.toBe(renderEmail("integration.fortnox_still_stopped", "en", null).subject);
    expect(renderEmail("integration.fortnox_stopped", "sv", null).subject).not.toBe(renderEmail("integration.fortnox_still_stopped", "sv", null).subject);
  });
});
