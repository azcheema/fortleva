import { cruxApiKey, cruxHistoryUrl } from "@/config";
import { readCappedText } from "@/lib/capped-body";

import { CRUX_METRIC_NAMES, parseHistory } from "./parse";
import { CruxError, type CruxTransport } from "./types";

/**
 * GOOGLE ITSELF (Phase 6 slice 118): one POST per origin and device kind to
 * the History API, 40 periods asked for, a timeout that never runs past the
 * caller's deadline, the answer read against a 1 MB cap and parsed field by
 * field (`parse.ts`). The key is read from `src/config` at the moment the
 * request is sent and goes nowhere else — a request HEADER, never the URL
 * (which fetch logs and error causes print), not an error, not a log line
 * (`CruxError` carries the kind and the status only).
 *
 * Google's answers: 404 is "no data for this origin" (the usual answer for a
 * small site), 400 a bad origin, 403 the key refused or over its daily
 * budget, 429 the per-minute quota (150 a minute per Google project, shared
 * with the daily API), 5xx an outage.
 */

const MAX_ANSWER_BYTES = 1_000_000;
const CALL_TIMEOUT_MS = 15_000;
/** Never start a call that could end within this of the caller's deadline. */
const DEADLINE_MARGIN_MS = 3_000;

export const liveCrux: CruxTransport = {
  kind: "live",

  async history(origin, formFactor, deadline) {
    const key = cruxApiKey();
    if (!key) throw new CruxError("refused", null);
    const left = deadline - Date.now() - DEADLINE_MARGIN_MS;
    if (left < 1_000) throw new CruxError("unknown", null);
    let res: Response;
    try {
      // The key goes in a HEADER, never the URL (the pre-apply review's 2):
      // Next's dev fetch log, an OTel span and undici's `fetch failed` cause
      // all name the URL, and none of them name a header.
      res = await fetch(cruxHistoryUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-Goog-Api-Key": key },
        body: JSON.stringify({ origin, formFactor, metrics: CRUX_METRIC_NAMES, collectionPeriodCount: 40 }),
        signal: AbortSignal.timeout(Math.min(CALL_TIMEOUT_MS, left)),
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      // A timeout, the network, a redirect refused.
      throw new CruxError("unknown", null);
    }
    if (res.status !== 200) {
      // The body is never read on a refusal — released, so the socket is too.
      await res.body?.cancel();
      if (res.status === 404) return null;
      if (res.status === 429) throw new CruxError("rate", 429);
      if (res.status === 400 || res.status === 403) throw new CruxError("refused", res.status);
      if (res.status >= 500) throw new CruxError("unknown", res.status);
      throw new CruxError("shape", res.status);
    }
    const text = await readCappedText(res, MAX_ANSWER_BYTES);
    if (text === null) throw new CruxError("shape", 200);
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      throw new CruxError("shape", 200);
    }
    return parseHistory(answer);
  },
};
