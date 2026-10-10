import { describe, expect, it } from "vitest";

import { BOOKKEEPING_DEFAULTS } from "./bookkeeping-accounts";
import { formatFixed } from "./money";
import type { SieVoucher } from "./sie";
import {
  bookedAmounts,
  issueVoucher,
  lessCredits,
  paymentVoucher,
  REVERSAL_WORDS,
  reversalOf,
  voucherText,
  VOUCHER_TEXT_MAX,
  yearEndVoucher,
  type BookableInvoice,
} from "./vouchers";

const S = BOOKKEEPING_DEFAULTS;

const base: BookableInvoice = {
  kind: "INVOICE",
  displayNumber: "10001",
  issueDate: "2026-10-09",
  clientName: "Acme AB",
  currency: "SEK",
  vatProfile: "SE_DOMESTIC",
  groups: [],
  bookRate: null,
  vatRate: null,
};

/** A voucher's rows as "account amount" text — the SIGN of every row pinned (the review's L6). */
const rows = (v: SieVoucher | null) => v?.rows.map((r) => `${r.account} ${formatFixed(r.amount, 2)}`) ?? null;

const twoRates = {
  ...base,
  groups: [
    { rate: 1200n, net: 50_000n },
    { rate: 2500n, net: 100_000n },
  ],
};

describe("the invoice method: issueVoucher", () => {
  it("books a Swedish invoice at two rates to receivables, on its date", () => {
    const v = issueVoucher(twoRates, S);
    expect(v?.date).toBe("2026-10-09");
    expect(v?.text).toBe("Faktura 10001 Acme AB");
    expect(rows(v)).toEqual(["1510 1810.00", "3001 -1000.00", "3002 -500.00", "2611 -250.00", "2621 -60.00"]);
  });

  it("reverses every sign on a credit note", () => {
    const v = issueVoucher({ ...base, kind: "CREDIT_NOTE", displayNumber: "10005", groups: [{ rate: 2500n, net: 100_000n }] }, S);
    expect(v?.text).toBe("Kreditfaktura 10005 Acme AB");
    expect(rows(v)).toEqual(["1510 -1250.00", "3001 1000.00", "2611 250.00"]);
  });

  it("books an EU reverse-charge invoice in euro at its booking rate", () => {
    const v = issueVoucher({ ...base, currency: "EUR", vatProfile: "EU_REVERSE_CHARGE", groups: [{ rate: 0n, net: 200_000n }], bookRate: 11_194_000n }, S);
    expect(rows(v)).toEqual(["1510 22388.00", "3308 -22388.00"]);
  });

  it("books a US invoice outside the EU at its booking rate, to the öre", () => {
    const v = issueVoucher({ ...base, currency: "USD", vatProfile: "OUTSIDE_SCOPE", groups: [{ rate: 0n, net: 123_456n }], bookRate: 10_007_062n }, S);
    // 1 234,56 × 10,007062 = 12 354,31846… → 12 354,32
    expect(rows(v)).toEqual(["1510 12354.32", "3305 -12354.32"]);
  });

  it("books Swedish VAT on a euro invoice as the invoice states it", () => {
    const inv = { ...base, currency: "EUR", groups: [{ rate: 2500n, net: 100_000n }], bookRate: 11_100_000n, vatRate: 11_100_000n };
    expect(rows(issueVoucher(inv, S))).toEqual(["1510 13875.00", "3001 -11100.00", "2611 -2775.00"]);
    expect(bookedAmounts(inv)).toMatchObject({ net: 100_000n, vat: 25_000n, netSek: 1_110_000n, vatSek: 277_500n });
  });

  it("merges rows to the same account, and drops rows of nothing", () => {
    const v = issueVoucher({ ...twoRates, groups: [...twoRates.groups, { rate: 600n, net: 0n }] }, { ...S, salesSe25: "3041", salesSe12: "3041" });
    expect(rows(v)).toEqual(["1510 1810.00", "3041 -1500.00", "2611 -250.00", "2621 -60.00"]);
  });

  it("is null when every row is nothing", () => {
    expect(issueVoucher({ ...base, groups: [{ rate: 2500n, net: 0n }] }, S)).toBeNull();
    expect(issueVoucher({ ...base, groups: [] }, S)).toBeNull();
  });

  it("refuses another currency without its booking rate (a bug, never input)", () => {
    expect(() => issueVoucher({ ...base, currency: "USD", vatProfile: "OUTSIDE_SCOPE", groups: [{ rate: 0n, net: 1n }] }, S)).toThrow(/booking rate/);
  });

  it("converts VAT rows that sum to nothing at the booking rate (no VAT in kronor was stated)", () => {
    // +2 500,00 at 6 % and −600,00 at 25 %: VAT +150,00 and −150,00.
    const inv = {
      ...base,
      currency: "EUR",
      groups: [
        { rate: 600n, net: 250_000n },
        { rate: 2500n, net: -60_000n },
      ],
      bookRate: 11_000_000n,
    };
    expect(rows(issueVoucher(inv, S))).toEqual(["1510 20900.00", "3001 6600.00", "3003 -27500.00", "2611 1650.00", "2631 -1650.00"]);
  });

  it("always balances, and the receivable's sign follows the kind — any rates, any amounts", () => {
    let seed = 20261010;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const rates = [2500n, 1200n, 600n];
    for (let i = 0; i < 2000; i++) {
      const groups = rates.filter(() => next(3) > 0).map((rate) => ({ rate, net: BigInt(next(10_000_000)) }));
      const kind = next(2) === 0 ? "INVOICE" : "CREDIT_NOTE";
      const v = issueVoucher({ ...base, kind, currency: "EUR", groups, bookRate: BigInt(9_000_000 + next(4_000_000)), vatRate: BigInt(9_000_000 + next(4_000_000)) }, S);
      if (v === null) continue;
      expect(v.rows.reduce((s, r) => s + r.amount, 0n)).toBe(0n);
      expect(v.rows.every((r) => r.amount !== 0n)).toBe(true);
      const receivable = v.rows.find((r) => r.account === "1510")!.amount;
      expect(kind === "INVOICE" ? receivable > 0n : receivable < 0n).toBe(true);
    }
  });
});

