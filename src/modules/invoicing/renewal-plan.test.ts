import { describe, expect, it } from "vitest";

import {
  agreementHoldsDate,
  DRAFT_LEAD_DAYS,
  renewalHoldsDate,
  renewalLineText,
  renewalsToDraft,
  renewalToDraft,
  type RenewalDraftInput,
} from "./renewal-plan";

const base: RenewalDraftInput = {
  renewsOn: "2026-11-01",
  interval: "MONTHLY",
  anchorDay: 1,
  endsOn: null,
  invoicedThrough: null,
  today: "2026-10-18",
  price: 500_000n, // 5 000,00
};
const plan = (over: Partial<RenewalDraftInput>) => renewalToDraft({ ...base, ...over });

describe("renewalToDraft — when (C88 (a), (e))", () => {
  it("drafts the coming period from 14 days before, not 15", () => {
    expect(DRAFT_LEAD_DAYS).toBe(14);
    expect(plan({ today: "2026-10-18" })).toEqual({ start: "2026-11-01", end: "2026-11-30", amount: 500_000n, prorated: false });
    expect(plan({ today: "2026-10-17" })).toBeNull();
    expect(plan({ today: "2026-11-01" })).not.toBeNull(); // on the day itself
  });

  it("never drafts a period already started, unless drafted without a gap up to it", () => {
    // Go-live, or run again after a pause: nothing for a started period.
    expect(plan({ today: "2026-11-02" })).toBeNull();
    expect(plan({ today: "2026-11-02", invoicedThrough: "2026-09-30" })).toBeNull();
    // Drafted to 31 October, the job down for the whole window: still drafted, late.
    expect(plan({ today: "2026-11-03", invoicedThrough: "2026-10-31" })).toEqual({
      start: "2026-11-01",
      end: "2026-11-30",
      amount: 500_000n,
      prorated: false,
    });
  });

  it("drafts nothing twice", () => {
    expect(plan({ invoicedThrough: "2026-11-30" })).toBeNull();
    expect(plan({ invoicedThrough: "2026-12-15" })).toBeNull();
  });
});

describe("renewalToDraft — what is left (the design review's #5)", () => {
  it("drafts only the remainder of a period partly covered, at its share", () => {
    // Monthly drafted to 30 Nov, then made quarterly from 1 Nov: Dec and Jan.
    const r = plan({ interval: "QUARTERLY", invoicedThrough: "2026-11-30", today: "2026-11-10" });
    expect(r).toMatchObject({ start: "2026-12-01", end: "2027-01-31", prorated: true });
    // 62 of 92 days (1 Nov – 31 Jan).
    expect(r!.amount).toBe(336_957n);
    // A renewal date moved from 1 Nov to 20 Nov after November was drafted: 1–19 Dec.
    expect(plan({ renewsOn: "2026-11-20", anchorDay: 20, invoicedThrough: "2026-11-30", today: "2026-11-10" })).toMatchObject({
      start: "2026-12-01",
      end: "2026-12-19",
      prorated: true,
    });
  });
});

describe("renewalToDraft — an end inside the period (C88 (f), (h))", () => {
  it("bills the days until it ends, its last day included", () => {
    const r = plan({ endsOn: "2026-11-15" });
    expect(r).toEqual({ start: "2026-11-01", end: "2026-11-15", amount: 250_000n, prorated: true });
  });

  it("an end ON the renewal day bills that one day (C88 (h))", () => {
    expect(plan({ endsOn: "2026-11-01" })).toEqual({ start: "2026-11-01", end: "2026-11-01", amount: 16_667n, prorated: true });
  });

  it("an end before the renewal bills nothing", () => {
    expect(plan({ endsOn: "2026-10-31" })).toBeNull();
  });

  it("an end on the period's last day is the whole period", () => {
    expect(plan({ endsOn: "2026-11-30" })).toEqual({ start: "2026-11-01", end: "2026-11-30", amount: 500_000n, prorated: false });
  });
});

describe("renewalToDraft — the price", () => {
  it("rounds a share half away from zero and never bills a zero-or-negative price", () => {
    expect(plan({ price: 0n })).toBeNull();
    expect(plan({ price: 1n, endsOn: "2026-11-01" })).toEqual({ start: "2026-11-01", end: "2026-11-01", amount: 0n, prorated: true });
    expect(plan({ price: 15n, endsOn: "2026-11-01" })!.amount).toBe(1n); // 0.5 rounds away
  });

  it("follows the anchor through a short month", () => {
    expect(plan({ renewsOn: "2027-01-31", anchorDay: 31, today: "2027-01-20" })).toEqual({
      start: "2027-01-31",
      end: "2027-02-27",
      amount: 500_000n,
      prorated: false,
    });
  });
});

