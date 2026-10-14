import { createHash } from "node:crypto";

import { CruxError, type CruxFormFactor, type CruxHistory, type CruxMetric, type CruxPeriod, type CruxTransport } from "./types";

/**
 * THE FAKE GOOGLE (Phase 6 slice 118) — the `fake` transport, which
 * `src/config` allows only where it is set explicitly (the harnesses) and
 * never on a production build off loopback. Pure and stateless: the series
 * is a function of the origin, the device kind and the week, so two
 * processes (the e2e server and `seed-cli`) and two runs agree.
 *
 * WHAT IT ANSWERS, by the origin's host:
 *  - `nodata.…`  → null (Google has no data — the usual answer for a small site);
 *  - `down.…`    → an `unknown` failure (Google unreachable);
 *  - `refused.…` → a `refused` failure with a 400 (a bad origin);
 *  - `nokey.…`   → a `refused` failure with a 403 (the key refused);
 *  - `rate.…`    → phones answered, then computers refused with a 429 (the
 *                  per-minute quota) — so a partial answer is planted too;
 *  - `slow.…`    → a site in Google's Poor band on every metric;
 *  - anything else → 40 periods of plausible numbers that drift week by
 *    week around a per-origin baseline, phones slower than computers.
 *
 * Periods end on the Saturdays before `now`, as Google's do.
 */

const DAY_MS = 86_400_000;

/** A stable 0–1 from a string. */
const unit = (s: string): number => parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16) / 0xffffffff;

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** The last Saturday at or before `now` (UTC), as a UTC midnight date. */
export function lastSaturday(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const back = (d.getUTCDay() + 1) % 7; // Saturday is 6 → 0 back; Sunday 0 → 1 back
  return new Date(d.getTime() - back * DAY_MS);
}

const round = (v: number, places: number): number => Math.round(v * 10 ** places) / 10 ** places;

/** Shares of visits by band, derived from where the p75 sits against the band's edges. */
function sharesOf(p75: number, goodMax: number, needsMax: number): Pick<CruxMetric, "good" | "needsWork" | "poor"> {
  const r = p75 / goodMax;
  const good = round(Math.min(0.97, Math.max(0.05, 1.05 - 0.55 * r)), 4);
  const poor = round(Math.min(0.6, Math.max(0.01, ((p75 - goodMax) / (needsMax - goodMax)) * 0.3)), 4);
  const needsWork = round(Math.max(0, 1 - good - poor), 4);
  return { good, needsWork, poor };
}

function metric(base: number, spread: number, week: number, seed: string, goodMax: number, needsMax: number, places: number): CruxMetric {
  const drift = Math.sin(week / 5 + unit(`${seed}:phase`) * 6) * 0.5 + (unit(`${seed}:${week}`) - 0.5) * 0.4;
  const p75 = round(Math.max(0, base + spread * drift), places);
  return { p75, ...sharesOf(p75, goodMax, needsMax) };
}

export const fakeCrux: CruxTransport = {
  kind: "fake",

  async history(origin, formFactor) {
    const host = new URL(origin).hostname;
    if (host.startsWith("nodata.")) return null;
    if (host.startsWith("down.")) throw new CruxError("unknown", 503);
    if (host.startsWith("refused.")) throw new CruxError("refused", 400);
    if (host.startsWith("nokey.")) throw new CruxError("refused", 403);
    if (host.startsWith("rate.") && formFactor === "DESKTOP") throw new CruxError("rate", 429);
    return fakeHistory(origin, formFactor, host.startsWith("slow."), new Date());
  },
};

/** The deterministic series — exported so a test can pin it against a clock of its own. */
export function fakeHistory(origin: string, formFactor: CruxFormFactor, slow: boolean, now: Date): CruxHistory {
  const seed = `${origin}|${formFactor}`;
  const phone = formFactor === "PHONE";
  const lcpBase = slow ? 5200 : phone ? 2300 + unit(`${seed}:lcp`) * 1400 : 1500 + unit(`${seed}:lcp`) * 900;
  const inpBase = slow ? 620 : phone ? 150 + unit(`${seed}:inp`) * 180 : 70 + unit(`${seed}:inp`) * 110;
  const clsBase = slow ? 0.32 : 0.02 + unit(`${seed}:cls`) * 0.16;
  const end = lastSaturday(now);
  const periods: CruxPeriod[] = [];
  for (let i = 39; i >= 0; i -= 1) {
    const periodEnd = new Date(end.getTime() - i * 7 * DAY_MS);
    const periodStart = new Date(periodEnd.getTime() - 27 * DAY_MS);
    const week = 39 - i;
    periods.push({
      start: iso(periodStart),
      end: iso(periodEnd),
      lcp: metric(lcpBase, 600, week, `${seed}:lcp`, 2500, 4000, 0),
      inp: metric(inpBase, 80, week, `${seed}:inp`, 200, 500, 0),
      cls: metric(clsBase, 0.05, week, `${seed}:cls`, 0.1, 0.25, 3),
    });
  }
  return { periods };
}
