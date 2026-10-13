import { describe, expect, it } from "vitest";

import { fileConnectionBody, isFileId, voucherBody } from "./body";
import type { FortnoxVoucherDraft } from "./types";

/**
 * WHAT THE NIGHTLY SEND SENDS (slice 114b): a voucher's amounts reach Fortnox
 * EXACTLY as the bookkeeping file froze them — to the öre, never through a
 * float — positive a debit, negative a credit; our marker in the comment; and
 * anything out of shape is refused before a byte is sent.
 */

const draft = (rows: FortnoxVoucherDraft["rows"], extra: Partial<FortnoxVoucherDraft> = {}): FortnoxVoucherDraft => ({
  series: "F",
  date: "2026-10-12",
  description: "Betalning faktura 1001 Kund AB",
  comments: "Fortleva 01920000-0000-7000-8000-000000000001",
  rows,
  ...extra,
});

describe("voucherBody", () => {
  it("writes each amount as written — a debit or a credit, the other side 0 — and the marker", () => {
    const body = voucherBody(
      draft([
        { account: "1930", amount: "1250.00" },
        { account: "3001", amount: "-1000.00" },
        { account: "2611", amount: "-250.00" },
      ]),
    );
    expect(body).toBe(
      '{"Voucher":{"Description":"Betalning faktura 1001 Kund AB","Comments":"Fortleva 01920000-0000-7000-8000-000000000001",' +
        '"TransactionDate":"2026-10-12","VoucherSeries":"F","VoucherRows":[' +
        '{"Account":1930,"Debit":1250.00,"Credit":0},{"Account":3001,"Debit":0,"Credit":1000.00},{"Account":2611,"Debit":0,"Credit":250.00}]}}',
    );
    // Valid JSON, and the numbers read back exactly.
    const parsed = JSON.parse(body) as { Voucher: { VoucherRows: { Debit: number; Credit: number }[] } };
    expect(parsed.Voucher.VoucherRows.map((r) => r.Debit - r.Credit)).toEqual([1250, -1000, -250]);
  });

  it("keeps an amount no float can hold, digit for digit", () => {
    const body = voucherBody(
      draft([
        { account: "1510", amount: "123456789012345.67" },
        { account: "3001", amount: "-123456789012345.67" },
      ]),
    );
    expect(body).toContain('"Debit":123456789012345.67');
    expect(body).toContain('"Credit":123456789012345.67');
  });

  it("drops a leading zero a JSON number may not have, and keeps 0.50", () => {
    const body = voucherBody(
      draft([
        { account: "1930", amount: "007.50" },
        { account: "3740", amount: "-0.50" },
        { account: "3001", amount: "-7.00" },
      ]),
    );
    expect(body).toContain('{"Account":1930,"Debit":7.50,"Credit":0}');
    expect(body).toContain('{"Account":3740,"Debit":0,"Credit":0.50}');
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it("puts text through JSON — a quote or a backslash never breaks out", () => {
    const body = voucherBody(draft([{ account: "1930", amount: "1.00" }, { account: "3001", amount: "-1.00" }], { description: 'A "quoted" \\ name' }));
    expect((JSON.parse(body) as { Voucher: { Description: string } }).Voucher.Description).toBe('A "quoted" \\ name');
  });

  it("refuses, before anything is sent, a voucher out of shape", () => {
    const ok = [{ account: "1930", amount: "1.00" }, { account: "3001", amount: "-1.00" }];
    const refused = (d: FortnoxVoucherDraft) => expect(() => voucherBody(d)).toThrow(/shape/);
    refused(draft([{ account: "1930", amount: "1.00" }, { account: "3001", amount: "-2.00" }])); // does not balance
    refused(draft([{ account: "1930", amount: "0.00" }])); // a row of nothing
    refused(draft([])); // no rows
    refused(draft([{ account: "193", amount: "1.00" }, { account: "3001", amount: "-1.00" }])); // three digits
    refused(draft([{ account: "0930", amount: "1.00" }, { account: "3001", amount: "-1.00" }])); // a leading zero
    refused(draft([{ account: "1930", amount: "1.5" }, { account: "3001", amount: "-1.5" }])); // not to the öre
    refused(draft([{ account: "1930", amount: "1e2" }, { account: "3001", amount: "-1e2" }]));
    refused(draft(ok, { series: "f" }));
    refused(draft(ok, { series: "F/../x" }));
    refused(draft(ok, { date: "12/10/2026" }));
    refused(draft(ok, { description: "" }));
    refused(draft(ok, { description: "x".repeat(201) }));
    refused(draft(ok, { comments: "x".repeat(1001) }));
  });
});

describe("fileConnectionBody", () => {
  it("names the file, the series, and the number as a string", () => {
    expect(JSON.parse(fileConnectionBody("a1b2-c3", "F", 12))).toEqual({ VoucherFileConnection: { FileId: "a1b2-c3", VoucherNumber: "12", VoucherSeries: "F" } });
  });

  it("refuses an id or a voucher out of shape", () => {
    expect(() => fileConnectionBody("a/../b", "F", 1)).toThrow(/shape/);
    expect(() => fileConnectionBody("abc", "F", 0)).toThrow(/shape/);
    expect(() => fileConnectionBody("abc", "F;", 1)).toThrow(/shape/);
    expect(isFileId("0b1c-ABC")).toBe(true);
    expect(isFileId("x".repeat(65))).toBe(false);
    expect(isFileId(12)).toBe(false);
  });
});
