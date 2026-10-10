import { hoursQuantity } from "./hours-lines";

/**
 * THE TIME BREAKDOWN on an invoice's PDF (Phase 4 slice 110b; founder
 * decisions C80 (d), C81). Pure: no database, so the unit suite covers it.
 *
 * The page itself is written by the DATABASE — `invoice_hours_page()`
 * (migration 20261010210000), from the invoice's RECORD of the hours it
 * billed, called by `invoice_billed_hours_guard` as the invoice leaves DRAFT
 * (frozen from then on) and, on a draft, by the page's preview and the issue
 * fingerprint — so what the issuer saw is what is frozen. A row is a day, the
 * title of a task the client may see (the time report's one rule, held in
 * SQL) or null for "Other work", and the billed seconds. Never a person, a
 * note, a rate or a task the client may not see.
 *
 * This module reads that JSON by its SHAPE (anything malformed is
 * `HoursPageUnreadable`: a PDF is drawn once and archived, so a degraded
 * drawing would be the record forever) — and never more strictly than the
 * database writes it (the design review's M1: a title that is only Unicode
 * spaces, or long in UTF-16 units, is legal SQL output; refusing it would
 * have made one invoice's PDF impossible for good). A title blank to
 * JavaScript reads as "Other work". It then formats it: hours and minutes,
 * "12:30" (C81 (b)) — or, when some hour on the page is not a whole number of
 * minutes (a project that does not round bills raw seconds), "12:30:05"
 * throughout, so the page still adds up exactly.
 */

export type HoursPageRow = {
  /** `YYYY-MM-DD` — the day the hour was tracked, as recorded. */
  readonly date: string;
  /** A task the client may see, by title; null — "Other work". */
  readonly task: string | null;
  readonly seconds: number;
};

export type HoursPageLine = { readonly lineId: string; readonly rows: readonly HoursPageRow[] };

/** The page as the database wrote it, validated. */
export type HoursPage = { readonly lines: readonly HoursPageLine[] };

/** One line of the page as printed: its text from the frozen line, and its hours' total. */
export type HoursPagePrintLine = HoursPageLine & {
  readonly description: string;
  /** The rows' seconds, summed. */
  readonly seconds: number;
  /** Those seconds as hours in thousandths — the decimal a line made from them said (`hoursQuantity`). */
  readonly quantity: bigint;
};

export type HoursPagePrint = {
  readonly lines: readonly HoursPagePrintLine[];
  /** Some row is not a whole number of minutes: every figure prints with seconds. */
  readonly withSeconds: boolean;
};

export class HoursPageUnreadable extends Error {
  constructor(what: string) {
    super(`time breakdown: ${what}`);
    this.name = "HoursPageUnreadable";
  }
}

/**
 * The most rows a time breakdown may have (the design review's M2): measured
 * 2026-10-10, react-pdf draws 1 000 rows (about 30 pages) in 2–4 s but 2 000 in
 * about 25 s — layout grows faster than the rows — and the page is drawn once,
 * frozen, by the issuer's own request. Past it the issue is refused
 * (`hoursPageTooLong`): untick the breakdown or split the invoice.
 */
export const HOURS_PAGE_ROWS_MAX = 1000;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null && !Array.isArray(v);

