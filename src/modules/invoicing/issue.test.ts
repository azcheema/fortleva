import { describe, expect, it } from "vitest";

import {
  checkCreditIssue,
  checkIssue,
  clientBlockers,
  creditCovers,
  creditLeavesNegative,
  creditOverRates,
  mentionsPaymentDetails,
  type IssueClient,
  type RateNets,
} from "./issue-check";
import { invoiceTotals } from "./money";
import type { CompanyDetails, PaymentDetails } from "./seller";

describe("text that reads like somewhere to pay (slice 109; the security review's low)", () => {
  it("notices a web address, an IBAN, a Bankgiro number or the words for them", () => {
    for (const text of [
      "Pay at https://evil.example/pay",
      "see www.example.se",
      "IBAN SE45 5000 0000 0583 9825 7466",
      "SE4550000000058398257466",
      "Bankgiro 123-4567",
      "betala till 5050-1055",
      "Use Swish",
    ]) {
      expect(mentionsPaymentDetails([text]), text).toBe(true);
    }
  });

  it("stays quiet on ordinary invoice text — dates, hours, prices", () => {
    expect(mentionsPaymentDetails(["Consulting, September 2026", "Period 2026-09-01 – 2026-09-30", "12.5 h", null, undefined])).toBe(false);
  });
});

const company: CompanyDetails = {
  legalName: "Invi Konsult AB",
  orgNr: "556016-0680",
  vatNumber: "SE556016068001",
  seat: "Stockholm",
  fSkattApproved: true,
  addressLine1: "Storgatan 1",
  addressLine2: null,
  postalCode: "111 22",
  city: "Stockholm",
  countryCode: "SE",
};
const payment: PaymentDetails = { bankgiro: "5050-1055", plusgiro: null, iban: null, bic: null, footerNote: null };
const numbering = { seriesId: "s", firstNumber: 10001, nextNumber: 10007, used: true };
const client = (over: Partial<IssueClient> = {}): IssueClient => ({
  name: "Acme AB",
  addressLine1: "Gatan 1",
  city: "Stockholm",
  countryCode: "SE",
  vatNumber: null,
  invoiceLocale: null,
  ...over,
});

const base = {
  company,
  payment,
  numbering,
  client: client(),
  vatProfile: "SE_DOMESTIC" as const,
  currency: "SEK",
  lineCount: 1,
  totals: invoiceTotals([{ amount: 100_000n, rate: 2500n }]),
  paymentTermsDays: 30,
  locale: null,
  hasPeriod: true,
  periodEnd: null,
  today: "2026-10-09",
};

