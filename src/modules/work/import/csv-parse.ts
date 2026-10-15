/**
 * READING A SPREADSHEET FILE (Phase 6 slice 121; founder decision C97 (a);
 * design §2.1). Pure, browser-safe — the file is read in the member's
 * browser and never leaves it (design R1), so this module imports nothing
 * that reaches a server.
 *
 * What "a CSV" means in practice, and why each case is here:
 *   · Excel in Sweden saves "CSV" with SEMICOLONS (the comma is the decimal
 *     point) and, on Windows, in Windows-1252 — so the separator is detected
 *     and a file that is not valid UTF-8 is decoded as 1252.
 *   · Google Sheets, Asana, ClickUp, Jira and Monday save UTF-8 with commas,
 *     some with a BOM.
 *   · A cell can hold the separator, a quote (doubled) or a line break, all
 *     inside quotes (RFC 4180) — a task description with paragraphs does.
 * Every cell is NFC-normalised and has what Postgres cannot store (NUL, a
 * lone surrogate) removed, so nothing downstream meets an unstorable string.
 */

/** Header + this many rows are read; a longer file is refused, never truncated (design R11). */
export const CSV_MAX_ROWS = 2000;

export type CsvDelimiter = "," | ";" | "\t";

export type ParsedCsv = {
  readonly delimiter: CsvDelimiter;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** The file had more than `CSV_MAX_ROWS` data rows; `rows` stops there. */
  readonly tooMany: boolean;
};

const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A cell as Fortleva keeps it: NFC, nothing Postgres refuses. */
export const cleanCell = (value: string): string => value.replace(UNSTORABLE, "").normalize("NFC");

/**
 * Bytes → text: a UTF-8 BOM stripped; strict UTF-8 first, Windows-1252 when
 * the bytes are not UTF-8 (a Swedish Excel save) — never a silent U+FFFD.
 */
export function decodeCsv(bytes: Uint8Array): string {
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252").decode(body);
  }
}

/**
 * The separator, from the FIRST RECORD (quotes respected): the most frequent
 * of `,` `;` TAB; a tie or none goes to the comma.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      // A doubled quote inside quotes is one literal quote; either way the
      // state flips twice or once exactly as the parser below reads it.
      if (quoted && text[i + 1] === '"') {
        i++;
        continue;
      }
      quoted = !quoted;
    } else if (!quoted && (c === "\n" || c === "\r")) {
      break;
    } else if (!quoted && (c === "," || c === ";" || c === "\t")) {
      counts[c]++;
    }
  }
  const best = (Object.keys(counts) as CsvDelimiter[]).reduce((a, b) => (counts[b] > counts[a] ? b : a), ",");
  return counts[best] === 0 ? "," : best;
}

/**
 * RFC 4180, forgiving where real exports are: CR, LF or CRLF; a quote that
 * opens mid-cell is literal; text after a closing quote is kept. Blank
 * records are dropped. Stops once `maxRecords` records are read and says
 * whether there was more.
 */
export function parseRecords(
  text: string,
  delimiter: CsvDelimiter,
  maxRecords: number,
): { records: string[][]; more: boolean } {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let cellStarted = false;
  const endCell = () => {
    record.push(cell);
    cell = "";
    cellStarted = false;
  };
  const endRecord = (): boolean => {
    endCell();
    // A record of nothing but separators and spaces (`;;;`, Excel's padding
    // below a table) is no row at all — and must not count towards the cap.
    if (record.some((c) => c.trim() !== "")) records.push(record);
    record = [];
    return records.length >= maxRecords;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"' && !cellStarted) {
      quoted = true;
      cellStarted = true;
    } else if (c === delimiter) {
      endCell();
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (endRecord()) {
        // Anything left that is not blank is a record we did not read.
        return { records, more: text.slice(i + 1).trim().length > 0 };
      }
    } else {
      cell += c;
      cellStarted = true;
    }
  }
  if (cell !== "" || cellStarted || record.length > 0) endRecord();
  return { records, more: false };
}

/**
 * The whole file: the first record is the header row (blank names become
 * "Column 3" in the caller's language — the caller names them), every row
 * padded or cut to the header's width, every cell cleaned.
 */
export function parseCsv(text: string, delimiter: CsvDelimiter = detectDelimiter(text)): ParsedCsv {
  const { records, more } = parseRecords(text, delimiter, CSV_MAX_ROWS + 1);
  const [head = [], ...body] = records;
  const headers = head.map((h) => cleanCell(h).trim());
  const width = headers.length;
  const rows = body.map((r) => {
    const cells = r.slice(0, width).map(cleanCell);
    while (cells.length < width) cells.push("");
    return cells;
  });
  return { delimiter, headers, rows, tooMany: more || body.length > CSV_MAX_ROWS };
}
