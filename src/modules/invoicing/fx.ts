import { ecbDailyRatesUrl, fxTransportKind } from "@/config";
import { fail } from "@/lib/domain-error";

import { divRoundHalfAway, type Minor, type VatGroup } from "./money";

/**
 * THE EXCHANGE RATE FOR VAT IN SEK (Phase 4 slice 108; founder decision C76,
 * "not asked, decided by the law's text"). An invoice in another currency that
 * carries Swedish VAT must also state that VAT in Swedish kronor
 * (mervärdesskattelagen 2023:200), converted at the European Central Bank's
 * latest published rate or Nasdaq Stockholm's middle rate. Fortleva uses the
 * ECB's daily reference rates: one public XML file, euro-based, published on
 * TARGET business days around 16:00 CET — so "the latest" is usually
 * yesterday's file in the morning, and up to four days old over Easter.
 *
 * A rate is SEK per ONE unit of the invoice's currency in MILLIONTHS (the
 * `invoice.fx_rate_to_sek numeric(12,6)` column): for euro the file's SEK
 * figure itself; for any other currency the cross rate SEK/EUR ÷ CUR/EUR,
 * computed exactly in integers and rounded half away from zero to six
 * decimals (Postgres's `round`, as everywhere in `money.ts`).
 *
 * The VAT in SEK is per rate — each rate's VAT × the rate, rounded to the
 * öre — and its total is their sum; the issue guard recomputes it the same way
 * (migration 20261009200000).
 */

/** SEK per one unit of a currency, in millionths, and the ECB file's date (`YYYY-MM-DD`). */
export type FxRate = { readonly micros: bigint; readonly date: string };

export type EcbDaily = { readonly date: string; readonly perEur: ReadonlyMap<string, string> };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RATE_RE = /^\d{1,7}(?:\.\d{1,8})?$/;

/** The daily file, read: its date and every currency's units per euro (as the file's decimal text). */
export function parseEcbDaily(xml: string): EcbDaily {
  const day = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>/.exec(xml);
  if (!day || !DATE_RE.test(day[1]!)) throw new Error("ECB rates: no dated <Cube> in the file");
  const perEur = new Map<string, string>();
  for (const m of xml.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/>/g)) {
    const [, currency, rate] = m;
    if (currency && rate && RATE_RE.test(rate)) perEur.set(currency, rate);
  }
  if (!perEur.has("SEK")) throw new Error("ECB rates: no SEK rate in the file");
  return { date: day[1]!, perEur };
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
const MAX_RATES_BYTES = 64 * 1024;

/**
 * The one outbound GET (SECURITY §9.2): five seconds, NO redirect followed
 * (the push rule — a fixed URL has no business moving), and a body cap read
 * before parsing (the security review's nit).
 */
const fetchText: FetchText = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000), cache: "no-store", redirect: "error" });
  if (!res.ok) throw new Error(`ECB rates: HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_RATES_BYTES) throw new Error("ECB rates: too large");
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
    if (size > MAX_RATES_BYTES) {
      await reader.cancel();
      throw new Error("ECB rates: too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * Today's SEK rate for `currency` — the ECB's latest file, or the harnesses'
 * fixed table. Any failure to fetch or read it is `INVOICE_FX_UNAVAILABLE`, a
 * sentence asking to try again: an invoice is never issued at a guessed rate.
 */
export async function latestSekRate(
  currency: string,
  opts: { readonly fetchText?: FetchText; readonly now?: Date } = {},
): Promise<FxRate> {
  if (!opts.fetchText && fxTransportKind === "fixed") {
    const daily = { date: yesterdayUtc(opts.now ?? new Date()), perEur: FIXED_PER_EUR };
    return { micros: sekPerUnit(daily, currency), date: daily.date };
  }
  let daily: EcbDaily;
  try {
    daily = parseEcbDaily(await (opts.fetchText ?? fetchText)(ecbDailyRatesUrl));
  } catch {
    return fail("INVOICE_FX_UNAVAILABLE");
  }
  return { micros: sekPerUnit(daily, currency), date: daily.date };
}