describe("checkIssue — what the issue dialog says and the issue refuses on", () => {
  it("answers the number, the dates, the language; nothing missing", () => {
    expect(checkIssue(base)).toEqual({
      kind: "INVOICE",
      blockers: [],
      sellerMissing: [],
      nextNumber: 10007,
      issueDate: "2026-10-09",
      dueDate: "2026-11-08",
      needsFx: false,
      rateDay: null,
      locale: "sv",
      noPeriod: false,
      overCredit: [],
      creditsIssueDate: null,
      hoursChanged: 0,
      privateTaskLines: [],
    });
  });

  it("slice 110: a line naming a private task blocks it; a record the marks disagree with too; changed hours only caution", () => {
    const hours = { changed: 2, privateTaskLines: [3], mismatch: true };
    const check = checkIssue({ ...base, hours });
    expect(check.blockers).toEqual(["privateTask", "hoursMismatch"]);
    expect(check).toMatchObject({ hoursChanged: 2, privateTaskLines: [3] });
    const calm = checkIssue({ ...base, hours: { changed: 4, privateTaskLines: [], mismatch: false } });
    expect(calm.blockers).toEqual([]);
    expect(calm.hoursChanged).toBe(4);
  });

  it("counts the due date across a month and a year", () => {
    expect(checkIssue({ ...base, today: "2026-12-20", paymentTermsDays: 15 }).dueDate).toBe("2027-01-04");
    expect(checkIssue({ ...base, paymentTermsDays: 0 }).dueDate).toBe("2026-10-09");
  });

  it("names what the workspace lacks, the numbering included", () => {
    const r = checkIssue({ ...base, numbering: null, company: { ...company, seat: null }, payment: { ...payment, bankgiro: null } });
    expect(r.blockers).toEqual(["seller"]);
    expect(r.sellerMissing).toEqual(["numbering", "seat", "payment"]);
    // A bank detail stored but unreadable stops it too — re-entering it fixes it.
    const u = checkIssue({ ...base, paymentUnreadable: true });
    expect([u.blockers, u.sellerMissing]).toEqual([["seller"], ["paymentUnreadable"]]);
  });

  it("refuses no lines and a total below zero, and wants a rate only on another currency carrying VAT", () => {
    expect(checkIssue({ ...base, lineCount: 0, totals: invoiceTotals([]) }).blockers).toEqual(["noLines"]);
    expect(checkIssue({ ...base, totals: invoiceTotals([{ amount: -100n, rate: 2500n }]) }).blockers).toEqual(["negativeTotal"]);
    expect(checkIssue({ ...base, currency: "EUR" }).needsFx).toBe(true);
    expect(checkIssue({ ...base, currency: "EUR", vatProfile: "EU_REVERSE_CHARGE", totals: invoiceTotals([{ amount: 100n, rate: 0n }]), client: client({ countryCode: "DE", vatNumber: "DE123" }) }).needsFx).toBe(false);
  });

  it("keeps a draft's own language, else the client's, and warns when no work period is set", () => {
    expect(checkIssue({ ...base, locale: "en" }).locale).toBe("en");
    expect(checkIssue({ ...base, client: client({ countryCode: "US" }) }).locale).toBe("en");
    expect(checkIssue({ ...base, hasPeriod: false }).noPeriod).toBe(true);
  });
});

describe("clientBlockers — the treatment against the buyer (the guard restates it)", () => {
  it("wants a name's address and city", () => {
    expect(clientBlockers(client({ addressLine1: " " }), "SE_DOMESTIC")).toEqual(["clientAddress"]);
    expect(clientBlockers(client({ city: null }), "SE_DOMESTIC")).toEqual(["clientAddress"]);
  });

  it("a reverse charge is to a business in ANOTHER member state whose VAT number carries its prefix", () => {
    expect(clientBlockers(client({ countryCode: "DE", vatNumber: "DE 123 456 789" }), "EU_REVERSE_CHARGE")).toEqual([]);
    expect(clientBlockers(client({ countryCode: "GR", vatNumber: "EL123456789" }), "EU_REVERSE_CHARGE")).toEqual([]);
    expect(clientBlockers(client({ countryCode: "GR", vatNumber: "GR123456789" }), "EU_REVERSE_CHARGE")).toEqual(["clientVatCountry"]);
    expect(clientBlockers(client({ countryCode: "DE", vatNumber: "FR123" }), "EU_REVERSE_CHARGE")).toEqual(["clientVatCountry"]);
    expect(clientBlockers(client({ countryCode: "SE", vatNumber: "SE556677889901" }), "EU_REVERSE_CHARGE")).toEqual(["clientVatCountry"]);
    expect(clientBlockers(client({ countryCode: "US", vatNumber: "US1" }), "EU_REVERSE_CHARGE")).toEqual(["clientVatCountry"]);
    expect(clientBlockers(client({ countryCode: "DE" }), "EU_REVERSE_CHARGE")).toEqual(["clientVatNumber"]);
    expect(clientBlockers(client({ countryCode: null, vatNumber: "DE1" }), "EU_REVERSE_CHARGE")).toEqual(["clientCountry"]);
  });

  it("outside the scope is to a buyer outside the EU", () => {
    expect(clientBlockers(client({ countryCode: "US" }), "OUTSIDE_SCOPE")).toEqual([]);
    expect(clientBlockers(client({ countryCode: "NO" }), "OUTSIDE_SCOPE")).toEqual([]);
    expect(clientBlockers(client({ countryCode: "SE" }), "OUTSIDE_SCOPE")).toEqual(["clientInEu"]);
    expect(clientBlockers(client({ countryCode: "fr" }), "OUTSIDE_SCOPE")).toEqual(["clientInEu"]);
    expect(clientBlockers(client({ countryCode: null }), "OUTSIDE_SCOPE")).toEqual(["clientCountry"]);
  });

  it("Swedish VAT needs no country (a blank one is Sweden)", () => {
    expect(clientBlockers(client({ countryCode: null }), "SE_DOMESTIC")).toEqual([]);
  });
});

