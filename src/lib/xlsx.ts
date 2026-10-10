import { strToU8, zipSync } from "fflate";

/**
 * A MINIMAL EXCEL WORKBOOK (Phase 4 slice 111; founder decision C82 (a)): one
 * sheet, a bold frozen header row, and cells that are text, numbers, amounts,
 * rates or dates — what the bookkeeping list needs and nothing more.
 *
 * Why not the product's CSV (`src/lib/csv.ts`): that file is for OTHER
 * PROGRAMS — comma-separated, dot decimals. The list is for a PERSON in
 * Excel, and Excel opens a .csv with the computer's own list separator: with
 * Swedish regional settings that is `;`, so a comma file lands in one column
 * — on exactly the accountant's machine. A workbook carries its own structure
 * and opens the same in every locale, amounts stay numbers that sum, and a
 * cell is an inline string or a number, never a formula (no "CSV injection").
 *
 * The parts (ECMA-376, SpreadsheetML): `[Content_Types].xml`, `_rels/.rels`,
 * `xl/workbook.xml` + its rels, `xl/styles.xml`, `xl/worksheets/sheet1.xml`.
 * Strings are inline (`t="inlineStr"`), so there is no shared-string table;
 * XML-escaped, and the characters XML 1.0 forbids are dropped.
 */

/** How a column's cells are written and formatted. */
export type XlsxKind = "text" | "money" | "rate" | "date" | "integer";

export type XlsxColumn = {
  readonly header: string;
  readonly kind: XlsxKind;
  /** Width in characters (Excel's unit); a default per kind otherwise. */
  readonly width?: number;
};

/**
 * One cell: text (a `text` column), a decimal as the database writes it
 * ("-1250.00" — `money`, `rate`, `integer`), a `YYYY-MM-DD` day (`date`), or
 * empty. A value that does not fit its column is written empty, never guessed.
 */
export type XlsxCell = string | null;

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

/** The style index each kind's cells take (`styles.xml`'s cellXfs, in order). */
const STYLE = { text: 0, header: 1, money: 2, date: 3, rate: 4, integer: 5 } as const;

const DEFAULT_WIDTH: Readonly<Record<XlsxKind, number>> = { text: 24, money: 14, rate: 12, date: 12, integer: 10 };

/** A character XML 1.0 allows (TAB, LF, CR, and the planes it names). */
const xmlAllowed = (cp: number): boolean =>
  cp === 0x09 || cp === 0x0a || cp === 0x0d || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || cp >= 0x10000;

/** Text as XML character data: forbidden characters dropped (a lone surrogate too), the five specials escaped. */
export function xmlText(value: string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (!xmlAllowed(cp)) continue;
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else if (ch === "'") out += "&apos;";
    else out += ch;
  }
  return out;
}

/** The column's letters: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

const DECIMAL = /^-?\d{1,18}(?:\.\d{1,8})?$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` as Excel's day serial (days since 1899-12-30), or null when it is no calendar day. */
export function excelDaySerial(day: string): number | null {
  const m = DAY.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round((ms - Date.UTC(1899, 11, 30)) / 86_400_000);
}

function cellXml(ref: string, kind: XlsxKind, value: XlsxCell): string {
  if (value === null || value === "") return "";
  if (kind === "text") {
    return `<c r="${ref}" t="inlineStr" s="${STYLE.text}"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
  }
  if (kind === "date") {
    const serial = excelDaySerial(value);
    return serial === null ? "" : `<c r="${ref}" s="${STYLE.date}"><v>${serial}</v></c>`;
  }
  return DECIMAL.test(value) ? `<c r="${ref}" s="${STYLE[kind]}"><v>${value}</v></c>` : "";
}

/** A sheet name Excel accepts: at most 31 characters, none of `[]:*?/\`. */
export function sheetName(raw: string): string {
  // Cut the TEXT to Excel's 31 characters, then escape — never an entity cut in half.
  const cleaned = Array.from(raw.replace(/[[\]:*?/\\]/g, " ").trim())
    .slice(0, 31)
    .join("")
    .trim();
  return xmlText(cleaned) || "Sheet1";
}

const CONTENT_TYPES = `${XML_HEADER}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `${XML_HEADER}
<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS = `${XML_HEADER}
<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`;

// Built-in number formats: 4 = "#,##0.00", 14 = the reader's short date, 1 = "0".
// 164 is ours: an exchange rate to six decimals.
const STYLES = `${XML_HEADER}
<styleSheet xmlns="${MAIN_NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.000000"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** One sheet as an .xlsx file's bytes. Every row has the columns' length (shorter rows are padded empty). */
export function xlsxWorkbook(input: {
  readonly sheet: string;
  readonly columns: readonly XlsxColumn[];
  readonly rows: readonly (readonly XlsxCell[])[];
}): Uint8Array {
  const { columns, rows } = input;
  const cols = columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? DEFAULT_WIDTH[c.kind]}" customWidth="1"/>`)
    .join("");
  const header = `<row r="1">${columns
    .map((c, i) => `<c r="${columnName(i)}1" t="inlineStr" s="${STYLE.header}"><is><t xml:space="preserve">${xmlText(c.header)}</t></is></c>`)
    .join("")}</row>`;
  const body = rows
    .map((row, r) => {
      const n = r + 2;
      return `<row r="${n}">${columns.map((c, i) => cellXml(`${columnName(i)}${n}`, c.kind, row[i] ?? null)).join("")}</row>`;
    })
    .join("");
  const sheetXml = `${XML_HEADER}
<worksheet xmlns="${MAIN_NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${header}${body}</sheetData></worksheet>`;
  const workbookXml = `${XML_HEADER}
<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="${sheetName(input.sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  // A fixed modification time: the same rows make the same bytes (a re-download
  // is identical). LOCAL components: fflate writes the zip's DOS time with local
  // getters, so a UTC date would make different bytes on servers in different zones.
  const mtime = new Date(2026, 0, 1);
  return zipSync(
    {
      "[Content_Types].xml": [strToU8(CONTENT_TYPES), { mtime }],
      "_rels/.rels": [strToU8(ROOT_RELS), { mtime }],
      "xl/workbook.xml": [strToU8(workbookXml), { mtime }],
      "xl/_rels/workbook.xml.rels": [strToU8(WORKBOOK_RELS), { mtime }],
      "xl/styles.xml": [strToU8(STYLES), { mtime }],
      "xl/worksheets/sheet1.xml": [strToU8(sheetXml), { mtime }],
    },
    { level: 6 },
  );
}

/** The MIME type of an .xlsx. */
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
