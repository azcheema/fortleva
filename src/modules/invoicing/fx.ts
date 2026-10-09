import { ecbDailyRatesUrl, ecbHistoryRatesUrl, fxTransportKind } from "@/config";
import { fail } from "@/lib/domain-error";
import { addDays } from "@/lib/week";

import { divRoundHalfAway, type Minor, type VatGroup } from "./money";

/**
 * THE EXCHANGE RATE FOR VAT IN SEK (Phase 4 slice 108; founder decision C76,
 * "not asked, decided by the law's text"). An invoice in another currency that
 * carries Swedish VAT must also state that VAT in Swedish kronor
 * (mervärdesskattelagen 2023:200), converted at the European Central Bank's
 * latest published rate or Nasdaq Stockholm's middle rate. Fortleva uses the
 * ECB's daily reference rates: public XML files, euro-based, published on
 * TARGET business days around 16:00 CET.
 *
 * WHICH DAY'S RATE (founder decision C78 (a), slice 108b): the rate of the day
 * the WORK ENDED — the last day of the invoice's work period, or the invoice
 * date when it names none, and never a day after the invoice date (work
 * invoiced in advance takes the invoice date's latest rate, which Skatteverket
 * accepts). That day is `rateDayFor`; its rate is the latest the ECB published
 * ON OR BEFORE it — today's file when it is the invoice date, the ECB's 90-day
 * history file otherwise (a weekend or a TARGET holiday falls back to the last
 * business day; Easter is a four-day gap). A day older than the history file
 * reaches is refused in a sentence (`INVOICE_FX_TOO_OLD`).
 *
 * A rate is SEK per ONE unit of the invoice's currency in MILLIONTHS (the
 * `invoice.fx_rate_to_sek numeric(12,6)` column): for euro the file's SEK
 * figure itself; for any other currency the cross rate SEK/EUR ÷ CUR/EUR,
 * computed exactly in integers and rounded half away from zero to six
 * decimals (Postgres's `round`, as everywhere in `money.ts`).
 *
 * The VAT in SEK is per rate — each rate's VAT × the rate, rounded to the
 * öre — and its total is their sum; the issue guard recomputes it the same way
 * (migration 20261009200000) and holds the rate's date to the ten days before
 * the rate day (migration 20261010090000).
 */

/** SEK per one unit of a currency, in millionths, and the ECB file's date (`YYYY-MM-DD`). */
export type FxRate = { readonly micros: bigint; readonly date: string };

export type EcbDaily = { readonly date: string; readonly perEur: ReadonlyMap<string, string> };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RATE_RE = /^\d{1,7}(?:\.\d{1,8})?$/;

/** A `YYYY-MM-DD` that is a real calendar day (2026-02-30 is not). */
const isCalendarDay = (day: string): boolean => {
  if (!DATE_RE.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
};

/**
 * Every dated `<Cube time>` in an ECB file, newest first — the daily file has
 * one, the history file one per business day. EACH DAY'S RATES FROM ITS OWN
 * BLOCK (the design review's medium: one scan across the history file would
 * fold every day's rows into one map, the oldest day's winning). Its currency
 * cubes are self-closing, so a dated cube ends at the first `</Cube>` after
 * it. A day that is not a calendar day, a day twice, or a day without SEK is
 * a file we do not understand — refused, never skipped.
 */
export function parseEcbDays(xml: string): EcbDaily[] {
  const days: EcbDaily[] = [];
  const seen = new Set<string>();
  // A LINEAR scan, never a lazy regex across the body (the security review's
  // low: thousands of openers without a closer made `[\s\S]*?` rescan to the
  // end each time — seconds of a blocked event loop on a hostile 512 KB file).
  const opener = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>/g;
  for (let m = opener.exec(xml); m !== null; m = opener.exec(xml)) {
    if (days.length >= MAX_ECB_DAYS) throw new Error("ECB rates: more days than any ECB file holds");
    const date = m[1];
    if (!date || !isCalendarDay(date)) throw new Error("ECB rates: a dated <Cube> that is not a day");
    if (seen.has(date)) throw new Error(`ECB rates: ${date} twice`);
    seen.add(date);
    const start = opener.lastIndex;
    const end = xml.indexOf("</Cube>", start);
    if (end < 0) throw new Error(`ECB rates: ${date} never closes`);
    const body = xml.slice(start, end);
    // A day inside a day is a file we do not understand.
    if (/<Cube\s+time=/.test(body)) throw new Error(`ECB rates: a day inside ${date}`);
    const perEur = new Map<string, string>();
    for (const c of body.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/>/g)) {
      const [, currency, rate] = c;
      if (!currency || !rate || !RATE_RE.test(rate)) continue;
      if (perEur.has(currency)) throw new Error(`ECB rates: ${currency} twice on ${date}`);
      perEur.set(currency, rate);
    }
    // A day without SEK is a file we do not understand — never a day to skip.
    if (!perEur.has("SEK")) throw new Error(`ECB rates: no SEK rate on ${date}`);
    days.push({ date, perEur });
    opener.lastIndex = end;
  }
  if (days.length === 0) throw new Error("ECB rates: no dated <Cube> in the file");
  return days.sort((a, b) => (a.date === b.date ? 0 : a.date > b.date ? -1 : 1));
}