describe("the rate's day on an invoice (C78 (a))", () => {
  const eur = { ...base, currency: "EUR" };

  it("is the day the work ended, the invoice date without a period, never after it", () => {
    expect(checkIssue({ ...eur, periodEnd: "2026-09-30" }).rateDay).toBe("2026-09-30");
    expect(checkIssue({ ...eur, periodEnd: null }).rateDay).toBe("2026-10-09");
    expect(checkIssue({ ...eur, periodEnd: "2026-10-31" }).rateDay).toBe("2026-10-09");
    // No SEK VAT wanted: no day.
    expect(checkIssue({ ...base, periodEnd: "2026-09-30" }).rateDay).toBeNull();
  });

  it("refuses a work period that ended before the ECB's 90 days of history, before the click", () => {
    expect(checkIssue({ ...eur, periodEnd: "2026-07-10" }).blockers).toEqual(["fxTooOld"]);
    expect(checkIssue({ ...eur, periodEnd: "2026-07-11" }).blockers).toEqual([]);
    // In SEK the day does not matter.
    expect(checkIssue({ ...base, periodEnd: "2026-01-01" }).blockers).toEqual([]);
  });
});

const nets = (...pairs: [bigint, bigint][]): RateNets => new Map(pairs);

describe("the over-credit rule (slice 108b; the guard's invoice_credit_within)", () => {
  // An invoice of 1 000,00 at 25 % and 200,00 at 6 %.
  const original = nets([2500n, 100_000n], [600n, 20_000n]);

  it("lets credit notes take, at each rate, up to what the invoice has", () => {
    expect(creditOverRates(original, nets(), original)).toEqual([]);
    expect(creditOverRates(original, nets([2500n, 40_000n]), nets([2500n, 60_000n]))).toEqual([]);
  });

  it("refuses more than is left at a rate, naming what is left", () => {
    expect(creditOverRates(original, nets([2500n, 40_000n]), nets([2500n, 60_001n]))).toEqual([
      { rate: 2500n, left: 60_000n, asked: 60_001n },
    ]);
  });

  it("refuses a rate the invoice lacks — even a line netting to nothing there", () => {
    expect(creditOverRates(original, nets(), nets([1200n, 100n]))).toEqual([{ rate: 1200n, left: 0n, asked: 100n }]);
    expect(creditOverRates(original, nets(), nets([1200n, 0n]))).toEqual([{ rate: 1200n, left: 0n, asked: 0n }]);
  });

  it("is signed: a discount rate is credited towards its own sign, never past it, and a credit note never un-credits a rate", () => {
    // 1 000,00 at 25 % and a discount of −200,00 at 6 %.
    const withDiscount = nets([2500n, 100_000n], [600n, -20_000n]);
    expect(creditOverRates(withDiscount, nets(), withDiscount)).toEqual([]);
    // Crediting only the discount pushes the invoice UP: refused.
    expect(creditOverRates(withDiscount, nets(), nets([600n, 20_000n]))).toEqual([{ rate: 600n, left: -20_000n, asked: 20_000n }]);
    // A negative net at a positive rate "un-credits" it, even within the cumulative bound.
    expect(creditOverRates(original, nets([2500n, 50_000n]), nets([2500n, -10_000n]))).toEqual([
      { rate: 2500n, left: 50_000n, asked: -10_000n },
    ]);
  });

  it("is covered only when every rate is credited exactly", () => {
    expect(creditCovers(original, original)).toBe(true);
    expect(creditCovers(original, nets([2500n, 100_000n]))).toBe(false);
    expect(creditCovers(original, nets([2500n, 100_000n], [600n, 19_999n]))).toBe(false);
  });

  it("refuses a part credit that would leave only a discount, which nothing could credit later", () => {
    const withDiscount = nets([2500n, 100_000n], [600n, -20_000n]);
    expect(creditLeavesNegative(withDiscount, nets(), nets([2500n, 100_000n]))).toBe(true);
    expect(creditLeavesNegative(withDiscount, nets(), nets([2500n, 50_000n]))).toBe(false);
    expect(creditLeavesNegative(withDiscount, nets(), withDiscount)).toBe(false);
  });
});

