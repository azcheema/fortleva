import type { XlsxCell, XlsxColumn } from "@/lib/xlsx";

import type { VatProfile } from "./vat";

/**
 * THE LIST BESIDE THE BOOKKEEPING FILE (Phase 4 slice 111; founder decision
 * C82 (a)) — one row per event the file records, to check the import against:
 * what was booked (or why nothing was), the document it comes from, and the
 * amounts in its currency and in kronor, SIGNED as booked (a credit note's and
 * a reversal's negative — as its PDF prints a credit note, C77 (a)). Only
 * FROZEN facts — the issued documents and what the file's own record froze —
 * so a re-download is the same list. The client's name, numbers and country
 * are the invoice's snapshot, never the live client (the design review's L9);
 * the VAT-number column is the EU sales list's source (L12).
 */

export const LIST_EVENTS = [
  "ISSUE",
  "PAYMENT",
  "PAYMENT_UNDONE",
  "CREDIT_NOTED",
  // The cash method's year end (slice 111b; C83).
  "YEAR_END",
  "YEAR_END_REVERSED",
  "YEAR_END_UNDONE",
  "YEAR_END_REVERSAL_UNDONE",
] as const;
export type ListEvent = (typeof LIST_EVENTS)[number];

/**
 * Why a row books nothing, what a credit note in a cash-method file means
 * (the re-check's 2: from the FROZEN record — "deducted" only when a booked,
 * not undone, payment names it), and what a reversal reverses (its 3) — and
 * for the year end (slice 111b): which year end a reversal reverses, why one
 * was withdrawn (the payment's day), and which reversal went with it.
 */
export const LIST_REMARKS = [
  "nothing",
  "deducted",
  "afterPayment",
  "unpaid",
  "creditedUnpaid",
  "reverses",
  "reversesYearEnd",
  "paidByYearEnd",
  "paidInBooks",
  "undoesReversal",
] as const;
export type ListRemarkKind = (typeof LIST_REMARKS)[number];

/** A remark, with the payment it refers to where it names one: its day and its file. */
export type ListRemark = {
  readonly kind: ListRemarkKind;
  /** `YYYY-MM-DD`. */
  readonly day?: string;
  readonly file?: number;
};

/** Decimal texts, signed as booked. */
export type ListAmounts = {
  readonly net: string;
  readonly vat: string;
  readonly total: string;
  readonly netSek: string;
  readonly vatSek: string;
  readonly totalSek: string;
};

export type ListedEntry = {
  readonly event: ListEvent;
  /** `YYYY-MM-DD` — the day booked (or, for a credit note only noted, its date). */
  readonly bookedOn: string;
  readonly kind: "INVOICE" | "CREDIT_NOTE";
  readonly displayNumber: string;
  /** A credit note: the invoice it credits; a payment: the credit notes deducted. */
  readonly relates: readonly string[];
  readonly issueDate: string;
  readonly dueDate: string;
  readonly clientName: string;
  readonly clientOrgNr: string | null;
  readonly clientVatNumber: string | null;
  readonly clientCountry: string | null;
  readonly vatProfile: VatProfile;
  readonly currency: string;
  /** The booking rate as stored ("10.007062"), null on SEK. */
  readonly bookRate: string | null;
  readonly amounts: ListAmounts;
  readonly remark: ListRemark | null;
};

export const LIST_COLUMNS = [
  "entry",
  "bookedOn",
  "number",
  "type",
  "relates",
  "date",
  "due",
  "client",
  "orgNr",
  "vatNumber",
  "country",
  "vatTreatment",
  "currency",
  "net",
  "vat",
  "total",
  "bookRate",
  "netSek",
  "vatSek",
  "totalSek",
  "remark",
] as const;
export type ListColumn = (typeof LIST_COLUMNS)[number];

const KIND: Readonly<Record<ListColumn, XlsxColumn["kind"]>> = {
  entry: "text",
  bookedOn: "date",
  number: "integer",
  type: "text",
  relates: "text",
  date: "date",
  due: "date",
  client: "text",
  orgNr: "text",
  vatNumber: "text",
  country: "text",
  vatTreatment: "text",
  currency: "text",
  net: "money",
  vat: "money",
  total: "money",
  bookRate: "rate",
  netSek: "money",
  vatSek: "money",
  totalSek: "money",
  remark: "text",
};

const WIDTH: Partial<Record<ListColumn, number>> = {
  entry: 18,
  type: 14,
  relates: 14,
  client: 32,
  vatTreatment: 22,
  country: 8,
  currency: 9,
  remark: 40,
};

/** The words a list is written in — the downloading member's language. */
export type ListWords = {
  readonly headers: Readonly<Record<ListColumn, string>>;
  readonly events: Readonly<Record<ListEvent, string>>;
  readonly invoice: string;
  readonly creditNote: string;
  readonly treatments: Readonly<Record<VatProfile, string>>;
  /** A remark's text — `day` and `file` given where it names a payment. */
  readonly remark: (remark: ListRemark) => string;
};

export function listColumns(words: ListWords): XlsxColumn[] {
  return LIST_COLUMNS.map((c) => ({ header: words.headers[c], kind: KIND[c], ...(WIDTH[c] ? { width: WIDTH[c] } : {}) }));
}

/** A plain number as an integer cell; anything else empty (never guessed). */
const numberCell = (n: string): XlsxCell => (/^\d{1,15}$/.test(n) ? n : null);

export function listRow(e: ListedEntry, words: ListWords): XlsxCell[] {
  const cells: Record<ListColumn, XlsxCell> = {
    entry: words.events[e.event],
    bookedOn: e.bookedOn,
    number: numberCell(e.displayNumber),
    type: e.kind === "CREDIT_NOTE" ? words.creditNote : words.invoice,
    relates: e.relates.length > 0 ? e.relates.join(", ") : null,
    date: e.issueDate,
    due: e.dueDate,
    client: e.clientName,
    orgNr: e.clientOrgNr,
    vatNumber: e.clientVatNumber,
    country: e.clientCountry,
    vatTreatment: words.treatments[e.vatProfile],
    currency: e.currency,
    net: e.amounts.net,
    vat: e.amounts.vat,
    total: e.amounts.total,
    bookRate: e.bookRate,
    netSek: e.amounts.netSek,
    vatSek: e.amounts.vatSek,
    totalSek: e.amounts.totalSek,
    remark: e.remark === null ? null : words.remark(e.remark),
  };
  return LIST_COLUMNS.map((c) => cells[c]);
}
