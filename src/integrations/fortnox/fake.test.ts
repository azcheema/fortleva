import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { defaultFakeCompany, fakeCompanyTenantIdFor, fakeConsent, fakeFortnox, isFakeTenantId, readFakeCompany, setFakeCompany } from "./fake";
import { codeChallengeOf, newPkceVerifier } from "./pkce";

/**
 * THE FAKE FORTNOX (Phase 4 slice 114; the design's §10.4): file-backed, its
 * companies only in the reserved range, the consent bound to the PKCE
 * challenge, a revoked or a person's consent refused as Fortnox would.
 */
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fortnox-fake-"));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});
afterAll(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const DEADLINE = () => Date.now() + 10_000;

describe("the fake Fortnox", () => {
  it("a workspace's own company: the same TenantId every time, in the reserved range", () => {
    const a = fakeCompanyTenantIdFor("tenant-a");
    expect(isFakeTenantId(a)).toBe(true);
    expect(fakeCompanyTenantIdFor("tenant-a")).toBe(a);
    expect(fakeCompanyTenantIdFor("tenant-b")).not.toBe(a);
    expect(isFakeTenantId("12345")).toBe(false);
  });

  it("consent → code → token → the company, as the callback walks it", async () => {
    const tenantId = fakeCompanyTenantIdFor("walk");
    const verifier = newPkceVerifier();
    const answer = fakeConsent({ companyTenantId: tenantId, name: "Walk AB", orgNr: "556677-8899", codeChallenge: codeChallengeOf(verifier) });
    if (!("code" in answer)) throw new Error("expected a code");
    const exchanged = await fakeFortnox.exchangeCode(answer.code, verifier, DEADLINE());
    expect(exchanged.tenantIdClaim).toBe(tenantId);
    const company = await fakeFortnox.companyInformation(exchanged.accessToken, DEADLINE());
    expect(company).toEqual({ name: "Walk AB", orgNr: "556677-8899", databaseNumber: tenantId });
    const service = await fakeFortnox.tenantToken(tenantId, DEADLINE());
    expect((await fakeFortnox.companyInformation(service, DEADLINE())).databaseNumber).toBe(tenantId);
    // A code is spent once.
    await expect(fakeFortnox.exchangeCode(answer.code, verifier, DEADLINE())).rejects.toMatchObject({ kind: "auth" });
  });

  it("a code is bound to its challenge", async () => {
    const tenantId = fakeCompanyTenantIdFor("pkce");
    const answer = fakeConsent({ companyTenantId: tenantId, name: "P AB", orgNr: "556677-8899", codeChallenge: codeChallengeOf(newPkceVerifier()) });
    if (!("code" in answer)) throw new Error("expected a code");
    await expect(fakeFortnox.exchangeCode(answer.code, newPkceVerifier(), DEADLINE())).rejects.toMatchObject({ kind: "auth" });
  });

  it("refuses a TenantId outside its range, a revoked consent, a person's consent, a missing licence", async () => {
    await expect(fakeFortnox.tenantToken("12345", DEADLINE())).rejects.toMatchObject({ kind: "auth" });
    const tenantId = fakeCompanyTenantIdFor("refusals");
    setFakeCompany({ ...defaultFakeCompany(tenantId, "R AB", "556677-8899"), consentRevoked: true });
    await expect(fakeFortnox.tenantToken(tenantId, DEADLINE())).rejects.toMatchObject({ kind: "auth" });
    setFakeCompany({ ...defaultFakeCompany(tenantId, "R AB", "556677-8899"), serviceAccount: false });
    await expect(fakeFortnox.tenantToken(tenantId, DEADLINE())).rejects.toMatchObject({ kind: "auth" });
    setFakeCompany({ ...defaultFakeCompany(tenantId, "R AB", "556677-8899"), licence: false });
    await expect(fakeFortnox.tenantToken(tenantId, DEADLINE())).rejects.toMatchObject({ kind: "licence" });
    expect(() => setFakeCompany({ ...defaultFakeCompany("12345", "X", "x") })).toThrow(/reserved range/);
  });

  it("a company set to deny answers access_denied; one made first keeps what a test set", () => {
    const tenantId = fakeCompanyTenantIdFor("deny");
    setFakeCompany({ ...defaultFakeCompany(tenantId, "Other AB", "559999-0000"), denies: true });
    expect(fakeConsent({ companyTenantId: tenantId, name: "Mine AB", orgNr: "556677-8899", codeChallenge: "c".repeat(43) })).toEqual({ error: "access_denied" });
    expect(readFakeCompany(tenantId)?.name).toBe("Other AB");
  });

  it("answers the check's questions from the company's file", async () => {
    const tenantId = fakeCompanyTenantIdFor("check");
    setFakeCompany({ ...defaultFakeCompany(tenantId, "C AB", "556677-8899", new Date("2026-10-13T00:00:00Z")), missingAccounts: ["3308"], inactiveAccounts: ["2611"] });
    const token = await fakeFortnox.tenantToken(tenantId, DEADLINE());
    const year = await fakeFortnox.financialYearOn(token, "2026-10-13", DEADLINE());
    expect(year).toMatchObject({ id: 1, method: "CASH" });
    expect(await fakeFortnox.financialYearOn(token, "2030-01-01", DEADLINE())).toBeNull();
    expect(await fakeFortnox.voucherSeries(token, "F", 1, DEADLINE())).toEqual({ code: "F", manual: true, nextNumber: 1 });
    expect(await fakeFortnox.voucherSeries(token, "B", 1, DEADLINE())).toEqual({ code: "B", manual: false, nextNumber: 1 });
    expect(await fakeFortnox.voucherSeries(token, "Q", 1, DEADLINE())).toBeNull();
    expect(await fakeFortnox.account(token, "3308", 1, DEADLINE())).toBeNull();
    expect(await fakeFortnox.account(token, "2611", 1, DEADLINE())).toEqual({ number: "2611", active: false });
    expect(await fakeFortnox.account(token, "1930", 1, DEADLINE())).toEqual({ number: "1930", active: true });
  });
});

describe("the fake Fortnox's books (slice 114b)", () => {
  const rows = [
    { account: "1930", amount: "125.00" },
    { account: "3001", amount: "-100.00" },
    { account: "2611", amount: "-25.00" },
  ];
  const draft = (comments: string, date = "2026-10-12") => ({ series: "F", date, description: "Betalning 1001", comments, rows });

  it("numbers vouchers per series and year, and reads one back by its number", async () => {
    const tenantId = fakeCompanyTenantIdFor("books");
    setFakeCompany(defaultFakeCompany(tenantId, "B AB", "556677-8899", new Date("2026-10-13T00:00:00Z")));
    const token = await fakeFortnox.tenantToken(tenantId, DEADLINE());
    expect(await fakeFortnox.createVoucher(token, 1, draft("Fortleva a"), DEADLINE())).toEqual({ year: 1, series: "F", number: 1 });
    expect(await fakeFortnox.createVoucher(token, 1, draft("Fortleva b"), DEADLINE())).toEqual({ year: 1, series: "F", number: 2 });
    expect((await fakeFortnox.voucherSeries(token, "F", 1, DEADLINE()))?.nextNumber).toBe(3);
    expect(await fakeFortnox.voucherByNumber(token, "F", 2, 1, DEADLINE())).toEqual({ comments: "Fortleva b" });
    expect(await fakeFortnox.voucherByNumber(token, "F", 9, 1, DEADLINE())).toBeNull();
    expect(readFakeCompany(tenantId)?.vouchers?.[0]?.rows).toEqual([
      { account: 1930, debit: "125.00", credit: "0" },
      { account: 3001, debit: "0", credit: "100.00" },
      { account: 2611, debit: "0", credit: "25.00" },
    ]);
  });

  it("refuses as Fortnox would: outside the year, a series not manual, a locked period, an inactive account — and its hooks", async () => {
    const tenantId = fakeCompanyTenantIdFor("books-refusals");
    const base = defaultFakeCompany(tenantId, "R AB", "556677-8899", new Date("2026-10-13T00:00:00Z"));
    setFakeCompany({ ...base, series: { F: { manual: false } } });
    const token = await fakeFortnox.tenantToken(tenantId, DEADLINE());
    await expect(fakeFortnox.createVoucher(token, 1, draft("x"), DEADLINE())).rejects.toMatchObject({ kind: "refused", code: "2001940" });
    setFakeCompany({ ...base, lockedThrough: "2026-10-31" });
    await expect(fakeFortnox.createVoucher(token, 1, draft("x"), DEADLINE())).rejects.toMatchObject({ kind: "refused" });
    setFakeCompany({ ...base, inactiveAccounts: ["2611"] });
    await expect(fakeFortnox.createVoucher(token, 1, draft("x"), DEADLINE())).rejects.toMatchObject({ kind: "refused" });
    setFakeCompany(base);
    await expect(fakeFortnox.createVoucher(token, 1, draft("x", "2028-01-01"), DEADLINE())).rejects.toMatchObject({ kind: "refused" });
    // A refusal once, then the hook is gone.
    setFakeCompany({ ...base, refuseNextVoucher: { code: "2000000", message: "Nej" } });
    await expect(fakeFortnox.createVoucher(token, 1, draft("x"), DEADLINE())).rejects.toMatchObject({ kind: "refused", code: "2000000", detail: "Nej" });
    expect(await fakeFortnox.createVoucher(token, 1, draft("x"), DEADLINE())).toMatchObject({ number: 1 });
    // Made, and the answer lost — once.
    setFakeCompany({ ...readFakeCompany(tenantId)!, loseNextVoucherAnswer: true });
    await expect(fakeFortnox.createVoucher(token, 1, draft("lost"), DEADLINE())).rejects.toMatchObject({ kind: "unknown" });
    expect(await fakeFortnox.voucherByNumber(token, "F", 2, 1, DEADLINE())).toEqual({ comments: "lost" });
    expect(await fakeFortnox.createVoucher(token, 1, draft("after"), DEADLINE())).toMatchObject({ number: 3 });
  });

  it("an upload connects to one voucher, once; its connection is read back", async () => {
    const tenantId = fakeCompanyTenantIdFor("books-files");
    setFakeCompany(defaultFakeCompany(tenantId, "F AB", "556677-8899", new Date("2026-10-13T00:00:00Z")));
    const token = await fakeFortnox.tenantToken(tenantId, DEADLINE());
    const v = await fakeFortnox.createVoucher(token, 1, draft("Fortleva f"), DEADLINE());
    const fileId = await fakeFortnox.uploadToInbox(token, new Uint8Array([37, 80, 68, 70]), "Faktura 1001.pdf", DEADLINE());
    expect(await fakeFortnox.fileConnection(token, fileId, DEADLINE())).toBeNull();
    await fakeFortnox.connectFile(token, v.year, fileId, v.series, v.number, DEADLINE());
    expect(await fakeFortnox.fileConnection(token, fileId, DEADLINE())).toEqual({ series: "F", number: v.number });
    await expect(fakeFortnox.connectFile(token, v.year, fileId, v.series, v.number, DEADLINE())).rejects.toMatchObject({ kind: "refused" });
    await expect(fakeFortnox.connectFile(token, v.year, "no-such-file", v.series, v.number, DEADLINE())).rejects.toMatchObject({ kind: "refused" });
  });
});
