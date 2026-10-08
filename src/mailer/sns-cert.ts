import { X509Certificate, type KeyObject } from "node:crypto";

import { isPinnedCertUrl } from "./sns";

/**
 * The certificate an SNS message was signed under, fetched from AWS (Phase 5
 * slice 103; `sns.ts` says why the webhook trusts it). Only a URL that passed
 * `isPinnedCertUrl` is ever fetched — AWS's own SNS host for our topic's
 * region, its certificate path — and the trust comes from TLS to that host,
 * not from anything in the file.
 *
 * - **No redirects** (`redirect: "error"`): a pinned URL that redirected would
 *   be a fetch of somewhere we did not pin.
 * - **Bounded**: five seconds, and a certificate is a few kilobytes — a larger
 *   answer is refused unread.
 * - **Inside its validity window**, or refused.
 * - **Cached per URL until it expires**, at most eight of them (SNS rotates its
 *   certificate rarely; a busy hour of bounces must not fetch it for each one).
 * - **A URL that was REFUSED is refused again for a minute without a fetch**,
 *   and **at most twenty uncached fetches a minute** leave this process (the
 *   design review's low): whoever learns our topic's ARN could otherwise make
 *   each request a fresh fetch of a made-up certificate name from AWS. In a
 *   warm process a genuine message names the certificate already cached, so
 *   neither bound touches it (a cold one is the residual below); past the cap
 *   the answer is "unavailable" — SNS retries.
 *   An "unavailable" is never remembered: the next message tries again.
 *
 * Answers the certificate's public key, `"refused"` when the URL is not pinned
 * or the file is not a valid certificate now (a 403: the message is not
 * ours), or `"unavailable"` when AWS could not be reached (a 503: SNS
 * retries, and the message is not lost).
 */

const FETCH_TIMEOUT_MS = 5_000;
const MAX_CERT_BYTES = 16 * 1024;
const MAX_CACHED = 8;
const REFUSED_FOR_MS = 60_000;
const MAX_REFUSED_REMEMBERED = 64;
const FETCHES_PER_MINUTE = 20;

type Cached = { readonly key: KeyObject; readonly until: number };
const cache = new Map<string, Cached>();
const refusedUntil = new Map<string, number>();
let fetchWindow = { start: 0, count: 0 };

export type CertAnswer = KeyObject | "refused" | "unavailable";

function rememberRefused(certUrl: string, now: number): "refused" {
  if (refusedUntil.size >= MAX_REFUSED_REMEMBERED) {
    const oldest = refusedUntil.keys().next().value;
    if (oldest !== undefined) refusedUntil.delete(oldest);
  }
  refusedUntil.set(certUrl, now + REFUSED_FOR_MS);
  return "refused";
}

/**
 * One fetch per URL at a time: concurrent messages share it (the security
 * review's low). What is NOT here, and why: a set of URLs that once served a
 * certificate, to skip the budget, was tried and taken out — a warm process
 * answers those from the cache before the budget is consulted, and a cold one
 * has no such set; it bought nothing. A stranger who knows the topic's ARN can
 * still spend a cold process's budget on made-up names and make genuine
 * feedback wait (503, SNS retries by the subscription's delivery policy, then
 * the dead-letter queue — RUNBOOK §9 steps 5 and 6); the fix is a secret in the
 * subscription URL — owed, PLAN §0.
 */
const inFlight = new Map<string, Promise<CertAnswer>>();

export async function loadSnsSigningKey(
  certUrl: string,
  snsHost: string,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<CertAnswer> {
  if (!isPinnedCertUrl(certUrl, snsHost)) return "refused";
  const at = now.getTime();
  const hit = cache.get(certUrl);
  if (hit && hit.until > at) return hit.key;
  if (hit) cache.delete(certUrl);
  const refused = refusedUntil.get(certUrl);
  if (refused !== undefined && refused > at) return "refused";
  const pending = inFlight.get(certUrl);
  if (pending) return pending;
  if (at - fetchWindow.start >= 60_000) fetchWindow = { start: at, count: 0 };
  if (fetchWindow.count >= FETCHES_PER_MINUTE) return "unavailable";
  fetchWindow.count += 1;
  const fetching = fetchKey(certUrl, at, fetchImpl).finally(() => inFlight.delete(certUrl));
  inFlight.set(certUrl, fetching);
  return fetching;
}

async function fetchKey(certUrl: string, at: number, fetchImpl: typeof fetch): Promise<CertAnswer> {
  let pem: string;
  try {
    const res = await fetchImpl(certUrl, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    // A 5xx or a 429 is AWS busy, not a wrong URL: "unavailable", and SNS
    // retries. Anything else refused (the review's nit: a remembered 429
    // would have refused genuine mail for a minute, which SNS treats as final).
    if (!res.ok) return res.status >= 500 || res.status === 429 ? "unavailable" : rememberRefused(certUrl, at);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_CERT_BYTES) return rememberRefused(certUrl, at);
    const body = await res.arrayBuffer();
    if (body.byteLength > MAX_CERT_BYTES) return rememberRefused(certUrl, at);
    pem = new TextDecoder().decode(body);
  } catch {
    return "unavailable";
  }

  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    return rememberRefused(certUrl, at);
  }
  const from = Date.parse(cert.validFrom);
  const until = Date.parse(cert.validTo);
  if (!Number.isFinite(from) || !Number.isFinite(until) || at < from || at >= until) {
    return rememberRefused(certUrl, at);
  }
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(certUrl, { key: cert.publicKey, until });
  return cert.publicKey;
}

/** Tests only: forget every cached certificate, refusal, fetch in flight and fetch count. */
export function resetSnsCertCache(): void {
  cache.clear();
  refusedUntil.clear();
  inFlight.clear();
  fetchWindow = { start: 0, count: 0 };
}
