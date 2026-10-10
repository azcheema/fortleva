import { describe, expect, it } from "vitest";

import { DomainError } from "@/lib/domain-error";

import {
  BOOKKEEPING_DEFAULTS,
  bookkeepingFrom,
  bookkeepingToStore,
  financialYearEndOf,
  financialYearOf,
  methodOf,
  normalizeBookkeepingValue,
  salesAccountFor,
  vatAccountFor,
  yearStartOf,
} from "./bookkeeping-accounts";

describe("bookkeeping settings", () => {
  it("reads blank as the default and holds each account to its class", () => {
    expect(normalizeBookkeepingValue("receivables", "  ")).toBeNull();
    expect(normalizeBookkeepingValue("receivables", " 1511 ")).toBe("1511");
    expect(normalizeBookkeepingValue("bank", "1940")).toBe("1940");
    expect(normalizeBookkeepingValue("salesEu", "3044")).toBe("3044");
    expect(normalizeBookkeepingValue("vat25", "2610")).toBe("2610");
    // A receivable mapped to a sales account would still balance — and be wrong.
    for (const [field, bad] of [
      ["receivables", "3001"],
      ["bank", "2611"],
      ["salesSe25", "1510"],
      ["vat25", "2711"],
      ["receivables", "151"],
      ["receivables", "15100"],
      ["receivables", "15a0"],
    ] as const) {
      expect(() => normalizeBookkeepingValue(field, bad)).toThrow(DomainError);
    }
    expect(() => normalizeBookkeepingValue("receivables", 1510)).toThrow(DomainError);
  });

  it("reads the series, the method and the year's first month", () => {
    expect(normalizeBookkeepingValue("series", "fl")).toBe("FL");
    expect(() => normalizeBookkeepingValue("series", "A B")).toThrow(DomainError);
    expect(() => normalizeBookkeepingValue("series", "ABCDEFGHIJK")).toThrow(DomainError);
    expect(normalizeBookkeepingValue("method", "CASH")).toBe("CASH");
    expect(() => normalizeBookkeepingValue("method", "cash basis")).toThrow(DomainError);
    expect(normalizeBookkeepingValue("yearStart", "5")).toBe("5");
    for (const bad of ["0", "13", "05", "x"]) expect(() => normalizeBookkeepingValue("yearStart", bad)).toThrow(DomainError);
  });

  it("reads a stored preference over the defaults, ignoring what no longer reads", () => {
    expect(bookkeepingFrom(null)).toEqual(BOOKKEEPING_DEFAULTS);
    expect(bookkeepingFrom(["x"])).toEqual(BOOKKEEPING_DEFAULTS);
    expect(bookkeepingFrom({ salesSe25: "3041", vat25: "26111", series: "c", method: "CASH", other: "x" })).toEqual({
      ...BOOKKEEPING_DEFAULTS,
      salesSe25: "3041",
      series: "C",
      method: "CASH",
    });
    expect(methodOf(BOOKKEEPING_DEFAULTS)).toBeNull();
    expect(methodOf({ ...BOOKKEEPING_DEFAULTS, method: "INVOICE" })).toBe("INVOICE");
    expect(yearStartOf(BOOKKEEPING_DEFAULTS)).toBe(1);
  });

  it("stores only what differs from the default", () => {
    expect(bookkeepingToStore(BOOKKEEPING_DEFAULTS)).toEqual({});
    expect(bookkeepingToStore({ ...BOOKKEEPING_DEFAULTS, salesEu: "3044", method: "CASH" })).toEqual({ salesEu: "3044", method: "CASH" });
  });

  it("names the financial year a day falls in", () => {
    expect(financialYearOf("2026-12-31", 1)).toBe("2026-01-01");
    expect(financialYearOf("2027-01-01", 1)).toBe("2027-01-01");
    expect(financialYearOf("2026-04-30", 5)).toBe("2025-05-01");
    expect(financialYearOf("2026-05-01", 5)).toBe("2026-05-01");
  });

  it("finds the last day of the financial year a day falls in (slice 111b)", () => {
    expect(financialYearEndOf("2026-01-01", 1)).toBe("2026-12-31");
    expect(financialYearEndOf("2026-12-31", 1)).toBe("2026-12-31");
    expect(financialYearEndOf("2025-06-10", 5)).toBe("2026-04-30");
    expect(financialYearEndOf("2026-04-30", 5)).toBe("2026-04-30");
    expect(financialYearEndOf("2026-05-01", 5)).toBe("2027-04-30");
    // A year starting in March ends on February's last day — a leap year's 29th.
    expect(financialYearEndOf("2027-06-01", 3)).toBe("2028-02-29");
    expect(financialYearEndOf("2026-06-01", 3)).toBe("2027-02-28");
    expect(financialYearEndOf("2026-07-15", 7)).toBe("2027-06-30");
  });

  it("finds each treatment's and rate's account", () => {
    const s = BOOKKEEPING_DEFAULTS;
    expect(salesAccountFor(s, "SE_DOMESTIC", 2500n)).toBe("3001");
    expect(salesAccountFor(s, "SE_DOMESTIC", 1200n)).toBe("3002");
    expect(salesAccountFor(s, "SE_DOMESTIC", 600n)).toBe("3003");
    expect(salesAccountFor(s, "EU_REVERSE_CHARGE", 0n)).toBe("3308");
    expect(salesAccountFor(s, "OUTSIDE_SCOPE", 0n)).toBe("3305");
    expect(() => salesAccountFor(s, "SE_DOMESTIC", 0n)).toThrow();
    expect([2500n, 1200n, 600n, 0n].map((r) => vatAccountFor(s, r))).toEqual(["2611", "2621", "2631", null]);
  });
});
