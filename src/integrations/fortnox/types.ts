/**
 * THE FORTNOX CLIENT'S SHAPES (Phase 4 slice 114; founder decision C89;
 * docs/research/2026-10-12-slice-114-fortnox-connection-design.md §3 as
 * amended by §10). One interface, two transports: `live.ts` (Fortnox itself)
 * and `fake.ts` (a file-backed fake for the harnesses); `index.ts` picks the
 * one `src/config` names. The nightly send's calls (vouchers, the inbox, file
 * connections) come with slice 114b.
 */

/** Who a Fortnox company says it is (`GET /3/companyinformation`). */
export type FortnoxCompany = {
  readonly name: string;
  /** As Fortnox holds it — compared only after `normalizeOrgNr`. */
  readonly orgNr: string | null;
  /** Fortnox's DatabaseNumber: the TenantId its tokens are asked for. */
  readonly databaseNumber: string;
};

export type FortnoxFinancialYear = {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  /** Fortnox's own word for the method; null when it gives none. */
  readonly method: "ACCRUAL" | "CASH" | null;
};

export type FortnoxVoucherSeries = { readonly code: string; readonly manual: boolean };

export type FortnoxAccount = { readonly number: string; readonly active: boolean };

/** An authorization code exchanged: an access token to read who the company is, and the token's own TenantId claim. */
export type FortnoxCodeExchange = {
  readonly accessToken: string;
  /** The access token's `tenantId` claim, when it carries one (the design review's S10). */
  readonly tenantIdClaim: string | null;
};

/** What a press of Connect needs to send the administrator to Fortnox. */
export type FortnoxConsentRequest = {
  readonly state: string;
  readonly codeChallenge: string;
  /** For the FAKE consent screen only: the workspace whose fake company answers, and what it should say it is. */
  readonly fake?: { readonly companyTenantId: string; readonly name: string; readonly orgNr: string };
};

export interface FortnoxTransport {
  readonly kind: "fake" | "live";
  /** The consent screen's address for one attempt (`account_type=service`, PKCE S256). */
  consentUrl(request: FortnoxConsentRequest): string;
  /** The authorization code for an access token. The refresh token Fortnox also sends is DROPPED unread. */
  exchangeCode(code: string, verifier: string, deadline: number): Promise<FortnoxCodeExchange>;
  /**
   * A service account's access token for a company (client credentials + its
   * TenantId). Reused for 55 minutes — unless `fresh`, which always asks
   * Fortnox (the connect's proof of a service consent, the check's "consent
   * alive": the code review's 4).
   */
  tenantToken(tenantId: string, deadline: number, opts?: { readonly fresh?: boolean }): Promise<string>;
  companyInformation(accessToken: string, deadline: number): Promise<FortnoxCompany>;
  /** The financial year holding a day, or null when Fortnox has none. */
  financialYearOn(accessToken: string, day: string, deadline: number): Promise<FortnoxFinancialYear | null>;
  /** A voucher series in a financial year, or null when it does not exist. */
  voucherSeries(accessToken: string, code: string, yearId: number, deadline: number): Promise<FortnoxVoucherSeries | null>;
  /** An account in a financial year, or null when it does not exist. */
  account(accessToken: string, number: string, yearId: number, deadline: number): Promise<FortnoxAccount | null>;
}

/**
 * Why a call failed — the design's §3 classification:
 *  - `auth` — the app's credentials or the company's consent refused (a
 *    token for a TenantId refused: the consent is gone);
 *  - `licence` — the company lacks the integration add-on, or a module a
 *    scope needs (`2001103`, `2001101`, `error_missing_license`);
 *  - `refused` — any other 4xx: nothing was done, and Fortnox said why;
 *  - `rate` — 429;
 *  - `unknown` — 5xx, a timeout, the network, out of time: for a POST the
 *    outcome is UNKNOWN;
 *  - `shape` — an answer out of the shape we read.
 */
export type FortnoxErrorKind = "auth" | "licence" | "refused" | "rate" | "unknown" | "shape";

/**
 * A failed Fortnox call. NEVER carries the URL, a header, a token or a body
 * (the design review's S15): the call's name, the HTTP status, Fortnox's own
 * code, and its message cut to 200 characters — for the owners to read, never
 * for a log line (which takes `logTag`).
 */
export class FortnoxError extends Error {
  constructor(
    readonly kind: FortnoxErrorKind,
    readonly call: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly detail: string | null,
  ) {
    super(`fortnox ${call}: ${kind}${status === null ? "" : ` ${status}`}${code === null ? "" : ` (${code})`}`);
    this.name = "FortnoxError";
  }

  /** What a log line may say: the call, the kind, the status and Fortnox's code — never its message. */
  get logTag(): string {
    return this.message;
  }
}

export const isFortnoxError = (e: unknown): e is FortnoxError => e instanceof FortnoxError;
