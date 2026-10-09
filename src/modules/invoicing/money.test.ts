import { describe, expect, it } from "vitest";

import { DomainError } from "@/lib/domain-error";

import {
  divRoundHalfAway,
  formatFixed,
  invoiceTotals,
  lineAmount,
  parseFixed,
  readFixed,
  vatOn,
} from "./money";

/**
 * Invoice arithmetic (Phase 4 slice 107). The rounding rule is Postgres's
 * `round(numeric)` — half away from zero — because the database restates the
 * line amount in a CHECK and, at issue, the totals: a disagreement of one öre
 * refuses a correct line.
 */

const refused = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof DomainError;
  }
};

describe("divRoundHalfAway — Postgres numeric round()", () => {
  it.each([
    [5n, 10n, 1n],
    [-5n, 10n, -1n],
    [4n, 10n, 0n],
    [-4n, 10n, 0n],
    [15n, 10n, 2n],
    [-15n, 10n, -2n],
    [25n, 10n, 3n], // not banker's rounding: 2.5 → 3, as round(2.5) is 3 in Postgres
    [0n, 7n, 0n],
  ])("%s / %s → %s", (n, d, want) => {
    expect(divRoundHalfAway(n, d)).toBe(want);
  });

  it("refuses a non-positive divisor", () => {
    expect(() => divRoundHalfAway(1n, 0n)).toThrow();
  });
});

