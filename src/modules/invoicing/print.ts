import type { InvoiceLineView } from "./drafts";
import type { HoursPagePrint } from "./hours-page";
import { formatFixed, type InvoiceTotals, type Minor, type VatGroup } from "./money";
import type { VatProfile } from "./vat";

/**
 * AN ISSUED INVOICE AS PRINTED (Phase 4 slice 108) — the one shape the PDF and
 * the issued invoice's page both draw from, built from the FROZEN record only:
 * the snapshots the issue guard wrote, the stored dates and totals, the lines
 * as they were (an issued invoice's lines never change). Nothing here is read
 * live from the tenant or the client: what was issued is what is shown.
 *
 * The formatting below is pure and exact — amounts go to `Intl.NumberFormat`
 * as decimal STRINGS (never a float), dates are the stored `YYYY-MM-DD` in
 * both languages, and it depends on the INVOICE's language, never the
 * reader's (a Swedish member looking at an English invoice sees English).
 */

export type InvoiceLocale = "sv" | "en";

export const isInvoiceLocale = (v: unknown): v is InvoiceLocale => v === "sv" || v === "en";

/**
 * The language a client's invoices are printed in (founder decision C76 (e)):
 * the client's own choice, or — blank — Swedish for a Swedish client (or one
 * with no country) and English for everyone else. A draft may override it;
 * issuing fixes it. (A stored value from before slice 108, when the field was
 * free text, counts by its first two letters, else as blank.)
 */
export function invoiceLocaleFor(client: { readonly invoiceLocale: string | null; readonly countryCode: string | null }): InvoiceLocale {
  const chosen = client.invoiceLocale?.trim().toLowerCase().slice(0, 2);
  if (isInvoiceLocale(chosen)) return chosen;
  const country = client.countryCode?.trim().toUpperCase() || null;
  return country === null || country === "SE" ? "sv" : "en";
}

export type SellerPrint = {
  readonly legalName: string;
  readonly orgNr: string;
  readonly vatNumber: string;
  readonly seat: string | null;
  readonly fSkattApproved: boolean;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly postalCode: string;
  readonly city: string;
  readonly countryCode: string | null;
  readonly footerNote: string | null;
};

export type BuyerPrint = {
  readonly name: string;
  readonly orgNr: string | null;
  readonly vatNumber: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly countryCode: string | null;
};

export type PaymentPrint = {
  readonly bankgiro: string | null;
  readonly plusgiro: string | null;
  readonly iban: string | null;
  readonly bic: string | null;
};

export type SekVat = {
  /** SEK per one unit of the invoice's currency, in millionths. */
  readonly micros: bigint;
  /** The ECB file's date, `YYYY-MM-DD`. */
  readonly date: string;
  readonly groups: readonly (VatGroup & { readonly vatSek: Minor })[];
  readonly totalSek: Minor;
};

/** What a credit note credits (slice 108b): ML's unambiguous reference to the original. */
export type CreditsPrint = {
  readonly displayNumber: string;
  /** The original's invoice date, `YYYY-MM-DD`. */
  readonly issueDate: string;
};

export type InvoicePrint = {
  readonly kind: "INVOICE" | "CREDIT_NOTE";
  /** A credit note: the invoice it credits, and why (C77 (b)). Null on an invoice. */
  readonly credits: CreditsPrint | null;
  readonly creditReason: string | null;
  readonly locale: InvoiceLocale;
  readonly displayNumber: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly paymentTermsDays: number;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly buyerReference: string | null;
  readonly ourReference: string | null;
  readonly note: string | null;
  readonly vatProfile: VatProfile;
  readonly currency: string;
  readonly lines: readonly InvoiceLineView[];
  readonly totals: InvoiceTotals;
  readonly sekVat: SekVat | null;
  readonly seller: SellerPrint;
  readonly buyer: BuyerPrint;
  readonly payment: PaymentPrint;
  /** Slice 110b (C80 (d), C81): the time breakdown page, as the database froze it at issue — an INVOICE's, when ticked. */
  readonly hoursPage: HoursPagePrint | null;
};

/**
 * THE ONE SIGN RULE (slice 108b; C77 (a)). A credit note is STORED with
 * positive quantities and amounts, as an invoice is (EN 16931's credit note);
 * it PRINTS them with a minus sign — "Att betala: −1 250,00" — and its
 * quantities too, so every line still reads quantity × price = amount. Unit
 * prices and rates print as stored. Everything that shows a credit note's
 * amounts (the PDF, its page, the list) goes through this.
 */
export const signed = (value: bigint, kind: InvoicePrint["kind"]): bigint => (kind === "CREDIT_NOTE" ? -value : value);

const intlTag = (locale: InvoiceLocale): string => (locale === "sv" ? "sv-SE" : "en-GB");

/** A `@db.Date` (UTC midnight) as `YYYY-MM-DD`. */
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** An integer of `scale` decimals, formatted exactly in the invoice's language. */
function decimal(value: bigint, scale: number, locale: InvoiceLocale, minDigits: number, maxDigits: number): string {
  const text = formatFixed(value, scale) as Intl.StringNumericLiteral;
  return new Intl.NumberFormat(intlTag(locale), {
    minimumFractionDigits: minDigits,
    maximumFractionDigits: maxDigits,
  }).format(text);
}

/** Hundredths as an amount: "12 345,67" / "12,345.67". */
export const printAmount = (minor: Minor, locale: InvoiceLocale): string => decimal(minor, 2, locale, 2, 2);

/** Thousandths as a quantity, its trailing zeros dropped: "1,5" / "1.5". */
export const printQuantity = (milli: bigint, locale: InvoiceLocale): string => decimal(milli, 3, locale, 0, 3);

/** Hundredths of a percent as a percent: "25" / "12" / "6" / "0". */
export const printRate = (hundredths: bigint, locale: InvoiceLocale): string => decimal(hundredths, 2, locale, 0, 2);

/** Millionths as an exchange rate, at least four decimals: "11,1940". */
export const printFxRate = (micros: bigint, locale: InvoiceLocale): string => decimal(micros, 6, locale, 4, 6);

/** A country's name in the invoice's language; the code itself if the runtime does not know it. */
export function printCountry(code: string | null, locale: InvoiceLocale): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames([intlTag(locale)], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * A party's address as printed lines: street, second line, postal code and
 * city, and the country — named only when it is not the seller's own (a
 * Swedish invoice to a Swedish client does not say "Sweden").
 */
export function printAddress(
  party: {
    readonly addressLine1: string | null;
    readonly addressLine2: string | null;
    readonly postalCode: string | null;
    readonly city: string | null;
    readonly countryCode: string | null;
  },
  locale: InvoiceLocale,
  homeCountry: string | null,
): string[] {
  const lines = [party.addressLine1, party.addressLine2, [party.postalCode, party.city].filter(Boolean).join(" ")];
  const home = (homeCountry ?? "SE").toUpperCase();
  if (party.countryCode && party.countryCode.toUpperCase() !== home) lines.push(printCountry(party.countryCode, locale));
  return lines.filter((l): l is string => Boolean(l && l.trim()));
}