const isDay = (v: unknown): v is string => {
  if (typeof v !== "string" || !ISO_DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/**
 * The page's JSON — as stored on an issued invoice, or as the function
 * returns it for a draft — read against the invoice's own line ids. Null in,
 * null out (no hours, or no tick). `dropUnknownLines` is the draft PREVIEW's
 * (the design review's L3): a line added between its two reads is left out of
 * the preview rather than failing the page — the issue fingerprint, not the
 * preview, is what holds the issue to what was seen.
 */
export function readHoursPage(
  raw: unknown,
  lineIds: ReadonlySet<string>,
  opts: { readonly dropUnknownLines?: boolean } = {},
): HoursPage | null {
  if (raw === null || raw === undefined) return null;
  if (!isObject(raw)) throw new HoursPageUnreadable("not an object");
  if (raw["version"] !== 1) throw new HoursPageUnreadable("version");
  const lines = raw["lines"];
  if (!Array.isArray(lines) || lines.length === 0) throw new HoursPageUnreadable("lines");
  const seen = new Set<string>();
  const out: HoursPageLine[] = [];
  for (const line of lines) {
    if (!isObject(line)) throw new HoursPageUnreadable("a line");
    const lineId = line["lineId"];
    if (typeof lineId !== "string" || seen.has(lineId)) throw new HoursPageUnreadable("a line's id");
    seen.add(lineId);
    if (!lineIds.has(lineId)) {
      if (opts.dropUnknownLines) continue;
      throw new HoursPageUnreadable("a line's id");
    }
    const rows = line["rows"];
    if (!Array.isArray(rows) || rows.length === 0) throw new HoursPageUnreadable("a line's rows");
    const parsed: HoursPageRow[] = [];
    for (const row of rows) {
      if (!isObject(row)) throw new HoursPageUnreadable("a row");
      const { date, task, seconds } = row;
      if (!isDay(date)) throw new HoursPageUnreadable("a row's date");
      if (task !== null && typeof task !== "string") throw new HoursPageUnreadable("a row's task");
      if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 0) throw new HoursPageUnreadable("a row's seconds");
      // A title blank to JavaScript (only NBSP, ideographic spaces…) is "Other work".
      parsed.push({ date, task: task === null || task.trim() === "" ? null : task, seconds });
    }
    out.push({ lineId, rows: parsed });
  }
  return out.length === 0 ? null : { lines: out };
}

/** The page with each line's own text (from the frozen lines) and its totals. */
export function hoursPagePrint(page: HoursPage, lines: readonly { readonly id: string; readonly description: string }[]): HoursPagePrint {
  const text = new Map(lines.map((l) => [l.id, l.description] as const));
  const printed = page.lines.map((l) => {
    const description = text.get(l.lineId);
    if (description === undefined) throw new HoursPageUnreadable("a line's id");
    const seconds = l.rows.reduce((sum, r) => sum + r.seconds, 0);
    return { ...l, description, seconds, quantity: hoursQuantity(seconds) };
  });
  return { lines: printed, withSeconds: page.lines.some((l) => l.rows.some((r) => r.seconds % 60 !== 0)) };
}

/**
 * The longest task title the breakdown PRINTS, in characters (the code and
 * security reviews' low): the database keeps up to 500, and react-pdf's layout
 * time grows with the text it wraps, on a request that blocks the server — a
 * page at the row cap must stay drawable. The record keeps the whole title.
 */
export const PRINTED_TASK_MAX = 120;

/**
 * A task title as the breakdown prints it — on the PDF and on its preview
 * card alike: every run of whitespace (line breaks included) one space, at
 * most `PRINTED_TASK_MAX` characters, "…" where it was cut.
 */
export function printedTask(title: string): string {
  let out = "";
  let gap = false;
  for (const ch of title) {
    // Whitespace by JavaScript's own reading (Unicode spaces, tabs, breaks).
    if (ch.trim() === "") {
      gap = out !== "";
      continue;
    }
    if (gap) out += " ";
    gap = false;
    out += ch;
  }
  const chars = [...out];
  return chars.length > PRINTED_TASK_MAX ? `${chars.slice(0, PRINTED_TASK_MAX - 1).join("").trimEnd()}…` : out;
}

/** Every task title on a page the database wrote — for the issue dialog's payment-text caution; [] when none. */
export function hoursPageTitles(raw: unknown): string[] {
  if (!isObject(raw) || !Array.isArray(raw["lines"])) return [];
  return (raw["lines"] as unknown[]).flatMap((l) =>
    isObject(l) && Array.isArray(l["rows"])
      ? (l["rows"] as unknown[]).flatMap((r) => (isObject(r) && typeof r["task"] === "string" ? [r["task"]] : []))
      : [],
  );
}

/** How big a page the database wrote is — for the issue's audit row (never what it says); null when none. */
export function hoursPageSize(raw: unknown): { readonly lines: number; readonly rows: number } | null {
  if (!isObject(raw) || !Array.isArray(raw["lines"])) return null;
  const lines = raw["lines"] as unknown[];
  const rows = lines.reduce<number>((n, l) => n + (isObject(l) && Array.isArray(l["rows"]) ? l["rows"].length : 0), 0);
  return { lines: lines.length, rows };
}

/**
 * Seconds as hours and minutes — "0:45", "12:30", "1234:05" — or, with
 * `withSeconds`, "12:30:05". The same digits in both languages. Without
 * seconds the value must be whole minutes (the caller decides the mode for
 * the whole page, `hoursPagePrint`'s `withSeconds`); a stray remainder is
 * rounded to the nearest minute, half up, rather than dropped.
 */
export function printHoursMinutes(seconds: number, withSeconds: boolean): string {
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("printHoursMinutes: a whole, non-negative number of seconds");
  const total = withSeconds ? seconds : Math.floor((seconds + 30) / 60) * 60;
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  return withSeconds ? `${h}:${mm}:${String(total % 60).padStart(2, "0")}` : `${h}:${mm}`;
}
