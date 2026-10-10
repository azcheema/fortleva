import { fail } from "@/lib/domain-error";

import { SIE_SERIES } from "./sie";
import type { VatProfile } from "./vat";

/**
 * HOW THE BOOKKEEPING FILE BOOKS (Phase 4 slice 111; founder decision C82). A
 * workspace setting — one `TenantPreference` (`invoice.bookkeeping`) holding
 * only what differs from the default; a stored value that no longer reads is
 * the default, as every preference falls back.
 *
 *   method      INVOICE or CASH — no default: the page asks before the first
 *               file, and it is fixed once a file exists (C82 (e)). The
 *               invoice method books each invoice and credit note on its date;
 *               the cash method books each PAYMENT on its day.
 *   yearStart   the month the financial year starts (1–12, default 1): one
 *               file never holds two financial years (the review's M1).
 *   series      the voucher series, default F — a series of Fortleva's own, so
 *               a mistaken import can be undone (the review's L2).
 *
 * …and the accounts, with the BAS chart's defaults (Fortnox's standard chart
 * has them), each held to its class (the review's L3 — a receivable mapped to
 * a sales account would still balance, and silently be wrong):
 *
 *   bank            1930  Företagskonto            (cash method)        1xxx
 *   receivables     1510  Kundfordringar           (invoice method)     1xxx
 *   salesSe25/12/6  3001 / 3002 / 3003  Försäljning inom Sverige, moms  3xxx
 *   salesEu         3308  Försäljning tjänster till annat EU-land       3xxx
 *   salesOutsideEu  3305  Försäljning tjänster till land utanför EU     3xxx
 *   vat25/12/6      2611 / 2621 / 2631  Utgående moms                   26xx
 *
 * Nothing here is printed on an invoice or paid to: an ordinary `settings:edit`
 * edit, audited with what changed (`invoice_settings.bookkeeping_changed`).
 */

export const BOOKKEEPING_PREF_KEY = "invoice.bookkeeping";

export const ACCOUNT_ROLES = [
  "bank",
  "receivables",
  "salesSe25",
  "salesSe12",
  "salesSe6",
  "salesEu",
  "salesOutsideEu",
  "vat25",
  "vat12",
  "vat6",
] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export const BOOKKEEPING_FIELDS = ["method", "yearStart", "series", ...ACCOUNT_ROLES] as const;
export type BookkeepingField = (typeof BOOKKEEPING_FIELDS)[number];

export const BOOKKEEPING_METHODS = ["INVOICE", "CASH"] as const;
export type BookkeepingMethod = (typeof BOOKKEEPING_METHODS)[number];

/** Every field as text, as stored and as the form posts it; `method` "" until chosen. */
export type BookkeepingSettings = Readonly<Record<BookkeepingField, string>>;

export const BOOKKEEPING_DEFAULTS: BookkeepingSettings = {
  method: "",
  yearStart: "1",
  series: "F",
  bank: "1930",
  receivables: "1510",
  salesSe25: "3001",
  salesSe12: "3002",
  salesSe6: "3003",
  salesEu: "3308",
  salesOutsideEu: "3305",
  vat25: "2611",
  vat12: "2621",
  vat6: "2631",
};

/** Each account role's class (the review's L3). */
const ACCOUNT_CLASS: Readonly<Record<AccountRole, RegExp>> = {
  bank: /^1\d{3}$/,
  receivables: /^1\d{3}$/,
  salesSe25: /^3\d{3}$/,
  salesSe12: /^3\d{3}$/,
  salesSe6: /^3\d{3}$/,
  salesEu: /^3\d{3}$/,
  salesOutsideEu: /^3\d{3}$/,
  vat25: /^26\d{2}$/,
  vat12: /^26\d{2}$/,
  vat6: /^26\d{2}$/,
};

export const isBookkeepingField = (v: unknown): v is BookkeepingField =>
  typeof v === "string" && (BOOKKEEPING_FIELDS as readonly string[]).includes(v);

