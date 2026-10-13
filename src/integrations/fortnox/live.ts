import { createHash } from "node:crypto";

import {
  fortnoxApiBase,
  fortnoxAuthorizeUrl,
  fortnoxClientCredentials,
  fortnoxRedirectUri,
  fortnoxTokenUrl,
} from "@/config";
import { readCappedText } from "@/lib/capped-body";

import {
  answerJson,
  errorFromAnswer,
  parseAccessToken,
  parseAccount,
  parseCompany,
  parseFinancialYearOn,
  parseVoucherSeries,
  tenantIdClaimOf,
} from "./parse";
import { FortnoxError, type FortnoxTransport } from "./types";

/**
 * FORTNOX ITSELF (Phase 4 slice 114; founder decision C89; the design's §3
 * as amended by §10). Only `src/config`'s hosts, `redirect: "error"`, no
 * cache, a timeout on every call that never runs past the caller's deadline,
 * every answer read against a 1 MB cap and parsed field by field
 * (`parse.ts`). The app's client secret is read from `src/config` at the
 * moment a token call sends it and goes nowhere else — not into an error, not
 * into a log line (`FortnoxError` carries no URL, header or body).
 *
 * SCOPES (the design review's R12): `bookkeeping` (vouchers, financial years,
 * voucher series, accounts), `companyinformation`, `inbox` + `connectfile`
 * (slice 114b's PDFs). Not `settings` — a locked period is read from the
 * refusal. Adding one later takes a new consent from every company.
 */

export const FORTNOX_SCOPES = ["bookkeeping", "companyinformation", "inbox", "connectfile"] as const;

const MAX_ANSWER_BYTES = 1_000_000;
const CALL_TIMEOUT_MS = 15_000;
/** Never start a call that could end within this of the caller's deadline. */
const DEADLINE_MARGIN_MS = 5_000;
/** At most this many calls per company in any five seconds (Fortnox's limit is 25). */
const RATE_CALLS = 20;
const RATE_WINDOW_MS = 5_000;
/** A service account's token is good for an hour; we stop using it after 55 minutes. */
const TOKEN_REUSE_MS = 55 * 60_000;

const timeoutFor = (call: string, deadline: number): number => {
  const left = deadline - Date.now() - DEADLINE_MARGIN_MS;
  if (left < 1_000) throw new FortnoxError("unknown", call, null, null, null);
  return Math.min(CALL_TIMEOUT_MS, left);
};

/** Calls made per subject — a company's TenantId, or the HASH of a one-off token (never a raw token as a key) — newest last. */
const recent = new Map<string, number[]>();

async function pace(subject: string, call: string, deadline: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    const kept = (recent.get(subject) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (kept.length < RATE_CALLS) {
      kept.push(now);
      recent.set(subject, kept);
      if (recent.size > 1_000) recent.delete(recent.keys().next().value!);
      return;
    }
    const wait = RATE_WINDOW_MS - (now - kept[0]!) + 10;
    if (Date.now() + wait > deadline - DEADLINE_MARGIN_MS) throw new FortnoxError("rate", call, null, null, null);
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** One call: its JSON, or a classified `FortnoxError`. */
async function send(call: string, url: string, init: RequestInit, deadline: number, subject: string): Promise<{ status: number; answer: unknown }> {
  await pace(subject, call, deadline);
  const timeout = timeoutFor(call, deadline);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout), redirect: "error", cache: "no-store" });
  } catch {
    // A timeout, the network, a redirect refused: the outcome is unknown.
    throw new FortnoxError("unknown", call, null, null, null);
  }
  let text: string | null;
  try {
    text = await readCappedText(res, MAX_ANSWER_BYTES);
  } catch {
    throw new FortnoxError("unknown", call, res.status, null, null);
  }
  if (!res.ok) throw errorFromAnswer(call, res.status, text);
  return { status: res.status, answer: answerJson(call, text) };
}

