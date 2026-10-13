import { describe, expect, it } from "vitest";

import { actsFor, type DeliveryFacts } from "./fortnox-acts";

const ENTRY = "0190f0a0-0000-7000-8000-000000000001";
const facts = (patch: Partial<DeliveryFacts>): DeliveryFacts => ({
  state: "QUEUED",
  entryId: ENTRY,
  connStatus: "ACTIVE",
  stoppedAt: null,
  overdue: false,
  ...patch,
});

describe("what a person may decide about an entry owed to Fortnox (slice 114c)", () => {
  it("while the connection sends by itself, nothing — Fortleva sends it", () => {
    for (const state of ["QUEUED", "SENDING", "BOOKED"]) expect(actsFor(facts({ state })), state).toEqual([]);
    // Stopped, but at ANOTHER entry: still the sender's.
    expect(actsFor(facts({ connStatus: "BROKEN", stoppedAt: "0190f0a0-0000-7000-8000-000000000002" }))).toEqual([]);
  });

  it("the entry the line stopped at, queued: booked by hand", () => {
    expect(actsFor(facts({ connStatus: "BROKEN", stoppedAt: ENTRY }))).toEqual(["BY_HAND"]);
    // Asked of Fortnox with no answer yet: the sender reconciles it by number — never a person while it lives (114b's pre-apply medium).
    expect(actsFor(facts({ state: "SENDING", connStatus: "BROKEN", stoppedAt: ENTRY }))).toEqual([]);
  });

  it("a voucher in Fortnox whose PDF is a day overdue: attached by hand — not before", () => {
    expect(actsFor(facts({ state: "BOOKED", overdue: true }))).toEqual(["BY_HAND"]);
    expect(actsFor(facts({ state: "BOOKED", connStatus: "BROKEN", overdue: true }))).toEqual(["BY_HAND"]);
    expect(actsFor(facts({ state: "BOOKED", overdue: false }))).toEqual([]);
  });

  it("after a disconnect: every entry still owed is a person's; an unanswered one may also be declared not in Fortnox", () => {
    expect(actsFor(facts({ connStatus: "DISCONNECTED" }))).toEqual(["BY_HAND"]);
    expect(actsFor(facts({ connStatus: "DISCONNECTED", state: "BOOKED" }))).toEqual(["BY_HAND"]);
    expect(actsFor(facts({ connStatus: "DISCONNECTED", state: "SENDING" }))).toEqual(["BY_HAND", "NOT_IN_FORTNOX"]);
  });

  it("history is never decided again", () => {
    for (const state of ["DONE", "BY_HAND", "DOWNLOADED"]) {
      expect(actsFor(facts({ state, connStatus: "DISCONNECTED" })), state).toEqual([]);
      expect(actsFor(facts({ state, connStatus: "BROKEN", stoppedAt: ENTRY, overdue: true })), state).toEqual([]);
    }
  });
});