/** The 90-day file holds about 65 business days; far more is not an ECB file. */
const MAX_ECB_DAYS = 200;

/** The daily file, read: its ONE day and every currency's units per euro (as the file's decimal text). */
export function parseEcbDaily(xml: string): EcbDaily {
  const days = parseEcbDays(xml);
  if (days.length !== 1) throw new Error("ECB rates: the daily file holds one day");
  return days[0]!;
}

/** A decimal text of up to eight decimals as an integer of eight. */
const scaled8 = (text: string): bigint => {
  const [int, frac = ""] = text.split(".");
  return BigInt(`${int}${frac.padEnd(8, "0")}`);
};

/** SEK per one unit of `currency`, in millionths, from the day's file. */
export function sekPerUnit(daily: EcbDaily, currency: string): bigint {
  const sek = daily.perEur.get("SEK");
  if (!sek) throw new Error("ECB rates: no SEK rate");
  if (currency === "EUR") return divRoundHalfAway(scaled8(sek) * 1_000_000n, 100_000_000n);
  const cur = daily.perEur.get(currency);
  if (!cur) return fail("INVOICE_FX_UNAVAILABLE");
  const curScaled = scaled8(cur);
  if (curScaled <= 0n) return fail("INVOICE_FX_UNAVAILABLE");
  // (SEK/EUR) ÷ (CUR/EUR) = SEK/CUR, both at eight decimals: the scales cancel.
  return divRoundHalfAway(scaled8(sek) * 1_000_000n, curScaled);
}

/** One rate's VAT in SEK: the VAT × the rate (millionths), to the öre, half away from zero. */
export const vatInSek = (vat: Minor, micros: bigint): Minor => divRoundHalfAway(vat * micros, 1_000_000n);

/** The VAT in SEK per rate group, and their sum — what the invoice prints and stores. */
export function vatGroupsInSek(
  groups: readonly VatGroup[],
  micros: bigint,
): { readonly groups: readonly (VatGroup & { readonly vatSek: Minor })[]; readonly totalSek: Minor } {
  const withSek = groups.map((g) => ({ ...g, vatSek: vatInSek(g.vat, micros) }));
  return { groups: withSek, totalSek: withSek.reduce((sum, g) => sum + g.vatSek, 0n) };
}

/** Whether an invoice needs a rate: another currency AND some VAT. */
export const needsSekVat = (currency: string, vatTotal: Minor): boolean => currency !== "SEK" && vatTotal !== 0n;

/**
 * The day whose rate the VAT in SEK takes (C78 (a)): the work period's last
 * day, the invoice date without one — never after the invoice date. Both
 * `YYYY-MM-DD`. The issue guard restates it (`least(coalesce(period_end,
 * issue_date), issue_date)`).
 */
export const rateDayFor = (issueDate: string, periodEnd: string | null): string =>
  periodEnd !== null && periodEnd < issueDate ? periodEnd : issueDate;

/** The oldest ECB file an issue accepts, in days before its rate day — the guard's window (Easter is a four-day gap). */
export const FX_MAX_AGE_DAYS = 10;

/**
 * How far back the ECB's history file reaches, in days: a rate day older than
 * this is refused before anything is fetched (C78 (a): "the work period ended
 * too long ago"), and one the file turns out not to reach is refused the same.
 */
export const FX_HISTORY_DAYS = 90;

