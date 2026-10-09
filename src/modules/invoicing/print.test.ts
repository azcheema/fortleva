import { describe, expect, it } from "vitest";

import { invoiceTotals } from "./money";
import { invoicePdfFileName, renderInvoicePdf } from "./pdf/invoice-pdf";
import {
  invoiceLocaleFor,
  printAddress,
  printAmount,
  printCountry,
  printFxRate,
  printQuantity,
  printRate,
  signed,
  type InvoicePrint,
} from "./print";
import type { VatProfile } from "./vat";

describe("printing amounts, quantities and rates exactly, in the invoice's language", () => {
  it("formats hundredths with two decimals and the language's separators", () => {
    // A NO-BREAK space groups the thousands: an amount never wraps across lines.
    expect(printAmount(1_234_567n, "sv")).toBe("12 345,67");
    expect(printAmount(1_234_567n, "en")).toBe("12,345.67");
    expect(printAmount(-50n, "en")).toBe("-0.50");
  });

  it("never passes through a float: the largest line amount prints to the öre", () => {
    expect(printAmount(999_999_999_999n, "en")).toBe("9,999,999,999.99");
    expect(printAmount(99_999_999_999_999n, "en")).toBe("999,999,999,999.99");
  });

  it("drops a quantity's trailing zeros, keeps a rate whole, gives a rate four to six decimals", () => {
    expect(printQuantity(1_500n, "sv")).toBe("1,5");
    expect(printQuantity(2_000n, "en")).toBe("2");
    expect(printQuantity(1_333n, "en")).toBe("1.333");
    expect(printRate(2_500n, "sv")).toBe("25");
    expect(printFxRate(11_194_000n, "sv")).toBe("11,1940");
    expect(printFxRate(10_007_152n, "en")).toBe("10.007152");
  });

  it("names a country in the invoice's language", () => {
    expect(printCountry("US", "en")).toBe("United States");
    expect(printCountry("US", "sv")).toBe("USA");
    expect(printCountry(null, "en")).toBeNull();
  });

  it("prints a country only when it is not the other party's", () => {
    const party = { addressLine1: "Main St 1", addressLine2: null, postalCode: "10001", city: "New York", countryCode: "US" };
    expect(printAddress(party, "en", "SE")).toEqual(["Main St 1", "10001 New York", "United States"]);
    expect(printAddress({ ...party, countryCode: "SE" }, "sv", null)).toEqual(["Main St 1", "10001 New York"]);
  });
});

describe("the language a client's invoices are printed in (C76 (e))", () => {
  it("is the client's choice when there is one", () => {
    expect(invoiceLocaleFor({ invoiceLocale: "en", countryCode: "SE" })).toBe("en");
    expect(invoiceLocaleFor({ invoiceLocale: "sv", countryCode: "US" })).toBe("sv");
  });

  it("is Swedish for a Swedish client or one with no country, English for everyone else", () => {
    expect(invoiceLocaleFor({ invoiceLocale: null, countryCode: "SE" })).toBe("sv");
    expect(invoiceLocaleFor({ invoiceLocale: null, countryCode: null })).toBe("sv");
    expect(invoiceLocaleFor({ invoiceLocale: null, countryCode: "US" })).toBe("en");
    expect(invoiceLocaleFor({ invoiceLocale: null, countryCode: "de" })).toBe("en");
  });

  it("reads a free-text value from before the field was a choice by its first two letters", () => {
    expect(invoiceLocaleFor({ invoiceLocale: "sv-SE", countryCode: "US" })).toBe("sv");
    expect(invoiceLocaleFor({ invoiceLocale: "German", countryCode: "SE" })).toBe("sv");
  });
});

const line = (n: number, amount: bigint, rate: bigint) => ({
  id: `00000000-0000-7000-8000-00000000000${n}`,
  position: n,
  description: `Line ${n} — Åkerlund & Łódź`,
  quantity: 1_000n,
  unit: "h",
  unitPrice: amount,
  vatRate: rate,
  amount,
});

function fixture(profile: VatProfile, locale: "sv" | "en", currency = "SEK"): InvoicePrint {
  const rate = profile === "SE_DOMESTIC" ? 2_500n : 0n;
  const lines = [line(1, 100_000n, rate), line(2, 25_050n, profile === "SE_DOMESTIC" ? 600n : 0n)];
  const totals = invoiceTotals(lines.map((l) => ({ amount: l.amount, rate: l.vatRate })));
  return {
    kind: "INVOICE",
    credits: null,
    creditReason: null,
    locale,
    displayNumber: "10001",
    issueDate: "2026-10-09",
    dueDate: "2026-11-08",
    paymentTermsDays: 30,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    buyerReference: "PO-77",
    ourReference: "Ada Lovelace",
    note: "Thank you for your business.",
    vatProfile: profile,
    currency,
    lines,
    totals,
    sekVat:
      currency === "SEK" || totals.vatTotal === 0n
        ? null
        : {
            micros: 11_194_000n,
            date: "2026-10-08",
            groups: totals.groups.map((g) => ({ ...g, vatSek: (g.vat * 11_194_000n) / 1_000_000n })),
            totalSek: 0n,
          },
    seller: {
      legalName: "Naxdor Test AB",
      orgNr: "556677-8899",
      vatNumber: "SE556677889901",
      seat: "Stockholm",
      fSkattApproved: true,
      addressLine1: "Storgatan 1",
      addressLine2: null,
      postalCode: "111 22",
      city: "Stockholm",
      countryCode: "SE",
      footerNote: "Dröjsmålsränta enligt räntelagen.",
    },
    buyer: {
      name: profile === "OUTSIDE_SCOPE" ? "Acme Inc." : "Łódź Sp. z o.o.",
      orgNr: null,
      vatNumber: profile === "EU_REVERSE_CHARGE" ? "PL1234567890" : null,
      addressLine1: "Ulica 2",
      addressLine2: null,
      postalCode: "90-001",
      city: "Łódź",
      countryCode: profile === "SE_DOMESTIC" ? "SE" : profile === "EU_REVERSE_CHARGE" ? "PL" : "US",
    },
    payment: { bankgiro: "123-4567", plusgiro: null, iban: "SE45 5000 0000 0583 9825 7466", bic: "ESSESESS" },
  };
}

