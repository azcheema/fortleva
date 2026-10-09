import { describe, expect, it } from "vitest";

import { DomainError } from "@/lib/domain-error";

import {
  ibanChecksumValid,
  isAktiebolagOrgNr,
  luhnValid,
  normalizeBankgiro,
  normalizeBic,
  normalizeCountryCode,
  normalizeIban,
  normalizeOrgNr,
  normalizePaymentTerms,
  normalizePlusgiro,
  normalizeSeVatNumber,
  textOrNull,
  vatNumberFor,
} from "./seller-fields";

/**
 * The workspace's invoice details (Phase 4 slice 107): typo checks before a
 * number is printed on every invoice. Vectors: Volvo AB's org. number
 * 556012-5790, Bankgirot's test numbers, the IBAN registry's examples.
 */

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof DomainError ? e.code : "THREW";
  }
};

describe("luhnValid", () => {
  it("accepts a correct check digit and refuses a changed one", () => {
    expect(luhnValid("5560125790")).toBe(true);
    expect(luhnValid("5560125791")).toBe(false);
    expect(luhnValid("5561025790")).toBe(false); // two digits swapped (Luhn's one blind spot is 09 ↔ 90)
    expect(luhnValid("")).toBe(false);
    expect(luhnValid("12a4")).toBe(false);
  });
});

describe("normalizeOrgNr", () => {
  it.each([
    ["556012-5790", "556012-5790"],
    ["5560125790", "556012-5790"],
    ["556012 5790", "556012-5790"],
    ["16556012-5790", "556012-5790"],
    ["  556012-5790 ", "556012-5790"],
  ])("%j → %s", (raw, want) => {
    expect(normalizeOrgNr(raw)).toBe(want);
  });

  it("is null for blank", () => {
    expect(normalizeOrgNr("")).toBeNull();
    expect(normalizeOrgNr(undefined)).toBeNull();
  });

  it("refuses a wrong check digit or length", () => {
    expect(codeOf(() => normalizeOrgNr("556012-5791"))).toBe("ORG_NR_INVALID");
    expect(codeOf(() => normalizeOrgNr("55601257"))).toBe("ORG_NR_INVALID");
    expect(codeOf(() => normalizeOrgNr("ABCDEF-GHIJ"))).toBe("ORG_NR_INVALID");
  });
});

describe("isAktiebolagOrgNr — who must print a registered office", () => {
  it("is true for an aktiebolag's number, false for a sole trader's or another form's", () => {
    expect(isAktiebolagOrgNr("556012-5790")).toBe(true);
    expect(isAktiebolagOrgNr("550101-1234")).toBe(false); // a personnummer born in 1955: month digit 0
    expect(isAktiebolagOrgNr("802434-0000")).toBe(false); // an ideell förening
    expect(isAktiebolagOrgNr("969754-0000")).toBe(false); // a handelsbolag
  });
});

describe("normalizeSeVatNumber / vatNumberFor", () => {
  it("accepts SE + the org. number + 01, whatever the spacing and case", () => {
    expect(normalizeSeVatNumber("SE556012579001")).toBe("SE556012579001");
    expect(normalizeSeVatNumber("se 556012-5790 01")).toBe("SE556012579001");
  });

  it("refuses another country, a missing 01 or a wrong check digit", () => {
    expect(codeOf(() => normalizeSeVatNumber("DE123456789"))).toBe("VAT_NUMBER_INVALID");
    expect(codeOf(() => normalizeSeVatNumber("SE5560125790"))).toBe("VAT_NUMBER_INVALID");
    expect(codeOf(() => normalizeSeVatNumber("SE556012579101"))).toBe("VAT_NUMBER_INVALID");
  });

  it("derives the hint from an org. number", () => {
    expect(vatNumberFor("556012-5790")).toBe("SE556012579001");
    expect(vatNumberFor(null)).toBeNull();
  });
});

describe("normalizeBankgiro / normalizePlusgiro", () => {
  it("formats a valid Bankgiro number", () => {
    expect(normalizeBankgiro("50501055")).toBe("5050-1055");
    expect(normalizeBankgiro("5050-1055")).toBe("5050-1055");
    expect(normalizeBankgiro("1234566")).toBe("123-4566");
  });

  it("refuses a Bankgiro number with a wrong check digit or length", () => {
    expect(codeOf(() => normalizeBankgiro("5050-1056"))).toBe("BANKGIRO_INVALID");
    expect(codeOf(() => normalizeBankgiro("123456"))).toBe("BANKGIRO_INVALID");
    expect(codeOf(() => normalizeBankgiro("123456789"))).toBe("BANKGIRO_INVALID");
  });

  it("formats a valid PlusGiro number and refuses a wrong one", () => {
    expect(normalizePlusgiro("9020033")).toBe("902003-3");
    expect(normalizePlusgiro("90 20 03-3")).toBe("902003-3");
    expect(codeOf(() => normalizePlusgiro("902003-4"))).toBe("PLUSGIRO_INVALID");
    expect(codeOf(() => normalizePlusgiro("1"))).toBe("PLUSGIRO_INVALID");
  });
});

describe("normalizeIban / normalizeBic", () => {
  it("accepts the registry's examples, grouped in fours", () => {
    expect(ibanChecksumValid("SE4550000000058398257466")).toBe(true);
    expect(normalizeIban("se45 5000 0000 0583 9825 7466")).toBe("SE45 5000 0000 0583 9825 7466");
    expect(normalizeIban("DE89370400440532013000")).toBe("DE89 3704 0044 0532 0130 00");
  });

  it("refuses a changed digit", () => {
    expect(codeOf(() => normalizeIban("SE4550000000058398257467"))).toBe("IBAN_INVALID");
    expect(codeOf(() => normalizeIban("SE45"))).toBe("IBAN_INVALID");
  });

  it("checks a BIC's shape", () => {
    expect(normalizeBic("essesess")).toBe("ESSESESS");
    expect(normalizeBic("DEUTDEFF500")).toBe("DEUTDEFF500");
    expect(codeOf(() => normalizeBic("ESSE"))).toBe("BIC_INVALID");
    expect(codeOf(() => normalizeBic("ESSESESS5"))).toBe("BIC_INVALID");
  });
});

describe("the rest", () => {
  it("country codes are two letters", () => {
    expect(normalizeCountryCode("se")).toBe("SE");
    expect(codeOf(() => normalizeCountryCode("S1"))).toBe("INVALID_INPUT");
  });

  it("payment terms are whole days within range", () => {
    expect(normalizePaymentTerms("30")).toBe(30);
    expect(normalizePaymentTerms(0)).toBe(0);
    expect(normalizePaymentTerms("")).toBeNull();
    expect(codeOf(() => normalizePaymentTerms("121"))).toBe("INVALID_INPUT");
    expect(codeOf(() => normalizePaymentTerms("1.5"))).toBe("INVALID_INPUT");
    expect(codeOf(() => normalizePaymentTerms("-1"))).toBe("INVALID_INPUT");
  });

  it("text is trimmed, bounded and never carries a NUL", () => {
    expect(textOrNull("  Acme AB ", 10)).toBe("Acme AB");
    expect(textOrNull("   ", 10)).toBeNull();
    expect(codeOf(() => textOrNull("x".repeat(11), 10))).toBe("INVALID_INPUT");
    expect(codeOf(() => textOrNull(`a${String.fromCharCode(0)}b`, 10))).toBe("INVALID_INPUT");
  });
});