describe("renewalsToDraft — every period owed, walking forward", () => {
  it("drafts only the coming period in the normal course", () => {
    expect(renewalsToDraft({ ...base, today: "2026-10-18" }).map((d) => [d.renewsOn, d.start, d.end])).toEqual([
      ["2026-11-01", "2026-11-01", "2026-11-30"],
    ]);
  });

  it("after an outage longer than one interval, drafts every continuous period up to the window — each day once", () => {
    // Drafted to 30 Sep; the job down until 15 Nov; the date never moved from 1 Oct.
    const drafts = renewalsToDraft({ ...base, renewsOn: "2026-10-01", invoicedThrough: "2026-09-30", today: "2026-11-15" });
    expect(drafts.map((d) => [d.start, d.end])).toEqual([
      ["2026-10-01", "2026-10-31"],
      ["2026-11-01", "2026-11-30"],
    ]);
    // 1 Dec is 16 days out on the 15th: not yet. On the 17th it is.
    expect(renewalsToDraft({ ...base, renewsOn: "2026-10-01", invoicedThrough: "2026-09-30", today: "2026-11-17" })).toHaveLength(3);
  });

  it("walks past periods already drafted to the one still owed", () => {
    // The date was never moved, but October and November were drafted: December, in its window.
    expect(renewalsToDraft({ ...base, renewsOn: "2026-10-01", invoicedThrough: "2026-11-30", today: "2026-11-20" }).map((d) => d.start)).toEqual([
      "2026-12-01",
    ]);
  });

  it("stops at a period not owed — never drafted and already started — and at the end", () => {
    expect(renewalsToDraft({ ...base, renewsOn: "2026-10-01", invoicedThrough: null, today: "2026-11-15" })).toEqual([]);
    const ending = renewalsToDraft({ ...base, renewsOn: "2026-10-01", invoicedThrough: "2026-09-30", endsOn: "2026-11-10", today: "2026-11-15" });
    expect(ending.map((d) => [d.start, d.end, d.prorated])).toEqual([
      ["2026-10-01", "2026-10-31", false],
      ["2026-11-01", "2026-11-10", true],
    ]);
  });

  it("is bounded", () => {
    const long = renewalsToDraft({ ...base, renewsOn: "2020-01-01", invoicedThrough: "2019-12-31", today: "2026-11-15" }, 5);
    expect(long).toHaveLength(5);
  });
});

describe("renewalHoldsDate — the move waits only for a period already started and still owed", () => {
  it("holds a started period not yet drafted, never one fully drafted or one still to come", () => {
    // Started 1 Nov, drafted to 31 Oct (the run's drafting failed): held.
    expect(renewalHoldsDate({ ...base, renewsOn: "2026-11-01", invoicedThrough: "2026-10-31", today: "2026-11-02" })).toBe(true);
    // November drafted: free to move.
    expect(renewalHoldsDate({ ...base, renewsOn: "2026-11-01", invoicedThrough: "2026-11-30", today: "2026-11-02" })).toBe(false);
    // Never drafted and already started (go-live, a pause): not owed — free to move.
    expect(renewalHoldsDate({ ...base, renewsOn: "2026-11-01", invoicedThrough: null, today: "2026-11-02" })).toBe(false);
    // The remainder of a started period, still owed: held.
    expect(renewalHoldsDate({ ...base, interval: "QUARTERLY", invoicedThrough: "2026-11-30", today: "2026-11-10" })).toBe(true);
  });
});

describe("renewalsToDraft — the bound is on drafts, and the hold sees past it", () => {
  it("after a run that drafted the most it may, the hold still finds the next period owed", () => {
    const stale = { ...base, renewsOn: "2020-01-01", invoicedThrough: "2019-12-31", today: "2026-11-15" };
    const first = renewalsToDraft(stale);
    expect(first).toHaveLength(24);
    const after = { ...stale, invoicedThrough: first.at(-1)!.end };
    // The date never moved: 24 drafted periods are walked past, the 25th is owed — held.
    expect(renewalsToDraft(after)[0]!.start).toBe("2022-01-01");
    expect(renewalHoldsDate(after)).toBe(true);
  });
});

describe("agreementHoldsDate — only an agreement the job would draft is ever held", () => {
  const owedFacts = {
    renewsOn: "2026-11-01",
    interval: "MONTHLY" as const,
    anchorDay: 1,
    endsOn: null,
    invoicedThrough: "2026-10-31",
    invoiceRenewals: true,
    price: 500_000n,
    currency: "SEK",
    clientActive: true,
    name: "Hosting",
  };
  const today = "2026-11-02";
  it("holds a started period still owed", () => {
    expect(agreementHoldsDate(owedFacts, today, 2000)).toBe(true);
  });
  it("never holds one the job skips: switched off, unpriced, no currency, client archived, a name too long for a line", () => {
    expect(agreementHoldsDate({ ...owedFacts, invoiceRenewals: false }, today, 2000)).toBe(false);
    expect(agreementHoldsDate({ ...owedFacts, price: null }, today, 2000)).toBe(false);
    expect(agreementHoldsDate({ ...owedFacts, price: 0n }, today, 2000)).toBe(false);
    expect(agreementHoldsDate({ ...owedFacts, currency: null }, today, 2000)).toBe(false);
    expect(agreementHoldsDate({ ...owedFacts, clientActive: false }, today, 2000)).toBe(false);
    expect(agreementHoldsDate({ ...owedFacts, name: "x".repeat(2000) }, today, 2000)).toBe(false);
  });
  it("never holds a period not owed — drafted, or never drafted and started", () => {
    expect(agreementHoldsDate({ ...owedFacts, invoicedThrough: "2026-11-30" }, today, 2000)).toBe(false);
    expect(agreementHoldsDate({ ...owedFacts, invoicedThrough: null }, today, 2000)).toBe(false);
  });
});

describe("renewalLineText", () => {
  it("names the agreement and the days, as the PDF writes a period", () => {
    expect(renewalLineText("Hosting", "2026-11-01", "2026-11-30", 2000)).toBe("Hosting, 2026-11-01 – 2026-11-30");
  });

  it("never shortens — the database holds the line to this exact text — and gives nothing when it cannot fit", () => {
    const fits = renewalLineText("x".repeat(35), "2026-11-01", "2026-11-30", 60);
    expect(fits).toBe(`${"x".repeat(35)}, 2026-11-01 – 2026-11-30`);
    expect(fits!.length).toBe(60);
    expect(renewalLineText("x".repeat(36), "2026-11-01", "2026-11-30", 60)).toBeNull();
  });
});
