import { describe, expect, it } from "vitest";

import { LIST_COLUMNS, listColumns, listRow, type ListedEntry, type ListWords } from "./invoice-list";

const words: ListWords = {
  headers: Object.fromEntries(LIST_COLUMNS.map((c) => [c, c.toUpperCase()])) as ListWords["headers"],
  events: { ISSUE: "Issued", PAYMENT: "Payment", PAYMENT_UNDONE: "Payment undone", CREDIT_NOTED: "Credit note noted" },
  invoice: "Invoice",
  creditNote: "Credit note",
  treatments: { SE_DOMESTIC: "Swedish VAT", EU_REVERSE_CHARGE: "Reverse charge", OUTSIDE_SCOPE: "Outside the EU" },
  remark: (r) => (r.file === undefined ? r.kind : `${r.kind} ${r.day} #${r.file}`),
};

const payment: ListedEntry = {
  event: "PAYMENT",
  bookedOn: "2026-10-20",
  kind: "INVOICE",
  displayNumber: "10002",
  relates: ["10004", "10006"],
  issueDate: "2026-10-09",
  dueDate: "2026-11-08",
  clientName: "Globex Inc",
  clientOrgNr: null,
  clientVatNumber: null,
  clientCountry: "US",
  vatProfile: "OUTSIDE_SCOPE",
  currency: "USD",
  bookRate: "10.007062",
  amounts: { net: "1234.56", vat: "0.00", total: "1234.56", netSek: "12354.32", vatSek: "0.00", totalSek: "12354.32" },
  remark: null,
};

const row = (e: ListedEntry) => Object.fromEntries(LIST_COLUMNS.map((c, i) => [c, listRow(e, words)[i]]));

describe("the bookkeeping list", () => {
  it("has one typed column per field", () => {
    const cols = listColumns(words);
    expect(cols.map((c) => c.header)).toEqual(LIST_COLUMNS.map((c) => c.toUpperCase()));
    expect(cols.find((c) => c.header === "NETSEK")?.kind).toBe("money");
    expect(cols.find((c) => c.header === "BOOKRATE")?.kind).toBe("rate");
    expect(cols.find((c) => c.header === "BOOKEDON")?.kind).toBe("date");
  });

  it("states what was booked, from which document, in its currency and in kronor", () => {
    expect(row(payment)).toMatchObject({
      entry: "Payment",
      bookedOn: "2026-10-20",
      number: "10002",
      type: "Invoice",
      relates: "10004, 10006",
      vatTreatment: "Outside the EU",
      currency: "USD",
      total: "1234.56",
      bookRate: "10.007062",
      totalSek: "12354.32",
      remark: null,
    });
  });

  it("says why a row books nothing", () => {
    const noted: ListedEntry = {
      ...payment,
      event: "CREDIT_NOTED",
      kind: "CREDIT_NOTE",
      displayNumber: "10007",
      relates: ["10002"],
      amounts: { net: "-100.00", vat: "0.00", total: "-100.00", netSek: "-1000.71", vatSek: "0.00", totalSek: "-1000.71" },
      remark: { kind: "deducted", day: "2026-10-20", file: 3 },
    };
    expect(row(noted)).toMatchObject({ entry: "Credit note noted", type: "Credit note", relates: "10002", total: "-100.00", remark: "deducted 2026-10-20 #3" });
    expect(row({ ...noted, remark: { kind: "afterPayment" } }).remark).toBe("afterPayment");
  });
});