export const isBookkeepingMethod = (v: unknown): v is BookkeepingMethod =>
  typeof v === "string" && (BOOKKEEPING_METHODS as readonly string[]).includes(v);

/**
 * One typed value, normalised: blank → null ("the default"). Refuses with
 * INVALID_INPUT naming the field: an account outside its class, a series that
 * is not 1–10 letters or digits (upper-cased), a method that is not one of the
 * two, a month outside 1–12.
 */
export function normalizeBookkeepingValue(field: BookkeepingField, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return fail("INVALID_INPUT", field);
  const value = raw.trim();
  if (value === "") return null;
  if (field === "method") {
    if (!isBookkeepingMethod(value)) return fail("INVALID_INPUT", field);
    return value;
  }
  if (field === "yearStart") {
    if (!/^(?:[1-9]|1[0-2])$/.test(value)) return fail("INVALID_INPUT", field);
    return value;
  }
  if (field === "series") {
    if (!SIE_SERIES.test(value)) return fail("INVALID_INPUT", field);
    return value.toUpperCase();
  }
  if (!ACCOUNT_CLASS[field].test(value)) return fail("INVALID_INPUT", field);
  return value;
}

/** The stored preference read back: each valid stored value over its default. */
export function bookkeepingFrom(stored: unknown): BookkeepingSettings {
  const out: Record<BookkeepingField, string> = { ...BOOKKEEPING_DEFAULTS };
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return out;
  for (const field of BOOKKEEPING_FIELDS) {
    const v = (stored as Record<string, unknown>)[field];
    try {
      const n = normalizeBookkeepingValue(field, v);
      if (n !== null) out[field] = n;
    } catch {
      // A value that no longer reads is the default.
    }
  }
  return out;
}

/** What to store: only the fields that differ from their default. */
export function bookkeepingToStore(values: BookkeepingSettings): Partial<Record<BookkeepingField, string>> {
  const out: Partial<Record<BookkeepingField, string>> = {};
  for (const field of BOOKKEEPING_FIELDS) if (values[field] !== BOOKKEEPING_DEFAULTS[field]) out[field] = values[field];
  return out;
}

/** The method, or null until the workspace has chosen one. */
export const methodOf = (s: BookkeepingSettings): BookkeepingMethod | null => (isBookkeepingMethod(s.method) ? s.method : null);

/** The month (1–12) the financial year starts. */
export const yearStartOf = (s: BookkeepingSettings): number => Number(s.yearStart) || 1;

/**
 * The financial year a day falls in, named by its first day (`YYYY-MM-01`): with
 * a year starting in May, 2026-04-30 is in the year that began 2025-05-01.
 */
export function financialYearOf(day: string, yearStart: number): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const startYear = m >= yearStart ? y : y - 1;
  return `${startYear}-${String(yearStart).padStart(2, "0")}-01`;
}

/** The sales account a VAT treatment and rate (hundredths of a percent) book to. */
export function salesAccountFor(s: BookkeepingSettings, profile: VatProfile, rate: bigint): string {
  if (profile === "EU_REVERSE_CHARGE") return s.salesEu;
  if (profile === "OUTSIDE_SCOPE") return s.salesOutsideEu;
  if (rate === 2500n) return s.salesSe25;
  if (rate === 1200n) return s.salesSe12;
  if (rate === 600n) return s.salesSe6;
  throw new Error("bookkeeping: a Swedish rate with no sales account");
}

/** The output-VAT account of a rate; null for 0 % (nothing to book). */
export function vatAccountFor(s: BookkeepingSettings, rate: bigint): string | null {
  if (rate === 0n) return null;
  if (rate === 2500n) return s.vat25;
  if (rate === 1200n) return s.vat12;
  if (rate === 600n) return s.vat6;
  throw new Error("bookkeeping: a VAT rate with no account");
}