describe("the cash method: paymentVoucher, lessCredits, reversalOf", () => {
  it("books a payment to the bank, on the day it arrived", () => {
    const v = paymentVoucher(twoRates, bookedAmounts(twoRates), "2026-10-20", S);
    expect(v?.date).toBe("2026-10-20");
    expect(v?.text).toBe("Inbetalning faktura 10001 Acme AB");
    expect(rows(v)).toEqual(["1930 1810.00", "3001 -1000.00", "3002 -500.00", "2611 -250.00", "2621 -60.00"]);
  });

  it("books the invoice less the credit notes before the payment, each document's own figures", () => {
    const credit = bookedAmounts({ ...base, kind: "CREDIT_NOTE", displayNumber: "10002", groups: [{ rate: 2500n, net: 40_000n }] });
    const v = paymentVoucher(twoRates, lessCredits(bookedAmounts(twoRates), [credit]), "2026-10-20", S);
    expect(rows(v)).toEqual(["1930 1310.00", "3001 -600.00", "3002 -500.00", "2611 -150.00", "2621 -60.00"]);
  });

  it("books a euro payment at the invoice's booking rate, its credits at theirs (the same, copied)", () => {
    const inv = { ...base, currency: "EUR", vatProfile: "EU_REVERSE_CHARGE" as const, groups: [{ rate: 0n, net: 200_000n }], bookRate: 11_194_000n };
    const credit = bookedAmounts({ ...inv, kind: "CREDIT_NOTE", groups: [{ rate: 0n, net: 50_000n }] });
    expect(rows(paymentVoucher(inv, lessCredits(bookedAmounts(inv), [credit]), "2026-11-02", S))).toEqual(["1930 16791.00", "3308 -16791.00"]);
  });

  it("is nothing when the credit notes took everything", () => {
    const credit = bookedAmounts({ ...twoRates, kind: "CREDIT_NOTE" });
    expect(paymentVoucher(twoRates, lessCredits(bookedAmounts(twoRates), [credit]), "2026-10-20", S)).toBeNull();
  });

  it("refuses to book a credit note as a payment (a bug)", () => {
    expect(() => paymentVoucher({ ...twoRates, kind: "CREDIT_NOTE" }, bookedAmounts(twoRates), "2026-10-20", S)).toThrow();
  });

  it("reverses a booked payment on another day, every sign negated", () => {
    const paid = paymentVoucher(twoRates, bookedAmounts(twoRates), "2026-10-20", S)!;
    const back = reversalOf(paid, "2026-11-05", "PAYMENT_UNDONE", "10001", "Acme AB");
    expect(back.date).toBe("2026-11-05");
    expect(back.text).toBe("Återförd inbetalning 10001 Acme AB");
    expect(rows(back)).toEqual(["1930 -1810.00", "3001 1000.00", "3002 500.00", "2611 250.00", "2621 60.00"]);
  });
});