const basicAuth = (call: string): string => {
  const creds = fortnoxClientCredentials();
  if (!creds) throw new FortnoxError("auth", call, null, null, null);
  return `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`, "utf8").toString("base64")}`;
};

/** Service-account tokens per TenantId, reused for 55 minutes. */
const tokens = new Map<string, { readonly token: string; readonly until: number }>();

/**
 * Whose calls a token's are, for the limiter: its company's when it is one of
 * our service tokens (so a company's token and API calls share ONE budget —
 * the code review's 10), else the token's SHA-256 (the security review's 8).
 */
function subjectOf(accessToken: string): string {
  for (const [tenantId, t] of tokens) if (t.token === accessToken) return tenantId;
  return `token:${createHash("sha256").update(accessToken).digest("hex")}`;
}

const bearer = (accessToken: string): Record<string, string> => ({ Authorization: `Bearer ${accessToken}`, Accept: "application/json" });

/** A GET whose 404 means "there is none". */
async function getOrNull(call: string, path: string, accessToken: string, deadline: number): Promise<unknown> {
  try {
    return (await send(call, `${fortnoxApiBase}${path}`, { method: "GET", headers: bearer(accessToken) }, deadline, subjectOf(accessToken))).answer;
  } catch (e) {
    if (e instanceof FortnoxError && e.status === 404) return null;
    throw e;
  }
}

/** A token a GET was refused with is never used again (the consent may be gone). */
async function readWith<T>(accessToken: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof FortnoxError && e.kind === "auth") {
      for (const [id, t] of tokens) if (t.token === accessToken) tokens.delete(id);
    }
    throw e;
  }
}

export const liveFortnox: FortnoxTransport = {
  kind: "live",

  consentUrl({ state, codeChallenge }) {
    const creds = fortnoxClientCredentials();
    if (!creds) throw new FortnoxError("auth", "consent", null, null, null);
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: fortnoxRedirectUri,
      scope: FORTNOX_SCOPES.join(" "),
      state,
      access_type: "offline",
      response_type: "code",
      account_type: "service",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    // Fortnox reads the scope list space-separated as %20; URLSearchParams
    // writes "+" (and every literal "+" as %2B, so this replaces only spaces).
    return `${fortnoxAuthorizeUrl}?${params.toString().replace(/\+/g, "%20")}`;
  },

  async exchangeCode(code, verifier, deadline) {
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: fortnoxRedirectUri, code_verifier: verifier });
    const { answer } = await send(
      "token.code",
      fortnoxTokenUrl,
      { method: "POST", headers: { Authorization: basicAuth("token.code"), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body },
      deadline,
      "token:exchange",
    );
    // The refresh token in the same answer is DROPPED unread: never stored,
    // never logged (the design's §4.3; revoking it may end the service
    // consent — UNCONFIRMED, RUNBOOK's sandbox test).
    const accessToken = parseAccessToken(answer, "token.code");
    return { accessToken, tenantIdClaim: tenantIdClaimOf(accessToken) };
  },

  async tenantToken(tenantId, deadline, opts) {
    const held = tokens.get(tenantId);
    if (!opts?.fresh && held && held.until > Date.now()) return held.token;
    const { answer } = await send(
      "token.tenant",
      fortnoxTokenUrl,
      {
        method: "POST",
        headers: {
          Authorization: basicAuth("token.tenant"),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          TenantId: tenantId,
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      },
      deadline,
      tenantId,
    );
    const token = parseAccessToken(answer, "token.tenant");
    tokens.set(tenantId, { token, until: Date.now() + TOKEN_REUSE_MS });
    if (tokens.size > 1_000) tokens.delete(tokens.keys().next().value!);
    return token;
  },

  async companyInformation(accessToken, deadline) {
    return readWith(accessToken, async () => {
      const { answer } = await send("companyinformation", `${fortnoxApiBase}/companyinformation`, { method: "GET", headers: bearer(accessToken) }, deadline, subjectOf(accessToken));
      return parseCompany(answer);
    });
  },

  async financialYearOn(accessToken, day, deadline) {
    return readWith(accessToken, async () => {
      const q = new URLSearchParams({ date: day });
      const { answer } = await send("financialyears", `${fortnoxApiBase}/financialyears?${q}`, { method: "GET", headers: bearer(accessToken) }, deadline, subjectOf(accessToken));
      return parseFinancialYearOn(answer, day);
    });
  },

  async voucherSeries(accessToken, code, yearId, deadline) {
    return readWith(accessToken, async () => {
      const q = new URLSearchParams({ financialyear: String(yearId) });
      const answer = await getOrNull("voucherseries", `/voucherseries/${encodeURIComponent(code)}?${q}`, accessToken, deadline);
      return answer === null ? null : parseVoucherSeries(answer);
    });
  },

  async account(accessToken, number, yearId, deadline) {
    return readWith(accessToken, async () => {
      const q = new URLSearchParams({ financialyear: String(yearId) });
      const answer = await getOrNull("accounts", `/accounts/${encodeURIComponent(number)}?${q}`, accessToken, deadline);
      return answer === null ? null : parseAccount(answer);
    });
  },
};
