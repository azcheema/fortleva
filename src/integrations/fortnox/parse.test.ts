import { describe, expect, it } from "vitest";

import {
  DETAIL_MAX,
  errorFromAnswer,
  parseAccessToken,
  parseAccount,
  parseCompany,
  parseFinancialYearOn,
  parseVoucherSeries,
  tenantIdClaimOf,
} from "./parse";
import { codeChallengeOf, isStateShape, newPkceVerifier, newState, stateHashOf } from "./pkce";

/**
 * Reading Fortnox's answers (Phase 4 slice 114; the design's §3): every shape
 * checked, every refusal classified — a FortnoxError never carries more than
 * the call, the status, Fortnox's code and its message cut to 200 characters.
 */
describe("errorFromAnswer classifies Fortnox's refusals", () => {
  const info = (code: number | string, message: string) => JSON.stringify({ ErrorInformation: { error: 1, message, code } });

  it("the licence codes and the consent screen's missing licence", () => {
    expect(errorFromAnswer("accounts", 403, info(2001103, "Api-licens saknas")).kind).toBe("licence");
    expect(errorFromAnswer("accounts", 403, info("2001101", "Saknar licens")).kind).toBe("licence");
    expect(errorFromAnswer("token", 400, JSON.stringify({ error: "error_missing_license" })).kind).toBe("licence");
  });

  it("a 401 and the OAuth server's refusals are auth — the consent is gone", () => {
    expect(errorFromAnswer("companyinformation", 401, "").kind).toBe("auth");
    for (const error of ["invalid_client", "invalid_grant", "unauthorized_client", "consent_not_found"]) {
      expect(errorFromAnswer("token.tenant", 400, JSON.stringify({ error, error_description: "nope" })).kind, error).toBe("auth");
    }
  });

  it("429 is rate, 5xx unknown, any other 4xx refused with Fortnox's own words (either case of its keys)", () => {
    expect(errorFromAnswer("vouchers", 429, "").kind).toBe("rate");
    expect(errorFromAnswer("vouchers", 503, "<html>").kind).toBe("unknown");
    const refused = errorFromAnswer("accounts", 400, JSON.stringify({ ErrorInformation: { Error: 1, Message: "Kontot är inte aktivt", Code: 2000000 } }));
    expect(refused.kind).toBe("refused");
    expect(refused.code).toBe("2000000");
    expect(refused.detail).toBe("Kontot är inte aktivt");
  });

  it("cuts a long message, and keeps nothing it cannot read", () => {
    const long = errorFromAnswer("vouchers", 400, info(1, "x".repeat(500)));
    expect(long.detail?.length).toBe(DETAIL_MAX);
    const junk = errorFromAnswer("vouchers", 400, "not json");
    expect(junk.code).toBeNull();
    expect(junk.detail).toBeNull();
    // A code that is not digits or an OAuth word is dropped, never echoed.
    expect(errorFromAnswer("token", 400, JSON.stringify({ error: "<script>" })).code).toBeNull();
  });

  it("the error's own message names the call, the kind and the codes — never Fortnox's text", () => {
    const e = errorFromAnswer("accounts", 400, info(2001304, "Kontot 1930 hittades inte, secret-ish"));
    expect(e.message).toBe("fortnox accounts: refused 400 (2001304)");
    expect(e.logTag).not.toContain("secret-ish");
  });
});

describe("the shapes Fortnox answers in", () => {
  it("company information: the DatabaseNumber as a number or a string", () => {
    expect(parseCompany({ CompanyInformation: { CompanyName: "Naxdor AB", OrganizationNumber: "556677-8899", DatabaseNumber: 12345 } })).toEqual({
      name: "Naxdor AB",
      orgNr: "556677-8899",
      databaseNumber: "12345",
    });
    expect(parseCompany({ CompanyInformation: { CompanyName: "X", DatabaseNumber: "987" } }).orgNr).toBeNull();
    expect(() => parseCompany({ CompanyInformation: { CompanyName: "X", DatabaseNumber: -1 } })).toThrow(/shape/);
    expect(() => parseCompany({ Company: {} })).toThrow(/shape/);
  });

  it("the financial year holding a day, its method or null; none → null", () => {
    const years = {
      FinancialYears: [
        { Id: 3, FromDate: "2025-01-01", ToDate: "2025-12-31", AccountingMethod: "ACCRUAL" },
        { Id: 4, FromDate: "2026-01-01", ToDate: "2026-12-31", AccountingMethod: "CASH" },
      ],
    };
    expect(parseFinancialYearOn(years, "2026-10-13")).toEqual({ id: 4, from: "2026-01-01", to: "2026-12-31", method: "CASH" });
    expect(parseFinancialYearOn(years, "2027-01-01")).toBeNull();
    expect(parseFinancialYearOn({ FinancialYears: [{ Id: 5, FromDate: "2027-01-01", ToDate: "2027-12-31" }] }, "2027-02-02")?.method).toBeNull();
    expect(() => parseFinancialYearOn({ FinancialYears: [{ Id: "x" }] }, "2026-01-01")).toThrow(/shape/);
    expect(() => parseFinancialYearOn({}, "2026-01-01")).toThrow(/shape/);
  });

  it("a voucher series and an account", () => {
    expect(parseVoucherSeries({ VoucherSeries: { Code: "F", Manual: true } })).toEqual({ code: "F", manual: true });
    expect(() => parseVoucherSeries({ VoucherSeries: { Code: "F" } })).toThrow(/shape/);
    expect(parseAccount({ Account: { Number: 1930, Active: false } })).toEqual({ number: "1930", active: false });
    expect(() => parseAccount({ Account: { Number: 1930 } })).toThrow(/shape/);
  });

  it("an access token, and its tenantId claim read (never trusted alone)", () => {
    const payload = Buffer.from(JSON.stringify({ tenantId: 12345, sub: "x" })).toString("base64url");
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.c2ln`;
    expect(parseAccessToken({ access_token: jwt }, "token")).toBe(jwt);
    expect(tenantIdClaimOf(jwt)).toBe("12345");
    expect(tenantIdClaimOf("opaque-token-without-dots")).toBeNull();
    expect(() => parseAccessToken({ access_token: "short" }, "token")).toThrow(/shape/);
  });
});

describe("a connect attempt's secrets (PKCE, RFC 7636)", () => {
  it("S256 of RFC 7636's own example", () => {
    expect(codeChallengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("a state and a verifier are 43 base64url characters, fresh each time; the stored hash is hex", () => {
    const a = newState();
    expect(isStateShape(a)).toBe(true);
    expect(newState()).not.toBe(a);
    expect(newPkceVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stateHashOf(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(isStateShape("short")).toBe(false);
    expect(isStateShape(null)).toBe(false);
  });
});
