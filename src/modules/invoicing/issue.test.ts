import { describe, expect, it } from "vitest";

import { checkIssue, clientBlockers, type IssueClient } from "./issue-check";
import { invoiceTotals } from "./money";
import type { CompanyDetails, PaymentDetails } from "./seller";

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
  today: "2026-10-09",
};

describe("checkIssue — what the issue dialog says and the issue refuses on", () => {
  it("answers the number, the dates, the language; nothing missing", () => {
    expect(checkIssue(base)).toEqual({
      blockers: [],
      sellerMissing: [],
      nextNumber: 10007,
      issueDate: "2026-10-09",
      dueDate: "2026-11-08",
      needsFx: false,
      locale: "sv",
      noPeriod: false,
    });
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