describe("the invoice's PDF", () => {
  it.each([
    ["SE_DOMESTIC", "sv", "SEK"],
    ["SE_DOMESTIC", "en", "EUR"],
    ["EU_REVERSE_CHARGE", "en", "EUR"],
    ["OUTSIDE_SCOPE", "en", "USD"],
  ] as const)("renders a %s invoice in %s (%s)", async (profile, locale, currency) => {
    const bytes = await renderInvoicePdf(fixture(profile, locale, currency));
    const text = Buffer.from(bytes).toString("latin1");
    expect(text.slice(0, 5)).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(3_000);
    // Inter is EMBEDDED (subset fonts are named "ABCDEF+Inter-…"): a fallback to
    // the standard Helvetica would print "Łódź" wrong (the code review's nit).
    expect(text).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Inter-Regular/);
    expect(text).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Inter-SemiBold/);
    expect(text).not.toMatch(/\/BaseFont\s*\/Helvetica/);
  });

  it("renders with every seller field at its longest, a long note and many lines (a multi-page invoice)", async () => {
    const long = (n: number) => "Å".repeat(n);
    const base = fixture("SE_DOMESTIC", "sv");
    const lines = Array.from({ length: 60 }, (_, i) => line(i % 9, 1_000n + BigInt(i), 2_500n)).map((l, i) => ({
      ...l,
      id: `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
      description: `${long(120)} ${i}`,
    }));
    const bytes = await renderInvoicePdf({
      ...base,
      lines,
      totals: invoiceTotals(lines.map((l) => ({ amount: l.amount, rate: l.vatRate }))),
      note: long(1000),
      seller: { ...base.seller, legalName: long(200), seat: long(100), addressLine1: long(200), addressLine2: long(200), footerNote: long(500) },
    });
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    // More than one page.
    expect(Buffer.from(bytes).toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0).toBeGreaterThan(1);
  });

  it("offers the file under the invoice's own word for it", () => {
    expect(invoicePdfFileName({ locale: "sv", displayNumber: "10001", kind: "INVOICE" })).toBe("faktura-10001.pdf");
    expect(invoicePdfFileName({ locale: "en", displayNumber: "10001", kind: "INVOICE" })).toBe("invoice-10001.pdf");
    expect(invoicePdfFileName({ locale: "sv", displayNumber: "10002", kind: "CREDIT_NOTE" })).toBe("kreditfaktura-10002.pdf");
    expect(invoicePdfFileName({ locale: "en", displayNumber: "10002", kind: "CREDIT_NOTE" })).toBe("credit-note-10002.pdf");
  });
});

describe("a credit note (slice 108b; C77 (a))", () => {
  it("prints its amounts and quantities with a minus sign — one rule, `signed`", () => {
    expect(signed(125_000n, "CREDIT_NOTE")).toBe(-125_000n);
    expect(signed(125_000n, "INVOICE")).toBe(125_000n);
    expect(signed(0n, "CREDIT_NOTE")).toBe(0n);
    // Swedish prints the true minus sign: "Att betala: −1 250,00".
    expect(printAmount(signed(125_000n, "CREDIT_NOTE"), "sv")).toBe(`−${printAmount(125_000n, "sv")}`);
    expect(printQuantity(signed(2_000n, "CREDIT_NOTE"), "en")).toBe("-2");
  });

  it.each([
    ["SE_DOMESTIC", "sv", "SEK"],
    ["SE_DOMESTIC", "en", "EUR"],
    ["EU_REVERSE_CHARGE", "en", "EUR"],
  ] as const)("renders a %s credit note in %s (%s) — its own layout, Inter embedded", async (profile, locale, currency) => {
    const invoice = fixture(profile, locale, currency);
    const bytes = await renderInvoicePdf({
      ...invoice,
      kind: "CREDIT_NOTE",
      displayNumber: "10002",
      dueDate: invoice.issueDate,
      paymentTermsDays: 0,
      credits: { displayNumber: "10001", issueDate: "2026-10-01" },
      creditReason: "Wrong hours on line 2",
      payment: { bankgiro: null, plusgiro: null, iban: null, bic: null },
    });
    // The page's text is compressed (FlateDecode); what it says is the dbtests'
    // and the reviewers' — this proves the credit-note drawing renders at all.
    const text = Buffer.from(bytes).toString("latin1");
    expect(text.slice(0, 5)).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(3_000);
    expect(text).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Inter-Regular/);
  });
});
