import { formatFixed, type Minor } from "./money";

/**
 * THE SIE IMPORT FILE (Phase 4 slice 111; founder decision C82 (a)) — the
 * Swedish standard every bookkeeping program reads, Fortnox included
 * (Bokföring → Importera SIE-fil). SIE-Gruppen's "SIE filformat", utgåva 4C
 * (2025-08-06), type **4I**: transactions FOR IMPORT into a bookkeeping
 * program, from a "försystem" such as an invoicing program (§4.7). What this
 * writes, by the spec's sections:
 *
 *  - the records in the spec's order (§5.12): the flag, the identification
 *    (`#PROGRAM`, `#FORMAT`, `#GEN`, `#SIETYP`, `#FNAMN` — every one the
 *    table in §6 marks mandatory for 4I — and `#ORGNR` when known), then the
 *    vouchers. No chart of accounts (`#KONTO` is optional in 4I: the
 *    accounts are the workspace's own choice and exist in its chart; naming
 *    them here would warn wherever the chart names them differently), no
 *    checksum (`#KSUMMA`, optional, §10.3);
 *  - one `#VER` per voucher with its series and NO number — "vid import …
 *    kan serie och/eller vernr lämnas tomma; i detta fall åsätts …
 *    verifikationsnummer av redovisningsprogrammet" (§11 #VER 6) — and its
 *    `#TRANS` rows inside braces on lines of their own (§5.4), summing to
 *    zero (#TRANS 4);
 *  - IBM PC-8, code page 437 (§5.8; `#FORMAT PC8` is the only value, §11);
 *    amounts with a point and at most two decimals, a minus before, never a
 *    plus (§5.9); dates `ÅÅÅÅMMDD` (§5.10); text fields quoted, a quote
 *    inside preceded by a backslash, no control characters (§5.7); CRLF
 *    (a CR before the LF is allowed, §5.5).
 *
 * Text that CP437 cannot carry is spelled the nearest way it can (ø → o,
 * curly quotes → straight, € → EUR, accents stripped), else `?`. A backslash
 * in text becomes `/`: §5.7 gives it one meaning, the escape before a quote,
 * and a name ending in one would otherwise swallow its closing quote.
 */

/** CP437's bytes 0x80–0xAF, as the code points they print. */
const CP437_80_AF: readonly number[] = [
  0xc7, 0xfc, 0xe9, 0xe2, 0xe4, 0xe0, 0xe5, 0xe7, 0xea, 0xeb, 0xe8, 0xef, 0xee, 0xec, 0xc4, 0xc5, // 0x80–0x8F
  0xc9, 0xe6, 0xc6, 0xf4, 0xf6, 0xf2, 0xfb, 0xf9, 0xff, 0xd6, 0xdc, 0xa2, 0xa3, 0xa5, 0x20a7, 0x192, // 0x90–0x9F
  0xe1, 0xed, 0xf3, 0xfa, 0xf1, 0xd1, 0xaa, 0xba, 0xbf, 0x2310, 0xac, 0xbd, 0xbc, 0xa1, 0xab, 0xbb, // 0xA0–0xAF
];
/** …and the few of 0xE0–0xFF a name or a note might hold (the rest are Greek and mathematics). */
const CP437_HIGH_EXTRA: readonly (readonly [number, number])[] = [
  [0xdf, 0xe1], // ß
  [0xb5, 0xe6], // µ
  [0xb1, 0xf1], // ±
  [0xf7, 0xf6], // ÷
  [0xb0, 0xf8], // °
  [0xb7, 0xfa], // ·
  [0xb2, 0xfd], // ²
];

/** Code point → CP437 byte, for everything above ASCII that CP437 has and we write. */
const TO_CP437: ReadonlyMap<number, number> = new Map([
  ...CP437_80_AF.map((cp, i) => [cp, 0x80 + i] as const),
  ...CP437_HIGH_EXTRA,
]);
const FROM_CP437: ReadonlyMap<number, number> = new Map([...TO_CP437.entries()].map(([cp, b]) => [b, cp] as const));

/** What CP437 lacks, spelled the nearest way it can — by code point, so no escape sequence is needed here. */
const NEAREST: ReadonlyMap<number, string> = new Map([
  [0xf8, "o"], // ø
  [0xd8, "O"], // Ø
  [0x153, "oe"], // œ
  [0x152, "OE"], // Œ
  [0x142, "l"], // ł
  [0x141, "L"], // Ł
  [0x111, "d"], // đ
  [0x110, "D"], // Đ
  [0xf0, "d"], // ð
  [0xd0, "D"], // Ð
  [0xfe, "th"], // þ
  [0xde, "Th"], // Þ
  [0x2018, "'"],
  [0x2019, "'"],
  [0x201a, "'"],
  [0x2032, "'"],
  [0x201c, '"'],
  [0x201d, '"'],
  [0x201e, '"'],
  [0x2033, '"'],
  [0x2013, "-"],
  [0x2014, "-"],
  [0x2212, "-"],
  [0x2026, "..."],
  [0x20ac, "EUR"],
  [0xa0, " "], // no-break space
  [0x2009, " "], // thin space
  [0x202f, " "], // narrow no-break space
]);

const encodable = (cp: number): boolean => (cp >= 0x20 && cp < 0x7f) || TO_CP437.has(cp);

