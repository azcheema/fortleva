import { describe, expect, it } from "vitest";

import enMessages from "@/messages/en.json";
import svMessages from "@/messages/sv.json";

import { SIGN_IN_WINDOW_MONTHS, signInState, signInWindowStart } from "./sign-in-window";

const NOW = new Date("2026-09-29T10:00:00Z");
const SINCE = signInWindowStart(NOW);

describe("the Contacts tab's sign-in window", () => {
  it("is twelve calendar months, which is what the copy says", () => {
    // SECURITY.md §7 keeps auth events 12 months, and both catalogues
    // say "a year". Change one and this fails until the others follow.
    expect(SIGN_IN_WINDOW_MONTHS).toBe(12);
    expect(enMessages.clients.contacts.signIn.notWithinYear).toBe("Not signed in for a year");
    expect(svMessages.clients.contacts.signIn.notWithinYear).toBe("Inte inloggad på ett år");
    expect(SINCE.toISOString()).toBe("2025-09-29T10:00:00.000Z");
  });
});

describe("signInState", () => {
  const recent = new Date("2026-03-01T00:00:00Z");
  const old = new Date("2025-01-01T00:00:00Z");
  const contact = (createdAt: Date, activatedAt: Date | null, portalStatus: string) => ({
    createdAt,
    activatedAt,
    portalStatus,
  });

  it("shows the newest sign-in whenever there is one, whatever the status", () => {
    const at = new Date("2026-09-12T08:00:00Z");
    for (const portalStatus of ["ACTIVE", "SUSPENDED", "REVOKED", "INVITED", "NO_ACCESS"]) {
      expect(signInState(contact(old, old, portalStatus), at, SINCE)).toEqual({ kind: "at", at });
    }
  });

  it("says nothing for a contact who was never given access", () => {
    expect(signInState(contact(old, null, "NO_ACCESS"), undefined, SINCE)).toEqual({ kind: "none" });
    expect(signInState(contact(recent, null, "NO_ACCESS"), undefined, SINCE)).toEqual({ kind: "none" });
  });

  it("says Never for anybody who never accepted an invitation, however old the record", () => {
    // The chase-an-invite case: added long ago, invited last week.
    expect(signInState(contact(old, null, "INVITED"), undefined, SINCE)).toEqual({ kind: "never" });
    expect(signInState(contact(old, null, "REVOKED"), undefined, SINCE)).toEqual({ kind: "never" });
  });

  it("says Never for an accepted contact only when their whole life is inside the window", () => {
    expect(signInState(contact(recent, recent, "ACTIVE"), undefined, SINCE)).toEqual({ kind: "never" });
    // The boundary itself is inside: `>=`.
    expect(signInState(contact(SINCE, SINCE, "ACTIVE"), undefined, SINCE)).toEqual({ kind: "never" });
  });

  it("says 'not for a year' when the log can no longer prove Never", () => {
    for (const portalStatus of ["ACTIVE", "SUSPENDED", "REVOKED", "INVITED"]) {
      expect(signInState(contact(old, old, portalStatus), undefined, SINCE)).toEqual({ kind: "notWithin" });
    }
    // A re-invite's acceptance stamps `activatedAt` afresh, so a RECENT
    // `activatedAt` on an old record proves nothing about the first spell.
    expect(signInState(contact(old, recent, "INVITED"), undefined, SINCE)).toEqual({ kind: "notWithin" });
  });
});
