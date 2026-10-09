import { fail } from "@/lib/domain-error";

/**
 * INVOICE ARITHMETIC (Phase 4 slice 107) — exact, in integers, never in
 * floating point. Pure: no database, so the unit suite covers it.
 *
 * Three fixed-point units, each a `bigint`:
 *   - an AMOUNT in hundredths (öre, cents) — the `numeric(14,2)` /
 *     `numeric(16,2)` columns;
 *   - a QUANTITY in thousandths — `invoice_line.quantity numeric(12,3)`;
 *   - a VAT RATE in hundredths of a percent — `vat_rate_pct numeric(5,2)`.
 *
 * ROUNDING IS HALF AWAY FROM ZERO, everywhere: it is what Postgres's
 * `round(numeric, int)` does, and the database restates the line amount in a
 * CHECK (`invoice_line_amount`) and, at issue, the totals — so the app and the
 * database must round identically or a correct line is refused.
 *
 * VAT IS COMPUTED ON EACH RATE'S SUM, not per line (EN 16931 BT-117 = BT-116 ×
 * rate, rounded once): a per-line VAT summed drifts by an öre per line from
 * what the law's "the VAT amount per rate" says. The database's check at issue
 * multiplies by 0.01 rather than dividing by 100 — a numeric division keeps
 * only ~16 significant digits, so a large sum divided could be rounded twice.
 */

/** Hundredths of the currency unit (öre / cents). */
export type Minor = bigint;

/** n / d rounded half away from zero; d > 0. */
export function divRoundHalfAway(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("divRoundHalfAway: the divisor must be positive");
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const q = abs / d;
  const r = abs % d;
  const rounded = r * 2n >= d ? q + 1n : q;
  return negative ? -rounded : rounded;
}

/** The largest line amount the app accepts: ten billion less an öre. */
export const LINE_AMOUNT_MAX: Minor = 999_999_999_999n; // 9 999 999 999.99
/** The largest |unit price|: what `numeric(14,2)` holds. */
export const UNIT_PRICE_MAX: Minor = 99_999_999_999_999n; // 999 999 999 999.99
/** The largest quantity: what `numeric(12,3)` holds. */
export const QUANTITY_MAX = 999_999_999_999n; // 999 999 999.999

/**
 * Parse a typed decimal into an integer of `scale` decimals. Accepts the
 * forms a Swedish or English keyboard produces — "1 234,50", "1234.5",
 * "-100", a non-breaking or thin space as the thousands separator — and
 * refuses anything with more decimals than the column holds (never
 * silently rounded: a typed 0,125 is a mistake to point at, not to fix).
 * Returns null for blank input.
 */
export function parseFixed(
  raw: unknown,
  scale: number,
  field: string,
  opts: { readonly decimalComma?: boolean } = {},
): bigint | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" && typeof raw !== "number") return fail("INVALID_INPUT", field);
  if (typeof raw === "number" && !Number.isFinite(raw)) return fail("INVALID_INPUT", field);
  const compact = String(raw)
    .replace(/[\s  ]/g, "")
    .replace(/^−/, "-"); // a typographic minus
  if (compact === "") return null;
  // ONE decimal separator, comma or point — never both, never two commas:
  // "1,000.50" and "1,000,000" are a thousands separator this cannot tell
  // from a decimal one. Where the comma IS the decimal separator (the
  // member's language says so — Swedish), "1,333" is 1.333, the very text
  // the lines table shows for that quantity (the fix-pass review's medium).
  // Anywhere else "1,000" alone is refused: an English reader means a
  // thousand, and a silent factor of 1 000 on a quantity is worse than a
  // sentence asking again (the code review's low). "0,125" and ",5" are
  // unambiguous and read as decimals everywhere.
  if (compact.includes(",") && (compact.includes(".") || compact.indexOf(",") !== compact.lastIndexOf(","))) {
    return fail("INVALID_INPUT", field);
  }
  if (!opts.decimalComma && /^-?[1-9]\d{0,2},\d{3}$/.test(compact)) return fail("INVALID_INPUT", field);
  // …and its mirror (the narrow re-check's low): where the comma is the
  // decimal separator, a point is often typed to group thousands, so "1.500"
  // is a thousand and a half to one reader and one and a half to another.
  if (opts.decimalComma && /^-?[1-9]\d{0,2}\.\d{3}$/.test(compact)) return fail("INVALID_INPUT", field);
  const s = compact.replace(",", ".");
  const m = /^(-?)(\d{0,18})(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return fail("INVALID_INPUT", field);
  const decimals = m[3] ?? "";
  if (decimals.length > scale) return fail("INVALID_INPUT", field);
  const digits = `${m[2] || "0"}${decimals.padEnd(scale, "0")}`;
  const value = BigInt(digits);
  return m[1] === "-" ? -value : value;
}