describe("parseFixed", () => {
  it.each([
    ["1 234,50", 2, 123450n],
    ["1234.5", 2, 123450n],
    ["-100", 2, -10000n],
    ["−" + "5", 2, -500n],
    ["1 000", 2, 100000n],
    ["1 000,25", 2, 100025n],
    ["1,5", 3, 1500n],
    ["0", 2, 0n],
    ["7.", 2, 700n],
    [42, 2, 4200n],
  ] as const)("%j at scale %i → %s", (raw, scale, want) => {
    expect(parseFixed(raw, scale, "x")).toBe(want);
  });

  it("answers null for blank", () => {
    expect(parseFixed("", 2, "x")).toBeNull();
    expect(parseFixed("   ", 2, "x")).toBeNull();
    expect(parseFixed(undefined, 2, "x")).toBeNull();
    expect(parseFixed(null, 2, "x")).toBeNull();
  });

  it("refuses more decimals than the column holds — never rounds a typed value", () => {
    expect(refused(() => parseFixed("0,125", 2, "x"))).toBe(true);
    expect(refused(() => parseFixed("1.0001", 3, "x"))).toBe(true);
  });

  it("refuses what is not a number", () => {
    for (const raw of ["abc", "1,2,3", "1.2.3", "--1", "1e5", "0x10", "-", ".", ",", {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(refused(() => parseFixed(raw, 2, "x"))).toBe(true);
    }
  });

  it("refuses a thousands separator it cannot tell from a decimal one", () => {
    expect(refused(() => parseFixed("1,000.50", 2, "x"))).toBe(true);
    expect(refused(() => parseFixed("1,000,000", 2, "x"))).toBe(true);
    // "1,000" is a thousand in English and 1.000 in Swedish: asked again —
    // unless the member's language makes the comma the decimal separator.
    expect(refused(() => parseFixed("1,000", 3, "x"))).toBe(true);
    expect(refused(() => parseFixed("-12,500", 3, "x"))).toBe(true);
    expect(parseFixed("1,333", 3, "x", { decimalComma: true })).toBe(1333n);
    expect(parseFixed("12,500", 3, "x", { decimalComma: true })).toBe(12_500n);
    // …and even there, a mixed or doubled separator is still refused, and so
    // is the mirror: a point grouping thousands ("1.500").
    expect(refused(() => parseFixed("1,000.5", 3, "x", { decimalComma: true }))).toBe(true);
    expect(refused(() => parseFixed("1,000,5", 3, "x", { decimalComma: true }))).toBe(true);
    expect(refused(() => parseFixed("1.500", 3, "x", { decimalComma: true }))).toBe(true);
    expect(parseFixed("1.5", 3, "x", { decimalComma: true })).toBe(1500n);
    expect(parseFixed("1.500", 3, "x")).toBe(1500n);
  });

  it("reads what is unambiguous", () => {
    expect(parseFixed("0,125", 3, "x")).toBe(125n);
    expect(parseFixed(",5", 3, "x")).toBe(500n);
    expect(parseFixed(".5", 2, "x")).toBe(50n);
    expect(parseFixed("1,25", 3, "x")).toBe(1250n);
    expect(parseFixed("1000,5", 3, "x")).toBe(1_000_500n);
  });
});

describe("formatFixed / readFixed", () => {
  it.each([
    [123450n, 2, "1234.50"],
    [-5n, 2, "-0.05"],
    [0n, 2, "0.00"],
    [1500n, 3, "1.500"],
    [-123456789n, 2, "-1234567.89"],
  ] as const)("%s at scale %i → %s", (value, scale, want) => {
    expect(formatFixed(value, scale)).toBe(want);
    expect(readFixed(want, scale)).toBe(value);
  });

  it("reads a Decimal through toFixed, whatever its own toString would say", () => {
    expect(readFixed({ toFixed: (dp: number) => (12.3).toFixed(dp) }, 2)).toBe(1230n);
  });
});

describe("lineAmount — quantity × unit price, to the öre", () => {
  it("rounds half away from zero", () => {
    // 1.5 × 999.99 = 1499.985 → 1499.99
    expect(lineAmount(1500n, 99_999n)).toBe(149_999n);
    expect(lineAmount(1500n, -99_999n)).toBe(-149_999n);
    // 0.001 × 4.99 = 0.00499 → 0.00
    expect(lineAmount(1n, 499n)).toBe(0n);
    // 0.001 × 5.00 = 0.005 → 0.01
    expect(lineAmount(1n, 500n)).toBe(1n);
  });

  it("is exact for whole hours", () => {
    expect(lineAmount(37_500n, 125_000n)).toBe(4_687_500n); // 37.5 h × 1 250,00 = 46 875,00
  });
});

describe("vatOn / invoiceTotals", () => {
  it("rounds the VAT of one amount half away from zero", () => {
    expect(vatOn(10_000n, 2500n)).toBe(2500n);
    expect(vatOn(1n, 2500n)).toBe(0n); // 0.0025
    expect(vatOn(2n, 2500n)).toBe(1n); // 0.005 → 0.01
    expect(vatOn(-2n, 2500n)).toBe(-1n);
    expect(vatOn(12_345n, 600n)).toBe(741n); // 123.45 × 6 % = 7.407 → 7.41
  });

  it("charges VAT once per rate, on the rate's sum — not per line", () => {
    // Three lines of 0,01 at 25 %: per line 0,0025 each rounds to 0; on the sum 0,0075 → 0,01.
    const totals = invoiceTotals([
      { amount: 1n, rate: 2500n },
      { amount: 1n, rate: 2500n },
      { amount: 1n, rate: 2500n },
    ]);
    expect(totals.groups).toEqual([{ rate: 2500n, net: 3n, vat: 1n }]);
    expect(totals.vatTotal).toBe(1n);
    expect(totals.total).toBe(4n);
  });

  it("groups by rate, highest first, and adds up", () => {
    const totals = invoiceTotals([
      { amount: 10_000n, rate: 600n },
      { amount: 100_000n, rate: 2500n },
      { amount: -20_000n, rate: 2500n },
      { amount: 5_000n, rate: 1200n },
    ]);
    expect(totals.groups.map((g) => g.rate)).toEqual([2500n, 1200n, 600n]);
    expect(totals.subtotal).toBe(95_000n);
    expect(totals.groups[0]).toEqual({ rate: 2500n, net: 80_000n, vat: 20_000n });
    expect(totals.vatTotal).toBe(20_000n + 600n + 600n);
    expect(totals.total).toBe(95_000n + 21_200n);
  });

  it("is all zeros for no lines", () => {
    expect(invoiceTotals([])).toEqual({ subtotal: 0n, groups: [], vatTotal: 0n, total: 0n });
  });

  it("holds a zero rate as its own group", () => {
    const totals = invoiceTotals([{ amount: 50_000n, rate: 0n }]);
    expect(totals.groups).toEqual([{ rate: 0n, net: 50_000n, vat: 0n }]);
    expect(totals.total).toBe(50_000n);
  });
});
