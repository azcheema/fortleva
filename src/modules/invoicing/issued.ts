import { decryptFieldV2 } from "@/crypto/field-encryption";
import type { TenantDb } from "@/db";

import type { InvoiceLineView } from "./drafts";
import { vatGroupsInSek } from "./fx";
import { invoiceTotals, readFixed } from "./money";
import { isInvoiceLocale, isoDay, type BuyerPrint, type InvoicePrint, type PaymentPrint, type SellerPrint } from "./print";
import { bankEncryptionContext, isUnreadableCiphertext } from "./seller";
import { isVatProfile } from "./vat";

/**
 * AN ISSUED INVOICE, READ FROM ITS FROZEN RECORD (Phase 4 slice 108) — the
 * snapshots the issue guard wrote, the stored dates, totals and rate, and the
 * lines as they were. Never the live tenant or client. The PDF and the issued
 * invoice's page both draw from what this returns.
 *
 * THE BANK DETAILS are the tenant's v2 ciphertexts, copied at issue; they
 * decrypt under the TENANT row's context (`tenantId:tenant:<tenantId>:<field>`),
 * which is what they were written under. Two modes:
 *   - `strict` (the PDF — the archived record, made ONCE): any failure to read
 *     a snapshot or decrypt a bank detail throws, so a PDF is never drawn
 *     without them (the design review's medium: set-once would make a degraded
 *     drawing the record forever);
 *   - tolerant (the page): an unreadable value reads as missing and the page
 *     says so; a missing tenant key is an outage and still throws.
 */

const LINE_SELECT = {
  id: true,
  position: true,
  description: true,
  quantity: true,
  unit: true,
  unitPriceExVat: true,
  vatRatePct: true,
  amountExVat: true,
} as const;

export class SnapshotUnreadable extends Error {
  constructor(what: string) {
    super(`issued invoice: ${what} is unreadable`);
    this.name = "SnapshotUnreadable";
  }
}

type Obj = Readonly<Record<string, unknown>>;

const asObject = (v: unknown, what: string): Obj => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new SnapshotUnreadable(what);
  return v as Obj;
};

