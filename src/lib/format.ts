/**
 * Locale-aware formatting (DESIGN SPEC §3.5).
 *
 * Every Intl formatter is built ONCE per (locale, options) and cached
 * in a module-level Map. Constructing one inside a render — or worse,
 * inside a .map() over table rows — is the single most expensive thing
 * a list page can do.
 *
 * Swedish specifics that bite:
 *  - sv-SE's group separator is U+00A0 (a real no-break space), so
 *    MACHINE output (CSV, filter matching, test fixtures) must use
 *    { useGrouping: false } and any client-side text match must
 *    normalise U+00A0 to a plain space first: `machineNumber` / `normalizeNbsp`.
 *  - sv keeps the space in "42 %".
 *  - Currency is always explicit and never `narrowSymbol`: sv-SE reads
 *    "1 234,50 kr", en is forced to the ISO code, "SEK 1,234.50".
 */

const cache = new Map<string, unknown>();

function memo<T>(key: string, build: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;
  const made = build();
  cache.set(key, made);
  return made;
}

export const normalizeNbsp = (value: string): string => value.replace(/\u{00A0}/gu, " ");

/* -------------------------------------------------------------- *
 * Numbers, money, percentages
 * -------------------------------------------------------------- */

export function numberFormat(locale: string, options: Intl.NumberFormatOptions = {}) {
  return memo(`n:${locale}:${JSON.stringify(options)}`, () => new Intl.NumberFormat(locale, options));
}

export const formatNumber = (locale: string, value: number, options?: Intl.NumberFormatOptions) =>
  numberFormat(locale, options).format(value);

/** Ungrouped, dot-decimal: for CSV, URLs, fixtures — never for display. */
export const machineNumber = (value: number): string =>
  new Intl.NumberFormat("en-US", { useGrouping: false, maximumFractionDigits: 6 }).format(value);

export function formatMoney(locale: string, amount: number, currency: string): string {
  const isSwedish = locale.startsWith("sv");
  return numberFormat(locale, {
    style: "currency",
    currency,
    // en must not print a bare symbol: "kr" and "DKK kr" are the same
    // glyph to a reader who does not know which workspace they are in.
    currencyDisplay: isSwedish ? "symbol" : "code",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export const formatPercent = (locale: string, ratio: number, fractionDigits = 0): string =>
  numberFormat(locale, {
    style: "percent",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(ratio);

/* -------------------------------------------------------------- *
 * Durations — three formats, never mixed inside one column
 *
 * Deliberately NOT Intl.DurationFormat. It exists in Chromium and in
 * Node ≥ 23 but not in Node 22, and it renders { minutes: 0 } as "" —
 * so a server without it and a browser with it emit different bytes for
 * the same value, which React reports as a hydration mismatch (#418) on
 * every page with a 0-minute row (CI, 2026-08-20: /time and /time/team
 * straight after a timer was started and stopped). Intl.NumberFormat's
 * unit style exists everywhere, prints "0m" for zero, and was checked
 * byte-for-byte equal between Node and Chromium for en and sv.
 * -------------------------------------------------------------- */

function unitFormat(locale: string, unit: "hour" | "minute") {
  return memo(`u:${locale}:${unit}`, () =>
    new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" }),
  );
}

/** Lists and chips: "1h 30m" / "45m" / "2h" — never an empty string. */
export function formatDurationHm(locale: string, minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (!hours) return unitFormat(locale, "minute").format(mins);
  const h = unitFormat(locale, "hour").format(hours);
  return mins ? `${h} ${unitFormat(locale, "minute").format(mins)}` : h;
}

/** A running timer: "0:07:05". Re-rendered once per second, never animated. */
export function formatDurationClock(locale: string, seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const one = numberFormat(locale, { useGrouping: false });
  const two = numberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
  return `${one.format(hours)}:${two.format(minutes)}:${two.format(secs)}`;
}

/** Decimal hours — ONLY where the value multiplies a rate: "1,5 h". */
export function formatDurationDecimal(locale: string, minutes: number): string {
  const hours = Math.max(0, minutes) / 60;
  return `${formatNumber(locale, hours, { minimumFractionDigits: 1, maximumFractionDigits: 2 })} h`;
}

export type DurationStyle = "hm" | "clock" | "decimal";

export function formatDuration(locale: string, minutes: number, style: DurationStyle): string {
  if (style === "clock") return formatDurationClock(locale, minutes * 60);
  if (style === "decimal") return formatDurationDecimal(locale, minutes);
  return formatDurationHm(locale, minutes);
}

/* -------------------------------------------------------------- *
 * Bytes
 * -------------------------------------------------------------- */

const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB"] as const;

/** Value and unit separately, so a table can right-align the number. */
export function bytesParts(locale: string, bytes: number): { value: string; unit: string } {
  let size = Math.max(0, bytes);
  let unit = 0;
  while (size >= 1000 && unit < BYTE_UNITS.length - 1) {
    size /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return {
    value: formatNumber(locale, size, { minimumFractionDigits: digits, maximumFractionDigits: digits }),
    unit: BYTE_UNITS[unit]!,
  };
}

export function formatBytes(locale: string, bytes: number): string {
  const { value, unit } = bytesParts(locale, bytes);
  return `${value} ${unit}`;
}

/* -------------------------------------------------------------- *
 * Dates
 * -------------------------------------------------------------- */

export function dateFormat(locale: string, options: Intl.DateTimeFormatOptions) {
  return memo(`t:${locale}:${JSON.stringify(options)}`, () => new Intl.DateTimeFormat(locale, options));
}

export const formatDate = (
  locale: string,
  value: Date | number,
  options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" },
): string => dateFormat(locale, options).format(value);