describe("the cash method's year end (slice 111b): yearEndVoucher and its negations", () => {
  it("books an unpaid invoice less the credit notes by then to receivables, on the year's last day", () => {
    const credit = bookedAmounts({ ...base, kind: "CREDIT_NOTE", displayNumber: "10002", groups: [{ rate: 2500n, net: 40_000n }] });
    const v = yearEndVoucher(twoRates, lessCredits(bookedAmounts(twoRates), [credit]), "2026-12-31", S);
    expect(v?.date).toBe("2026-12-31");
    expect(v?.text).toBe("Bokslut obetald faktura 10001 Acme AB");
    expect(rows(v)).toEqual(["1510 1310.00", "3001 -600.00", "3002 -500.00", "2611 -150.00", "2621 -60.00"]);
  });

  it("books a euro receivable at the invoice's booking rate", () => {
    const inv = { ...base, currency: "EUR", vatProfile: "EU_REVERSE_CHARGE" as const, groups: [{ rate: 0n, net: 200_000n }], bookRate: 11_194_000n };
    expect(rows(yearEndVoucher(inv, bookedAmounts(inv), "2026-12-31", S))).toEqual(["1510 22388.00", "3308 -22388.00"]);
  });

  it("is nothing when the credit notes took everything; refuses a credit note (a bug)", () => {
    const credit = bookedAmounts({ ...twoRates, kind: "CREDIT_NOTE" });
    expect(yearEndVoucher(twoRates, lessCredits(bookedAmounts(twoRates), [credit]), "2026-12-31", S)).toBeNull();
    expect(() => yearEndVoucher({ ...twoRates, kind: "CREDIT_NOTE" }, bookedAmounts(twoRates), "2026-12-31", S)).toThrow();
  });

  it("negates it the next day, and names each withdrawal — every text within Fortnox's 50 characters", () => {
    const name = "Stockholms Byggnads- och Fastighetsförvaltning AB XYZ";
    const ye = yearEndVoucher({ ...twoRates, clientName: name }, bookedAmounts(twoRates), "2026-12-31", S)!;
    const back = reversalOf(ye, "2027-01-01", "YEAR_END_REVERSED", "10001", name);
    expect(back.date).toBe("2027-01-01");
    expect(rows(back)).toEqual(["1510 -1810.00", "3001 1000.00", "3002 500.00", "2611 250.00", "2621 60.00"]);
    for (const [event, words] of Object.entries(REVERSAL_WORDS)) {
      const text = reversalOf(ye, "2027-01-01", event as keyof typeof REVERSAL_WORDS, "10001", name).text;
      expect(text.startsWith(`${words} 10001 Stockholms`)).toBe(true);
      expect(Array.from(text).length).toBeLessThanOrEqual(VOUCHER_TEXT_MAX);
    }
    expect(Array.from(ye.text).length).toBeLessThanOrEqual(VOUCHER_TEXT_MAX);
    expect(ye.text.startsWith("Bokslut obetald faktura 10001 Stockholms")).toBe(true);
  });
});

describe("voucherText", () => {
  it("is at most 50 characters as CP437 spells it, the client's name cut", () => {
    const name = "Stockholms Byggnads- och Fastighetsförvaltning AB XYZ";
    const text = voucherText("Kreditfaktura", "10005", name);
    expect(Array.from(text).length).toBeLessThanOrEqual(VOUCHER_TEXT_MAX);
    expect(text.startsWith("Kreditfaktura 10005 Stockholms Byggnads")).toBe(true);
    // € spells "EUR" — counted after spelling, never before.
    expect(Array.from(voucherText("Faktura", "10001", "€".repeat(40))).length).toBeLessThanOrEqual(VOUCHER_TEXT_MAX);
  });

  it("carries no double quote (Fortnox's handling of \\\" is unverified)", () => {
    expect(voucherText("Faktura", "10001", 'Kalle "K" Anka')).toBe("Faktura 10001 Kalle 'K' Anka");
  });
});