const optional = (o: Obj, key: string, what: string): string | null => {
  const v = o[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new SnapshotUnreadable(`${what}.${key}`);
  return v;
};

const required = (o: Obj, key: string, what: string): string => {
  const v = optional(o, key, what);
  if (v === null) throw new SnapshotUnreadable(`${what}.${key}`);
  return v;
};

export function readSellerSnapshot(raw: unknown): SellerPrint {
  const o = asObject(raw, "seller");
  const fSkatt = o["fSkattApproved"];
  if (typeof fSkatt !== "boolean") throw new SnapshotUnreadable("seller.fSkattApproved");
  return {
    legalName: required(o, "legalName", "seller"),
    orgNr: required(o, "orgNr", "seller"),
    vatNumber: required(o, "vatNumber", "seller"),
    seat: optional(o, "seat", "seller"),
    fSkattApproved: fSkatt,
    addressLine1: required(o, "addressLine1", "seller"),
    addressLine2: optional(o, "addressLine2", "seller"),
    postalCode: required(o, "postalCode", "seller"),
    city: required(o, "city", "seller"),
    countryCode: optional(o, "countryCode", "seller"),
    footerNote: optional(o, "footerNote", "seller"),
  };
}

export function readBuyerSnapshot(raw: unknown): BuyerPrint {
  const o = asObject(raw, "buyer");
  return {
    name: required(o, "name", "buyer"),
    orgNr: optional(o, "orgNr", "buyer"),
    vatNumber: optional(o, "vatNumber", "buyer"),
    addressLine1: optional(o, "addressLine1", "buyer"),
    addressLine2: optional(o, "addressLine2", "buyer"),
    postalCode: optional(o, "postalCode", "buyer"),
    city: optional(o, "city", "buyer"),
    countryCode: optional(o, "countryCode", "buyer"),
  };
}

const PAYMENT_KEYS = ["bankgiro", "plusgiro", "iban", "bic"] as const;

/** The bank details as printed: decrypted under the tenant row's context. */
export async function readPaymentSnapshot(
  tx: TenantDb,
  tenantId: string,
  raw: unknown,
  strict: boolean,
): Promise<{ payment: PaymentPrint; unreadable: boolean }> {
  const o = asObject(raw, "payment");
  const out: Record<(typeof PAYMENT_KEYS)[number], string | null> = { bankgiro: null, plusgiro: null, iban: null, bic: null };
  let unreadable = false;
  // In sequence: one transaction, one connection (AGENTS.md's trap).
  for (const key of PAYMENT_KEYS) {
    const ciphertext = optional(o, key, "payment");
    if (ciphertext === null) continue;
    try {
      out[key] = await decryptFieldV2(tx, bankEncryptionContext(tenantId, key), ciphertext);
    } catch (e) {
      if (strict || !isUnreadableCiphertext(e)) throw strict ? new SnapshotUnreadable(`payment.${key}`) : e;
      unreadable = true;
    }
  }
  if (strict && out.bankgiro === null && out.plusgiro === null && out.iban === null) {
    // The guard refused an issue with no way to pay; a record without one is corrupt.
    throw new SnapshotUnreadable("payment");
  }
  return { payment: out, unreadable };
}

export type IssuedInvoice = {
  readonly print: InvoicePrint;
  readonly issuedAt: Date;
  readonly issuedByMemberId: string;
  readonly pdfFileId: string | null;
  /** Tolerant mode only: a bank detail that could not be read. */
  readonly paymentUnreadable: boolean;
};

/**
 * One issued invoice, from its frozen record — the caller has checked who may
 * read it. Null when the invoice is not issued (or not visible here).
 */
export async function readIssuedInvoice(
  tx: TenantDb,
  tenantId: string,
  invoiceId: string,
  opts: { readonly strict: boolean },
): Promise<IssuedInvoice | null> {
  const row = await tx.invoice.findFirst({
    where: { id: invoiceId, status: { not: "DRAFT" } },
    select: {
      kind: true,
      creditReason: true,
      creditsDisplayNumber: true,
      creditsIssueDate: true,
      locale: true,
      displayNumber: true,
      issueDate: true,
      dueDate: true,
      paymentTermsDays: true,
      periodStart: true,
      periodEnd: true,
      buyerReference: true,
      ourReference: true,
      note: true,
      vatProfile: true,
      currency: true,
      subtotalExVat: true,
      vatTotal: true,
      total: true,
      fxRateToSek: true,
      fxRateDate: true,
      vatTotalSek: true,
      sellerSnapshot: true,
      paymentSnapshot: true,
      buyerSnapshot: true,
      issuedAt: true,
      issuedByMemberId: true,
      pdfFileId: true,
    },
  });
  if (!row) return null;
  if (
    !row.displayNumber ||
    !row.issueDate ||
    !row.dueDate ||
    !row.issuedAt ||
    !row.issuedByMemberId ||
    !isInvoiceLocale(row.locale) ||
    !isVatProfile(row.vatProfile) ||
    row.subtotalExVat === null ||
    row.vatTotal === null ||
    row.total === null
  ) {
    throw new SnapshotUnreadable("issued facts");
  }
  const lines: InvoiceLineView[] = (
    await tx.invoiceLine.findMany({ where: { invoiceId }, orderBy: [{ position: "asc" }, { id: "asc" }], select: LINE_SELECT })
  ).map((l) => ({
    id: l.id,
    position: l.position,
    description: l.description,
    quantity: readFixed(l.quantity, 3),
    unit: l.unit,
    unitPrice: readFixed(l.unitPriceExVat, 2),
    vatRate: readFixed(l.vatRatePct, 2),
    amount: readFixed(l.amountExVat, 2),
  }));
  // The totals from the frozen lines, checked against the stored ones (the
  // guard made them equal at issue; a difference is a corrupt record).
  const totals = invoiceTotals(lines.map((l) => ({ amount: l.amount, rate: l.vatRate })));
  if (
    totals.subtotal !== readFixed(row.subtotalExVat, 2) ||
    totals.vatTotal !== readFixed(row.vatTotal, 2) ||
    totals.total !== readFixed(row.total, 2)
  ) {
    throw new SnapshotUnreadable("totals");
  }
  let sekVat: InvoicePrint["sekVat"] = null;
  if (row.fxRateToSek !== null && row.fxRateDate !== null && row.vatTotalSek !== null) {
    const micros = readFixed(row.fxRateToSek, 6);
    const sek = vatGroupsInSek(totals.groups, micros);
    if (sek.totalSek !== readFixed(row.vatTotalSek, 2)) throw new SnapshotUnreadable("vat in SEK");
    sekVat = { micros, date: isoDay(row.fxRateDate), groups: sek.groups, totalSek: sek.totalSek };
  }
  const seller = readSellerSnapshot(row.sellerSnapshot);
  const buyer = readBuyerSnapshot(row.buyerSnapshot);
  // A CREDIT NOTE (slice 108b) asks no one to pay: its payment snapshot is
  // '{}' (the guard writes it) and nothing is decrypted. It says what it
  // credits — the original's number and date, written into its own record by
  // the guard — and why; a credit note missing either is a corrupt record.
  const credit = row.kind === "CREDIT_NOTE";
  if (credit && (!row.creditsDisplayNumber || !row.creditsIssueDate || !row.creditReason)) {
    throw new SnapshotUnreadable("credit note's reference");
  }
  const { payment, unreadable } = credit
    ? { payment: { bankgiro: null, plusgiro: null, iban: null, bic: null }, unreadable: false }
    : await readPaymentSnapshot(tx, tenantId, row.paymentSnapshot, opts.strict);
  return {
    print: {
      kind: row.kind,
      credits: credit ? { displayNumber: row.creditsDisplayNumber!, issueDate: isoDay(row.creditsIssueDate!) } : null,
      creditReason: credit ? row.creditReason : null,
      locale: row.locale,
      displayNumber: row.displayNumber,
      issueDate: isoDay(row.issueDate),
      dueDate: isoDay(row.dueDate),
      paymentTermsDays: row.paymentTermsDays,
      periodStart: row.periodStart ? isoDay(row.periodStart) : null,
      periodEnd: row.periodEnd ? isoDay(row.periodEnd) : null,
      buyerReference: row.buyerReference,
      ourReference: row.ourReference,
      note: row.note,
      vatProfile: row.vatProfile,
      currency: row.currency,
      lines,
      totals,
      sekVat,
      seller,
      buyer,
      payment,
    },
    issuedAt: row.issuedAt,
    issuedByMemberId: row.issuedByMemberId,
    pdfFileId: row.pdfFileId,
    paymentUnreadable: unreadable,
  };
}