/**
 * Text as a field may hold it, still as a JS string: whitespace controls
 * (TAB, CR, LF…) become spaces and runs of spaces one, other controls go
 * (§5.7: "Kontrolltecken får ej förekomma inom en textsträng"), everything
 * CP437 lacks is spelled nearest or `?`, and the ends are trimmed.
 */
export function sieText(raw: string): string {
  let out = "";
  // Composed first: a name typed or pasted decomposed ("A" + a combining
  // ring, as macOS and many PDFs write it) is "Å", never "A?" (both reviews).
  for (const ch of raw.normalize("NFC")) {
    const cp = ch.codePointAt(0) ?? 0;
    // A combining mark still alone after composing has no letter to sit on.
    if (cp >= 0x300 && cp <= 0x36f) continue;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0b || cp === 0x0c || cp === 0x0d || cp === 0x85 || cp === 0x2028 || cp === 0x2029) {
      out += " ";
      continue;
    }
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    if (encodable(cp)) {
      out += ch;
      continue;
    }
    const near = NEAREST.get(cp);
    if (near !== undefined) {
      out += near;
      continue;
    }
    // Decomposed, its marks dropped (é → e, ł has none and was handled above).
    let base = "";
    for (const part of ch.normalize("NFKD")) {
      const p = part.codePointAt(0) ?? 0;
      if (p >= 0x300 && p <= 0x36f) continue;
      base += encodable(p) ? part : "?";
    }
    out += base === "" ? "?" : base;
  }
  return out.replace(/ {2,}/g, " ").trim();
}

/** A text field, quoted (§5.7): a backslash becomes `/`, a quote is preceded by one. */
export function sieField(raw: string): string {
  return `"${sieText(raw).replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
}

/** A line of the file as CP437 bytes. Every character in it went through `sieText` or is the syntax's own ASCII. */
function encodeLine(line: string): number[] {
  const bytes: number[] = [];
  for (const ch of line) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x20 && cp < 0x7f) bytes.push(cp);
    else {
      const b = TO_CP437.get(cp);
      if (b === undefined) throw new Error("sie: a character CP437 cannot carry reached the writer");
      bytes.push(b);
    }
  }
  return bytes;
}

/** CP437 bytes back to text — the tests' and the dbtests' reader. */
export function decodeCp437(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : String.fromCodePoint(FROM_CP437.get(b) ?? 0x3f);
  return out;
}

/** `YYYY-MM-DD` → `ÅÅÅÅMMDD` (§5.10). */
const sieDate = (day: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("sie: a date is YYYY-MM-DD");
  return day.replace(/-/g, "");
};

/**
 * A Swedish organisation number as §11 #ORGNR wants it, "nnnnnn-nnnn", or
 * null when it is not ten digits (twelve with the century, as a sole
 * trader's personal number may be written, loses the century).
 */
export function sieOrgNr(raw: string | null): string | null {
  if (raw === null) return null;
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length === 12 ? digits.slice(2) : digits;
  return ten.length === 10 ? `${ten.slice(0, 6)}-${ten.slice(6)}` : null;
}

export type SieRow = { readonly account: string; readonly amount: Minor };

export type SieVoucher = {
  /** `YYYY-MM-DD` — the voucher's date (the invoice's). */
  readonly date: string;
  readonly text: string;
  readonly rows: readonly SieRow[];
};

/** A voucher series as §11 #VER 4–5 allows it: letters and digits. */
export const SIE_SERIES = /^[A-Za-z0-9]{1,10}$/;
const ACCOUNT = /^\d{4}$/;

/**
 * The file's bytes. Throws — a bug, never a member's input — when a voucher
 * does not balance, has no rows, or names an account that is not four digits.
 */
export function sieFile(input: {
  readonly company: { readonly legalName: string; readonly orgNr: string | null };
  /** `YYYY-MM-DD` — the day the file was made (`#GEN`). */
  readonly madeOn: string;
  readonly series: string;
  readonly vouchers: readonly SieVoucher[];
}): Uint8Array {
  if (!SIE_SERIES.test(input.series)) throw new Error("sie: a series is 1–10 letters or digits");
  const lines: string[] = [
    "#FLAGGA 0",
    '#PROGRAM "Fortleva" 1.0',
    "#FORMAT PC8",
    `#GEN ${sieDate(input.madeOn)}`,
    "#SIETYP 4",
    `#FNAMN ${sieField(input.company.legalName)}`,
  ];
  const orgNr = sieOrgNr(input.company.orgNr);
  if (orgNr !== null) lines.push(`#ORGNR ${orgNr}`);
  for (const v of input.vouchers) {
    if (v.rows.length === 0) throw new Error("sie: a voucher has rows");
    if (v.rows.reduce((sum, r) => sum + r.amount, 0n) !== 0n) throw new Error("sie: a voucher balances");
    lines.push("", `#VER ${sieField(input.series)} "" ${sieDate(v.date)} ${sieField(v.text)}`, "{");
    for (const r of v.rows) {
      if (!ACCOUNT.test(r.account)) throw new Error("sie: an account is four digits");
      lines.push(`#TRANS ${r.account} {} ${formatFixed(r.amount, 2)}`);
    }
    lines.push("}");
  }
  const bytes = lines.flatMap((l) => [...encodeLine(l), 0x0d, 0x0a]);
  return Uint8Array.from(bytes);
}
