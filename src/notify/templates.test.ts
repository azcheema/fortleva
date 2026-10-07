import { describe, expect, it } from "vitest";

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