/** `value` (an integer of `scale` decimals) as the database's decimal text. */
export function formatFixed(value: bigint, scale: number): string {
  const negative = value < 0n;
  const abs = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const int = abs.slice(0, abs.length - scale);
  const frac = abs.slice(abs.length - scale);
  return `${negative ? "-" : ""}${int}${scale > 0 ? `.${frac}` : ""}`;
}

/**
 * A stored decimal read back (Prisma's Decimal, or its text) as an integer of
 * `scale` decimals. `toFixed` first: a Decimal's `toString` may drop trailing
 * zeros or, for tiny values, switch to exponent notation.
 */
export function readFixed(stored: { toFixed(dp: number): string } | string, scale: number): bigint {
  const text = typeof stored === "string" ? stored : stored.toFixed(scale);
  const parsed = parseFixed(text, scale, "stored");
  if (parsed === null) throw new Error("readFixed: a stored decimal was blank");
  return parsed;
}

/** A line's amount ex. VAT: quantity × unit price, rounded to the öre. */
export function lineAmount(quantityMilli: bigint, unitPriceMinor: Minor): Minor {
  return divRoundHalfAway(quantityMilli * unitPriceMinor, 1000n);
}

/** VAT on a net amount at a rate in hundredths of a percent (25 % = 2500n). */
export function vatOn(netMinor: Minor, rateHundredths: bigint): Minor {
  return divRoundHalfAway(netMinor * rateHundredths, 10_000n);
}

export type VatGroup = {
  /** Hundredths of a percent: 2500n is 25 %. */
  readonly rate: bigint;
  readonly net: Minor;
  readonly vat: Minor;
};

export type InvoiceTotals = {
  readonly subtotal: Minor;
  /** One per rate present, highest rate first. */
  readonly groups: readonly VatGroup[];
  readonly vatTotal: Minor;
  readonly total: Minor;
};

/** The invoice's totals from its lines: VAT once per rate, on that rate's sum. */
export function invoiceTotals(
  lines: readonly { readonly amount: Minor; readonly rate: bigint }[],
): InvoiceTotals {
  const byRate = new Map<bigint, Minor>();
  let subtotal = 0n;
  for (const line of lines) {
    subtotal += line.amount;
    byRate.set(line.rate, (byRate.get(line.rate) ?? 0n) + line.amount);
  }
  const groups = [...byRate.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a > b ? -1 : 1))
    .map(([rate, net]) => ({ rate, net, vat: vatOn(net, rate) }));
  const vatTotal = groups.reduce((sum, g) => sum + g.vat, 0n);
  return { subtotal, groups, vatTotal, total: subtotal + vatTotal };
}

/** For display only (Intl formatting takes a number); never for arithmetic. */
export const minorToNumber = (minor: Minor): number => Number(minor) / 100;

/** A whole percent from hundredths, for labels ("25 %"); 2500n → 25. */
export const rateToNumber = (rateHundredths: bigint): number => Number(rateHundredths) / 100;
