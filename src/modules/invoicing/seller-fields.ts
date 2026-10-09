import { fail, type DomainErrorCode } from "@/lib/domain-error";

/**
 * THE WORKSPACE'S DETAILS ON ITS INVOICES (Phase 4 slice 107) — the bounds
 * and checks every value is held to before it is stored. Pure: no database,
 * so the unit suite covers it.
 *
 * What the law wants printed is ML 2023:200 17 kap. 24 § (the seller's name
 * and address, VAT number) and ABL 28 kap. 5 § (a company's org. number and
 * registered office, "säte"); "Godkänd för F-skatt" is customary and wanted
 * by buyers. The checks below are typo checks — a check digit, a pattern —
 * never a lookup: whether a number belongs to this company is the
 * company's to know.
 *
 * Every function answers the value as it will be STORED (normalised:
 * spaces and hyphens where the reader expects them, letters upper-cased), or
 * null for blank, and refuses with a code the settings page can name.
 */

const NUL = String.fromCharCode(0);

/** A trimmed line of text, or null; refused when too long or unstorable. */
export function textOrNull(raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return fail("INVALID_INPUT", "not text");
  const v = raw.trim();
  if (v.length === 0) return null;
  if (v.length > max || v.includes(NUL)) return fail("INVALID_INPUT", "text");
  return v;
}

const digitsOnly = (raw: string): string => raw.replace(/[\s  -]/g, "");

/** The Luhn (mod 10) check over a string of digits. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const refuse = (code: DomainErrorCode): never => fail(code);

/**
 * A Swedish organisationsnummer (or a sole trader's personnummer, which is
 * their org. number): ten digits with a Luhn check digit, stored NNNNNN-NNNN.
 * A twelve-digit form with a century prefix (16, 18, 19, 20) is accepted and
 * shortened — that is how some registers print it.
 */
export function normalizeOrgNr(raw: unknown): string | null {
  const v = textOrNull(raw, 20);
  if (v === null) return null;
  let digits = digitsOnly(v);
  if (/^(16|18|19|20)\d{10}$/.test(digits)) digits = digits.slice(2);
  if (!/^\d{10}$/.test(digits) || !luhnValid(digits)) return refuse("ORG_NR_INVALID");
  return `${digits.slice(0, 6)}-${digits.slice(6)}`;
}

/**
 * Whether a stored org. number (NNNNNN-NNNN) is an AKTIEBOLAG's: a legal
 * person's number has its third digit at 2 or above (a personnummer's is a
 * month, 0 or 1), and group digit 5 is the aktiebolag's. Only an aktiebolag
 * must print its registered office (ABL 28 kap. 5 §).
 */
export const isAktiebolagOrgNr = (orgNr: string): boolean => /^5\d[2-9]/.test(digitsOnly(orgNr));

/**
 * A Swedish VAT registration number: "SE", the org. number's ten digits, "01"
 * — fourteen characters, stored without spaces. The ten digits carry the org.
 * number's own check digit, so a transposed digit is caught here too.
 */
export function normalizeSeVatNumber(raw: unknown): string | null {
  const v = textOrNull(raw, 20);
  if (v === null) return null;
  const compact = v.replace(/[\s  -]/g, "").toUpperCase();
  const m = /^SE(\d{10})01$/.exec(compact);
  if (!m || !luhnValid(m[1]!)) return refuse("VAT_NUMBER_INVALID");
  return compact;
}

/** The VAT number an org. number implies — the field's hint, never a value written for anyone. */
export function vatNumberFor(orgNr: string | null): string | null {
  if (!orgNr) return null;
  const digits = digitsOnly(orgNr);
  return /^\d{10}$/.test(digits) ? `SE${digits}01` : null;
}

/** A Bankgiro number: 7 or 8 digits with a Luhn check digit, stored NNN-NNNN / NNNN-NNNN. */
export function normalizeBankgiro(raw: unknown): string | null {
  const v = textOrNull(raw, 20);
  if (v === null) return null;
  const digits = digitsOnly(v);
  if (!/^\d{7,8}$/.test(digits) || !luhnValid(digits)) return refuse("BANKGIRO_INVALID");
  return `${digits.slice(0, digits.length - 4)}-${digits.slice(-4)}`;
}

/** A PlusGiro number: 2–8 digits with a Luhn check digit, stored with a hyphen before the last digit. */
export function normalizePlusgiro(raw: unknown): string | null {
  const v = textOrNull(raw, 20);
  if (v === null) return null;
  const digits = digitsOnly(v);
  if (!/^\d{2,8}$/.test(digits) || !luhnValid(digits)) return refuse("PLUSGIRO_INVALID");
  return `${digits.slice(0, -1)}-${digits.slice(-1)}`;
}

/** ISO 13616 mod-97 over an IBAN with its first four characters moved to the end. */
export function ibanChecksumValid(compact: string): boolean {
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** An IBAN: 15–34 letters and digits, mod-97 checked, stored in groups of four. */
export function normalizeIban(raw: unknown): string | null {
  const v = textOrNull(raw, 50);
  if (v === null) return null;
  const compact = v.replace(/[\s  -]/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact) || !ibanChecksumValid(compact)) {
    return refuse("IBAN_INVALID");
  }
  return compact.replace(/(.{4})(?=.)/g, "$1 ");
}

/** A BIC (SWIFT code): 8 or 11 characters, upper-cased. */
export function normalizeBic(raw: unknown): string | null {
  const v = textOrNull(raw, 20);
  if (v === null) return null;
  const compact = v.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(compact)) return refuse("BIC_INVALID");
  return compact;
}

/** An ISO 3166-1 alpha-2 country code, upper-cased. */
export function normalizeCountryCode(raw: unknown): string | null {
  const v = textOrNull(raw, 2);
  if (v === null) return null;
  const up = v.toUpperCase();
  if (!/^[A-Z]{2}$/.test(up)) return refuse("INVALID_INPUT");
  return up;
}

/** Bounds of the company card's free-text lines. */
export const SELLER_TEXT_MAX = {
  legalName: 200,
  seat: 100,
  addressLine: 200,
  postalCode: 20,
  city: 100,
} as const;

/** The workspace default: how many days a client has to pay. */
export const PAYMENT_TERMS_DEFAULT = 30;
export const PAYMENT_TERMS_RANGE = { min: 0, max: 120 } as const;
/** The note printed on every invoice (late-payment interest, a thank-you). */
export const FOOTER_NOTE_MAX = 500;

/** Whole days within PAYMENT_TERMS_RANGE, or null for blank. */
export function normalizePaymentTerms(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : null;
  if (s === null) return fail("INVALID_INPUT", "payment terms");
  if (s === "") return null;
  if (!/^\d{1,3}$/.test(s)) return fail("INVALID_INPUT", "payment terms");
  const n = Number(s);
  if (n < PAYMENT_TERMS_RANGE.min || n > PAYMENT_TERMS_RANGE.max) return fail("INVALID_INPUT", "payment terms");
  return n;
}
