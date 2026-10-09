import { addDays } from "@/lib/week";

import { needsSekVat, rateDayFor, rateDayTooOld } from "./fx";
import { vatOn, type InvoiceTotals, type Minor } from "./money";
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
  | "negativeTotal"
  /** The work ended before the ECB's history reaches (C78 (a)). */
  | "fxTooOld"
  // A credit note (slice 108b):
  /** It says why (C77 (b)). */
  | "noReason"
  /** It credits more than is left of its invoice at some rate — `overCredit` says where. */
  | "overCredit"
  /** Its invoice was credited in full meanwhile (or is not one that can be credited). */
  | "originalNotOpen"
  /** Its total is zero or below: it credits nothing. */
  | "notPositive"
  /** It would leave only a discount uncredited, which nothing could ever credit (`creditLeavesNegative`). */
  | "leavesNegative"
  /** It carries VAT in another currency, but its invoice stated no rate to take. */
  | "noRate"
  /** Today is before its invoice's date (a workspace moved west): the guard refuses it. */
  | "beforeInvoice";

/** One VAT rate a credit note asks more of than its invoice has left (signed: see `creditOverRates`). */
export type OverCredit = {
  /** Hundredths of a percent. */
  readonly rate: bigint;
  /** What is left to credit at this rate, after the issued credit notes. */
  readonly left: Minor;
  /** What this credit note credits at it. */
  readonly asked: Minor;
};

export type IssueCheck = {
  readonly kind: "INVOICE" | "CREDIT_NOTE";
  readonly blockers: readonly IssueBlocker[];
  /** What Settings → Invoicing still lacks, numbering included. */
  readonly sellerMissing: readonly MissingDetail[];
  /** The number it would take now — another issue first takes it. */
  readonly nextNumber: number | null;
  /** `YYYY-MM-DD`, the workspace's today. */
  readonly issueDate: string;
  readonly dueDate: string;
  readonly needsFx: boolean;
  /**
   * The day whose ECB rate the VAT in SEK takes (C78 (a)) — `rateDayFor`; for
   * a credit note, its invoice's rate's date. Null when no SEK VAT is wanted.
   */
  readonly rateDay: string | null;
  readonly locale: InvoiceLocale;
  /** No work period: the invoice's date will read as the date of the work (the design review's low). */
  readonly noPeriod: boolean;
  /** A credit note: the rates it asks too much of. Empty otherwise. */
  readonly overCredit: readonly OverCredit[];
  /** A credit note: its invoice's date, `YYYY-MM-DD`. Null otherwise. */
  readonly creditsIssueDate: string | null;
};

/** A net per VAT rate (hundredths of a percent → hundredths). */
export type RateNets = ReadonlyMap<bigint, Minor>;

/**
 * THE OVER-CREDIT RULE (slice 108b; the issue guard restates it as
 * `invoice_credit_within`), at every VAT rate, signed — a discount is a
 * negative line (107), so an invoice may net below zero at a rate:
 *   - this credit note's own net there lies between zero and the invoice's
 *     (it never "un-credits" a rate, and never credits only a discount);
 *   - what the invoice's issued credit notes credit — `credited`, plus this
 *     one's `asked` — lies between zero and the invoice's net, inclusive;
 *   - it has no line at a rate the invoice lacks.
 * Returns the rates that break it; none means the credit note fits.
 */
export function creditOverRates(original: RateNets, credited: RateNets, asked: RateNets): OverCredit[] {
  const rates = new Set<bigint>([...original.keys(), ...credited.keys(), ...asked.keys()]);
  const out: OverCredit[] = [];
  for (const rate of [...rates].sort((a, b) => (a === b ? 0 : a > b ? -1 : 1))) {
    const o = original.get(rate) ?? 0n;
    const before = credited.get(rate) ?? 0n;
    const mine = asked.get(rate) ?? 0n;
    const after = before + mine;
    const low = o < 0n ? o : 0n;
    const high = o < 0n ? 0n : o;
    const lacking = !original.has(rate) && asked.has(rate);
    if (lacking || mine < low || mine > high || after < low || after > high) out.push({ rate, left: o - before, asked: mine });
  }
  return out;
}

/**
 * Whether a part credit would leave its invoice with only a NEGATIVE rest — a
 * discount at a rate of its own, left uncredited once everything else was
 * (the design review's low). No credit note could ever take that rest (a
 * credit note's total is above zero), so the invoice would read "partly
 * credited" for good. The app refuses it; the guard does not (it is not a
 * wrong record, only a stuck one).
 */
export function creditLeavesNegative(original: RateNets, credited: RateNets, asked: RateNets): boolean {
  const rates = new Set<bigint>([...original.keys(), ...credited.keys(), ...asked.keys()]);
  let rest = 0n;
  let anyLeft = false;
  for (const rate of rates) {
    const left = (original.get(rate) ?? 0n) - (credited.get(rate) ?? 0n) - (asked.get(rate) ?? 0n);
    if (left !== 0n) anyLeft = true;
    rest += left + vatOn(left, rate);
  }
  return anyLeft && rest <= 0n;
}

/** Whether issued credit notes now cover the whole invoice: their net equals its own at every rate. */
export function creditCovers(original: RateNets, credited: RateNets): boolean {
  const rates = new Set<bigint>([...original.keys(), ...credited.keys()]);
  for (const rate of rates) if ((original.get(rate) ?? 0n) !== (credited.get(rate) ?? 0n)) return false;
  return true;
}

