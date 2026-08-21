/**
 * CSV serialisation (RFC 4180) for the product's exports — one place, so
 * every download the app hands out has the same shape:
 *
 *  - UTF-8 with a BOM (Excel on Windows otherwise reads å/ä/ö as
 *    mojibake), CRLF line ends, a trailing line end;
 *  - the comma as separator and the dot as decimal point — the MACHINE
 *    format (`machineNumber`), never the display formatter: a Swedish
 *    "1 234,5" is for screens, a CSV is for other programs (PLAN.md §0);
 *  - a cell is quoted only when it must be (separator, quote, CR/LF,
 *    leading/trailing space), quotes doubled;
 *  - formula injection neutralised: a text cell starting with `=`, `+`,
 *    `-`, `@`, TAB or CR is prefixed with an apostrophe (OWASP "CSV
 *    injection") — a member's note "=HYPERLINK(...)" must never run in
 *    the reader's spreadsheet. Numbers are passed as numbers and are
 *    exempt (a negative amount stays a number).
 */

export const CSV_BOM = "\uFEFF";

export type CsvCell = string | number | boolean | null | undefined;

/** A leading TAB/CR, or `=` `+` `-` `@` after any leading whitespace (`" =1+1"` is the same attack with a space). */
const FORMULA_LEAD = /^(?:[\t\r]|\s*[=+\-@])/;
/** A plain machine number ("-500.00", "1200", "3.5") — never a formula, so the guard leaves it alone. */
const MACHINE_NUMBER = /^-?\d+(\.\d+)?$/;
const NEEDS_QUOTES = /[",\r\n]|^ | $/;

/**
 * One cell, escaped. Strings are injection-guarded; numbers, and strings
 * that ARE numbers (a negative margin arrives as "-500.00"), print in
 * machine form untouched.
 */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = FORMULA_LEAD.test(value) && !MACHINE_NUMBER.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A whole document: header + rows → BOM-prefixed CRLF text. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(","));
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}

/**
 * A safe download filename stem: letters, digits, `-`, `_`, `.`; everything
 * else (spaces, slashes, quotes, å/ä/ö) becomes `-`, runs collapse, edges
 * trim. The UTF-8 name goes in `filename*`; this is the ASCII fallback.
 */
export const csvFileStem = (...parts: readonly (string | null | undefined)[]): string =>
  parts
    .filter((p): p is string => !!p)
    .join("-")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // combining marks: Å → A, not A-
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120) || "export";
