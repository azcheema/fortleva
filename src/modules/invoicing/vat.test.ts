import { describe, expect, it } from "vitest";

import { defaultRateFor, EU_COUNTRIES, rateAllowed, suggestVatProfile, VAT_PROFILES } from "./vat";

/** The three VAT treatments (Phase 4 slice 107) — the draft's starting point. */

const client = (countryCode: string | null, vatNumber: string | null = null) => ({
  vatProfile: null,
  countryCode,
  vatNumber,
});

describe("suggestVatProfile", () => {
  it("keeps what the client record says", () => {
    expect(suggestVatProfile({ vatProfile: "OUTSIDE_SCOPE", countryCode: "SE", vatNumber: null })).toBe(
      "OUTSIDE_SCOPE",
    );
  });

  it("Sweden or an unknown country pays Swedish VAT", () => {
    expect(suggestVatProfile(client("SE"))).toBe("SE_DOMESTIC");
    expect(suggestVatProfile(client(null))).toBe("SE_DOMESTIC");
    expect(suggestVatProfile(client(" se "))).toBe("SE_DOMESTIC");
  });

  it("another EU country: reverse charge with a VAT number, Swedish VAT without", () => {
    expect(suggestVatProfile(client("DE", "DE123456789"))).toBe("EU_REVERSE_CHARGE");
    expect(suggestVatProfile(client("de", "  "))).toBe("SE_DOMESTIC");
    expect(suggestVatProfile(client("GR", "EL123456789"))).toBe("EU_REVERSE_CHARGE");
  });

  it("outside the EU is outside the scope", () => {
    expect(suggestVatProfile(client("US"))).toBe("OUTSIDE_SCOPE");
    expect(suggestVatProfile(client("NO", "NO123456789MVA"))).toBe("OUTSIDE_SCOPE");
    expect(suggestVatProfile(client("GB"))).toBe("OUTSIDE_SCOPE");
  });
});

describe("rates", () => {
  it("Swedish VAT is 25, 12 or 6 %, 25 first; the others are 0 % only", () => {
    expect(defaultRateFor("SE_DOMESTIC")).toBe(2500n);
    expect(rateAllowed("SE_DOMESTIC", 600n)).toBe(true);
    expect(rateAllowed("SE_DOMESTIC", 0n)).toBe(false);
    for (const p of VAT_PROFILES.filter((p) => p !== "SE_DOMESTIC")) {
      expect(defaultRateFor(p)).toBe(0n);
      expect(rateAllowed(p, 2500n)).toBe(false);
    }
  });

  it("knows the 27 member states", () => {
    expect(EU_COUNTRIES.size).toBe(27);
  });
});
