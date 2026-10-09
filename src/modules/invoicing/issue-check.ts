import { addDays } from "@/lib/week";

import { needsSekVat } from "./fx";
import type { InvoiceTotals } from "./money";
import { invoiceLocaleFor, type InvoiceLocale } from "./print";
import type { CompanyDetails, MissingDetail, PaymentDetails } from "./seller";
import { isAktiebolagOrgNr } from "./seller-fields";
import type { Numbering } from "./series";
import { EU_COUNTRIES, type VatProfile } from "./vat";

/**
 * WHAT ISSUING NEEDS (Phase 4 slice 108) — pure, no database, so the unit
 * suite holds it and the issue dialog, the issue itself and the settings
 * page all ask the same question. The issue guard (migration 20261009200000)
 * restates every rule here; a rule added here and not there (or there and not
 * here) is a refusal the member reads as a bug.
 */

/**
 * What issuing needs of the workspace (slice 108's `checkIssue`; the issue
 * guard restates it). The registered office ("säte") is required of an
 * aktiebolag (ABL 28 kap. 5 §), not of a sole trader — so only when the org.
 * number is a company's whose group digit says aktiebolag (the design review's
 * nit). And a first invoice number (C76 (b)).
 */
export function missingForIssue(
  company: CompanyDetails,
  payment: PaymentDetails,
  hasNumbering: boolean,
  paymentUnreadable = false,
): MissingDetail[] {
  const missing: MissingDetail[] = [];
  if (!hasNumbering) missing.push("numbering");
  if (!company.legalName) missing.push("legalName");
  if (!company.orgNr) missing.push("orgNr");
  if (!company.vatNumber) missing.push("vatNumber");
  if (!company.seat && company.orgNr && isAktiebolagOrgNr(company.orgNr)) missing.push("seat");
  if (!company.addressLine1 || !company.postalCode || !company.city) missing.push("address");
  if (!payment.bankgiro && !payment.plusgiro && !payment.iban) missing.push("payment");
  // A bank detail stored but unreadable would be copied into the invoice and
  // stop its PDF for good — re-entering it fixes it (the migration review's low).
  if (paymentUnreadable) missing.push("paymentUnreadable");
  return missing;
}

export type IssueBlocker =
  /** The workspace's details or numbering (Settings → Invoicing); `missing` names which. */
  | "seller"
  | "clientAddress"
  | "clientCountry"
  | "clientVatNumber"
  | "clientVatCountry"
  | "clientInEu"
  | "noLines"
  | "negativeTotal";

export type IssueCheck = {
  readonly blockers: readonly IssueBlocker[];
  /** What Settings → Invoicing still lacks, numbering included. */
  readonly sellerMissing: readonly MissingDetail[];
  /** The number it would take now — another issue first takes it. */
  readonly nextNumber: number | null;
  /** `YYYY-MM-DD`, the workspace's today. */
  readonly issueDate: string;
  readonly dueDate: string;
  readonly needsFx: boolean;
  readonly locale: InvoiceLocale;
  /** No work period: the invoice's date will read as the date of the work (the design review's low). */
  readonly noPeriod: boolean;
};

export type IssueClient = {
  readonly name: string;
  readonly addressLine1: string | null;
  readonly city: string | null;
  readonly countryCode: string | null;
  readonly vatNumber: string | null;
  readonly invoiceLocale: string | null;
};

const nonBlank = (s: string | null | undefined): boolean => Boolean(s && /\S/.test(s));

/** The VAT prefix a member state's numbers carry — Greece's is EL. */
const vatPrefixOf = (country: string): string => (country === "GR" ? "EL" : country);

/**
 * The client-side reasons an invoice cannot be issued — the same rules the
 * guard restates (name and address; a country unless domestic; a reverse
 * charge to a business in ANOTHER member state whose VAT number carries that
 * state's prefix; outside the scope only to a buyer outside the EU).
 */
export function clientBlockers(client: IssueClient, profile: VatProfile): IssueBlocker[] {
  const out: IssueBlocker[] = [];
  if (!nonBlank(client.addressLine1) || !nonBlank(client.city)) out.push("clientAddress");
  const country = client.countryCode?.trim().toUpperCase() || null;
  if (profile !== "SE_DOMESTIC" && country === null) out.push("clientCountry");
  if (profile === "EU_REVERSE_CHARGE") {
    if (!nonBlank(client.vatNumber)) out.push("clientVatNumber");
    else if (country !== null) {
      const prefix = client.vatNumber!.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 2);
      if (!EU_COUNTRIES.has(country) || country === "SE" || prefix !== vatPrefixOf(country)) out.push("clientVatCountry");
    }
  }
  if (profile === "OUTSIDE_SCOPE" && country !== null && EU_COUNTRIES.has(country)) out.push("clientInEu");
  return out;
}

/** Everything issuing needs, and what it would give — pure, for the dialog and the issue alike. */
export function checkIssue(input: {
  readonly company: CompanyDetails;
  readonly payment: PaymentDetails;
  /** A bank detail is stored but cannot be decrypted (`readSeller`'s `unreadable`). */
  readonly paymentUnreadable?: boolean;
  readonly numbering: Numbering | null;
  readonly client: IssueClient;
  readonly vatProfile: VatProfile;
  readonly currency: string;
  readonly lineCount: number;
  readonly totals: InvoiceTotals;
  readonly paymentTermsDays: number;
  readonly locale: InvoiceLocale | null;
  readonly hasPeriod: boolean;
  readonly today: string;
}): IssueCheck {
  const sellerMissing = missingForIssue(input.company, input.payment, input.numbering !== null, input.paymentUnreadable ?? false);
  const blockers: IssueBlocker[] = [];
  if (sellerMissing.length > 0) blockers.push("seller");
  blockers.push(...clientBlockers(input.client, input.vatProfile));
  if (input.lineCount === 0) blockers.push("noLines");
  if (input.totals.total < 0n) blockers.push("negativeTotal");
  return {
    blockers,
    sellerMissing,
    nextNumber: input.numbering?.nextNumber ?? null,
    issueDate: input.today,
    dueDate: addDays(input.today, input.paymentTermsDays),
    needsFx: needsSekVat(input.currency, input.totals.vatTotal),
    locale: input.locale ?? invoiceLocaleFor(input.client),
    noPeriod: !input.hasPeriod,
  };
}
