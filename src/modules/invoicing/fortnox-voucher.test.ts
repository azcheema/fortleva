import { describe, expect, it } from "vitest";

import { draftOf, isOurVoucher, isThrowawayWorkspace, markerOf, storedReason, THROWAWAY_EMAIL_DOMAIN } from "./fortnox-voucher";

/**
 * The nightly send's pure pieces (slice 114b): the voucher an entry froze as
 * Fortnox takes it, the marker a reconcile matches, and a stop's reason as
 * the connection keeps it.
 */
const ENTRY = "01920000-0000-7000-8000-000000000001";

describe("draftOf", () => {
  const entry = (voucher: unknown) => ({ entryId: ENTRY, series: "F", bookedOn: "2026-10-12", voucher });

  it("the file's voucher, its date, its series and our marker", () => {
    const voucher = { text: "Betalning 1001 Kund AB", rows: [{ account: "1930", amount: "125.00" }, { account: "1510", amount: "-125.00" }] };
    expect(draftOf(entry(voucher))).toEqual({
      series: "F",
      date: "2026-10-12",
      description: "Betalning 1001 Kund AB",
      comments: `Fortleva ${ENTRY}`,
      rows: voucher.rows,
    });
  });

  it("nothing for a voucher out of shape — never a guess", () => {
    expect(draftOf(entry(null))).toBeNull();
    expect(draftOf(entry({ text: "x", rows: [{ account: 1930, amount: "1.00" }] }))).toBeNull();
    expect(draftOf(entry({ text: "x", rows: [{ account: "1930", amount: "1.00" }, { account: "3001", amount: "-2.00" }] }))).toBeNull();
    expect(draftOf(entry({ rows: [] }))).toBeNull();
  });
});

describe("the reconcile's marker", () => {
  it("matches our own words exactly, nothing around them", () => {
    expect(markerOf(ENTRY)).toBe(`Fortleva ${ENTRY}`);
    expect(isOurVoucher(`Fortleva ${ENTRY}`, ENTRY)).toBe(true);
    expect(isOurVoucher(` Fortleva ${ENTRY}\n`, ENTRY)).toBe(true);
    expect(isOurVoucher(`Fortleva ${ENTRY}2`, ENTRY)).toBe(false);
    expect(isOurVoucher(`Ref Fortleva ${ENTRY}`, ENTRY)).toBe(false);
    expect(isOurVoucher(null, ENTRY)).toBe(false);
  });
});

describe("storedReason", () => {
  it("keeps the kind and the facts it has, Fortnox's words cut to 200", () => {
    expect(storedReason({ kind: "REFUSED", code: "2000000", message: `  ${"x".repeat(300)}  `, entryId: ENTRY, invoice: "1001", day: "2026-10-12" })).toEqual({
      kind: "REFUSED",
      code: "2000000",
      message: "x".repeat(200),
      entryId: ENTRY,
      invoice: "1001",
      day: "2026-10-12",
    });
    expect(storedReason({ kind: "NO_FINANCIAL_YEAR", code: null, message: null })).toEqual({ kind: "NO_FINANCIAL_YEAR" });
  });
});

describe("the fake transport's workspaces (S′10b)", () => {
  it("only a workspace whose every member has a test address — one other member is enough to refuse", async () => {
    const asked: unknown[] = [];
    const tx = (found: { id: string } | null) => ({
      member: {
        findFirst: async (args: unknown) => {
          asked.push(args);
          return found;
        },
      },
    });
    expect(await isThrowawayWorkspace(tx({ id: "m1" }) as never, "t1")).toBe(false);
    expect(await isThrowawayWorkspace(tx(null) as never, "t1")).toBe(true);
    // The question asked: any member of THIS workspace whose address is not a test one.
    expect(asked[0]).toEqual({ where: { tenantId: "t1", user: { email: { not: { endsWith: THROWAWAY_EMAIL_DOMAIN } } } }, select: { id: true } });
    expect(THROWAWAY_EMAIL_DOMAIN).toBe("@test.invalid");
  });
});