/** Whether a rate day is older than the history the ECB publishes. */
export const rateDayTooOld = (rateDay: string, issueDate: string): boolean => rateDay < addDays(issueDate, -FX_HISTORY_DAYS);

/**
 * The harnesses' table (`FX_TRANSPORT=fixed`): the ECB file of 2026-10-08,
 * dated yesterday wherever it is read, so an issue today accepts it.
 */
const FIXED_PER_EUR: ReadonlyMap<string, string> = new Map([
  ["USD", "1.1186"],
  ["GBP", "0.84698"],
  ["NOK", "10.7170"],
  ["DKK", "7.4739"],
  ["SEK", "11.1940"],
]);

const yesterdayUtc = (now: Date): string => new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);

/** How the file is fetched; the dbtests pass their own. */
export type FetchText = (url: string) => Promise<string>;

/** The daily file is under 2 KB; anything far bigger is not it. */
const MAX_DAILY_BYTES = 64 * 1024;
/** The 90-day history file is ~90 KB (≈ 64 business days × 30 currencies). */
const MAX_HISTORY_BYTES = 512 * 1024;

/**
 * The outbound GET (SECURITY §9.2) — one of two fixed URLs: five seconds, NO
 * redirect followed (the push rule — a fixed URL has no business moving), and
 * a body cap read before parsing (the security review's nit).
 */
const fetchText: FetchText = async (url) => {
  const cap = url === ecbHistoryRatesUrl ? MAX_HISTORY_BYTES : MAX_DAILY_BYTES;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000), cache: "no-store", redirect: "error" });
  if (!res.ok) throw new Error(`ECB rates: HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > cap) throw new Error("ECB rates: too large");
  // Read in chunks and stop past the cap — a missing or false Content-Length
  // is bounded here, not only by the timeout (the fix-pass re-check's nit).
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new Error("ECB rates: too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * The SEK rate for `currency` on `rateDay` (`rateDayFor`) — the latest the ECB
 * published on or before it: today's file when the rate day is the invoice
 * date, the 90-day history file when it is earlier; the harnesses' fixed table
 * under `FX_TRANSPORT=fixed`. A rate day older than the history reaches is
 * `INVOICE_FX_TOO_OLD`; any failure to fetch or read a file is
 * `INVOICE_FX_UNAVAILABLE`, a sentence asking to try again: an invoice is
 * never issued at a guessed rate. Whether the date it returns is close enough
 * to the rate day is the issue's to judge (and the guard's).
 */
export async function sekRateFor(
  currency: string,
  day: { readonly rateDay: string; readonly issueDate: string },
  opts: { readonly fetchText?: FetchText; readonly now?: Date } = {},
): Promise<FxRate> {
  const { rateDay, issueDate } = day;
  if (rateDayTooOld(rateDay, issueDate)) return fail("INVOICE_FX_TOO_OLD");
  if (!opts.fetchText && fxTransportKind === "fixed") {
    const yesterday = yesterdayUtc(opts.now ?? new Date());
    const daily = { date: rateDay < yesterday ? rateDay : yesterday, perEur: FIXED_PER_EUR };
    return { micros: sekPerUnit(daily, currency), date: daily.date };
  }
  const fromHistory = rateDay < issueDate;
  let days: EcbDaily[];
  try {
    days = parseEcbDays(await (opts.fetchText ?? fetchText)(fromHistory ? ecbHistoryRatesUrl : ecbDailyRatesUrl));
  } catch {
    return fail("INVOICE_FX_UNAVAILABLE");
  }
  // A file dated after tomorrow is not the ECB's (no zone is more than a day
  // ahead of the invoice date).
  if (days[0]!.date > addDays(issueDate, 1)) return fail("INVOICE_FX_UNAVAILABLE");
  // The newest file on or before the rate day (`days` is newest first).
  const daily = days.find((d) => d.date <= rateDay);
  if (!daily) {
    // Every day in the file is after the rate day: the history does not reach
    // back that far. (Today's file dated after the invoice date cannot happen
    // in a Swedish workspace's zone; it would be "try again".)
    return fail(fromHistory ? "INVOICE_FX_TOO_OLD" : "INVOICE_FX_UNAVAILABLE");
  }
  return { micros: sekPerUnit(daily, currency), date: daily.date };
}