describe("checkCreditIssue — what a credit note's issue dialog says", () => {
  const original = nets([2500n, 100_000n]);
  const credit = {
    reason: "Wrong hours",
    lineCount: 1,
    totals: invoiceTotals([{ amount: 100_000n, rate: 2500n }]),
    originalOpen: true,
    original,
    credited: nets(),
    numbering,
    currency: "SEK",
    originalRateDate: null,
    originalIssueDate: "2026-10-01",
    locale: "sv" as const,
    today: "2026-10-09",
  };

  it("is dated today, due the same day, and asks nothing of the seller or the client", () => {
    expect(checkCreditIssue(credit)).toEqual({
      kind: "CREDIT_NOTE",
      blockers: [],
      sellerMissing: [],
      nextNumber: 10007,
      issueDate: "2026-10-09",
      dueDate: "2026-10-09",
      needsFx: false,
      rateDay: null,
      locale: "sv",
      noPeriod: false,
      overCredit: [],
      creditsIssueDate: "2026-10-01",
      // A credit note credits lines, never hours.
      hoursChanged: 0,
      privateTaskLines: [],
    });
  });

  it("is never dated before its invoice (a workspace moved west)", () => {
    expect(checkCreditIssue({ ...credit, originalIssueDate: "2026-10-10" }).blockers).toEqual(["beforeInvoice"]);
  });

  it("refuses VAT in SEK when its invoice stated no rate (its VAT came to nothing)", () => {
    const r = checkCreditIssue({ ...credit, currency: "EUR", originalRateDate: null });
    expect(r.blockers).toEqual(["noRate"]);
  });

  it("wants a reason, a line, a total above zero, an open invoice and nothing over", () => {
    expect(checkCreditIssue({ ...credit, reason: "  " }).blockers).toEqual(["noReason"]);
    expect(checkCreditIssue({ ...credit, lineCount: 0, totals: invoiceTotals([]) }).blockers).toEqual(["noLines"]);
    expect(checkCreditIssue({ ...credit, totals: invoiceTotals([{ amount: 0n, rate: 2500n }]) }).blockers).toEqual(["notPositive"]);
    expect(checkCreditIssue({ ...credit, originalOpen: false }).blockers).toEqual(["originalNotOpen"]);
    const over = checkCreditIssue({ ...credit, credited: nets([2500n, 50_000n]) });
    expect(over.blockers).toEqual(["overCredit"]);
    expect(over.overCredit).toEqual([{ rate: 2500n, left: 50_000n, asked: 100_000n }]);
  });

  it("takes its invoice's rate's day for the VAT in SEK", () => {
    const r = checkCreditIssue({ ...credit, currency: "EUR", originalRateDate: "2026-09-30" });
    expect([r.needsFx, r.rateDay]).toEqual([true, "2026-09-30"]);
  });
});
