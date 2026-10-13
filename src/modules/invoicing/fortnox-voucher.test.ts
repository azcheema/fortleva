import { describe, expect, it } from "vitest";

import { draftOf, isOurVoucher, isThrowawayWorkspace, markerOf, stopReminderDue, storedReason, THROWAWAY_EMAIL_DOMAIN } from "./fortnox-voucher";

/**
 * Slice 114c (C89 (e)): a stop's Monday reminder — 08:00 on the workspace's
 * wall clock, once a week, never hours after the first notice. 2026-10-12 is
 * a Monday; Stockholm is UTC+2 until 25 October, UTC+1 after.
 */
describe("stopReminderDue", () => {
  const ZONE = "Europe/Stockholm";
  const at = (iso: string) => new Date(iso);

  it("due from Monday 08:00 local when the owners were last told more than a day before", () => {
    expect(stopReminderDue(at("2026-10-12T06:30:00Z"), ZONE, at("2026-10-09T10:00:00Z"))).toEqual({ week: "2026-W42" });
    // 07:59 local: not yet.
    expect(stopReminderDue(at("2026-10-12T05:59:00Z"), ZONE, at("2026-10-09T10:00:00Z"))).toBeNull();
  });

  it("not hours after the first notice: told on Sunday evening, nothing on Monday morning", () => {
    expect(stopReminderDue(at("2026-10-12T06:30:00Z"), ZONE, at("2026-10-11T20:00:00Z"))).toBeNull();
    // The next Monday it is.
    expect(stopReminderDue(at("2026-10-19T06:30:00Z"), ZONE, at("2026-10-11T20:00:00Z"))).toEqual({ week: "2026-W43" });
  });

  it("once a week: a reminder sent this Monday holds until the next", () => {
    expect(stopReminderDue(at("2026-10-12T09:00:00Z"), ZONE, at("2026-10-12T06:05:00Z"))).toBeNull();
    expect(stopReminderDue(at("2026-10-18T20:00:00Z"), ZONE, at("2026-10-12T06:05:00Z"))).toBeNull();
  });

  it("a week whose Monday the job missed still gets its reminder later that week", () => {
    expect(stopReminderDue(at("2026-10-15T12:00:00Z"), ZONE, at("2026-10-09T10:00:00Z"))).toEqual({ week: "2026-W42" });
  });

  it("08:00 on the wall clock across the change to winter time", () => {
    // Monday 26 October: 08:00 Stockholm is 07:00Z.
    expect(stopReminderDue(at("2026-10-26T06:30:00Z"), ZONE, at("2026-10-20T10:00:00Z"))).toBeNull();
    expect(stopReminderDue(at("2026-10-26T07:05:00Z"), ZONE, at("2026-10-20T10:00:00Z"))).toEqual({ week: "2026-W44" });
  });
});

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