/** A totals' groups as a net per rate. */
export const netsOf = (groups: readonly { readonly rate: bigint; readonly net: Minor }[]): RateNets =>
  new Map(groups.map((g) => [g.rate, g.net]));

/**
 * What issuing a CREDIT NOTE needs (slice 108b) — pure. None of an invoice's
 * seller or client checks: its parties are its invoice's, as that invoice
 * named them (the guard copies the snapshots). It says why, has a line,
 * credits something, its invoice is still open to credit, and no rate is
 * asked more of than is left. Its date is today and it falls due the same
 * day (it asks no one to pay); its language and rate are its invoice's.
 */
export function checkCreditIssue(input: {
  readonly reason: string | null;
  readonly lineCount: number;
  readonly totals: InvoiceTotals;
  readonly originalOpen: boolean;
  readonly original: RateNets;
  readonly credited: RateNets;
  readonly numbering: Numbering | null;
  readonly currency: string;
  /** The invoice's rate's date, when it stated VAT in SEK. */
  readonly originalRateDate: string | null;
  /** The invoice's own date, `YYYY-MM-DD` — a credit note is never dated before it (the guard). */
  readonly originalIssueDate: string | null;
  readonly locale: InvoiceLocale;
  readonly today: string;
}): IssueCheck {
  const blockers: IssueBlocker[] = [];
  if (!nonBlank(input.reason)) blockers.push("noReason");
  if (!input.originalOpen) blockers.push("originalNotOpen");
  if (input.originalIssueDate !== null && input.today < input.originalIssueDate) blockers.push("beforeInvoice");
  if (input.lineCount === 0) blockers.push("noLines");
  else if (input.totals.total <= 0n) blockers.push("notPositive");
  const asked = netsOf(input.totals.groups);
  const overCredit = input.originalOpen ? creditOverRates(input.original, input.credited, asked) : [];
  if (overCredit.length > 0) blockers.push("overCredit");
  else if (input.originalOpen && input.lineCount > 0 && creditLeavesNegative(input.original, input.credited, asked)) {
    blockers.push("leavesNegative");
  }
  const needsFx = needsSekVat(input.currency, input.totals.vatTotal);
  // Its VAT in SEK is at its invoice's rate — and an invoice whose VAT netted
  // to nothing stated none, so a part credit carrying VAT has no rate to take
  // (the migration review's low: the guard refuses it; say so before the click).
  if (needsFx && input.originalRateDate === null) blockers.push("noRate");
  return {
    kind: "CREDIT_NOTE",
    blockers,
    sellerMissing: input.numbering ? [] : ["numbering"],
    nextNumber: input.numbering?.nextNumber ?? null,
    issueDate: input.today,
    dueDate: input.today,
    needsFx,
    rateDay: needsFx ? input.originalRateDate : null,
    locale: input.locale,
    noPeriod: false,
    overCredit,
    creditsIssueDate: input.originalIssueDate,
  };
}

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
  /** The work period's last day, `YYYY-MM-DD` — the day of the rate (C78 (a)). */
  readonly periodEnd: string | null;
  readonly today: string;
}): IssueCheck {
  const sellerMissing = missingForIssue(input.company, input.payment, input.numbering !== null, input.paymentUnreadable ?? false);
  const blockers: IssueBlocker[] = [];
  if (sellerMissing.length > 0) blockers.push("seller");
  blockers.push(...clientBlockers(input.client, input.vatProfile));
  if (input.lineCount === 0) blockers.push("noLines");
  if (input.totals.total < 0n) blockers.push("negativeTotal");
  const needsFx = needsSekVat(input.currency, input.totals.vatTotal);
  const rateDay = needsFx ? rateDayFor(input.today, input.periodEnd) : null;
  if (rateDay !== null && rateDayTooOld(rateDay, input.today)) blockers.push("fxTooOld");
  return {
    kind: "INVOICE",
    blockers,
    sellerMissing,
    nextNumber: input.numbering?.nextNumber ?? null,
    issueDate: input.today,
    dueDate: addDays(input.today, input.paymentTermsDays),
    needsFx,
    rateDay,
    locale: input.locale ?? invoiceLocaleFor(input.client),
    noPeriod: !input.hasPeriod,
    overCredit: [],
    creditsIssueDate: null,
  };
}

/**
 * TEXT THAT READS LIKE SOMEWHERE TO PAY (slice 109; the security review's low).
 * A draft's note, references and line descriptions are printed on the PDF —
 * now emailed — and are ordinary edits (C75 (i): the issuer sees the whole
 * invoice), so a web address or an account number typed there gets past every
 * fence the Pay now link has. Not a refusal — an agency's lines name websites
 * — but the issue dialog says so, plainly, before the code.
 */
const PAYMENT_TEXT: readonly RegExp[] = [
  /\bhttps?:\/\//i,
  /\bwww\./i,
  // An IBAN's shape: two letters, two digits, then groups.
  /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/,
  // A Bankgiro / PlusGiro shape: 123-4567, 1234-5678.
  /\b\d{3,4}-\d{4}\b/,
  /\b(?:bankgiro|plusgiro|iban|swift|bic|swish)\b/i,
];

export const mentionsPaymentDetails = (texts: readonly (string | null | undefined)[]): boolean =>
  texts.some((t) => typeof t === "string" && PAYMENT_TEXT.some((re) => re.test(t)));
