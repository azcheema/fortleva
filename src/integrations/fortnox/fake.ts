import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { absoluteUrl, FORTNOX_FAKE_CONSENT_PATH } from "@/config";

import { codeChallengeOf } from "./pkce";
import { FortnoxError, type FortnoxFinancialYear, type FortnoxTransport } from "./types";

/**
 * THE FAKE FORTNOX (Phase 4 slice 114; the design's §3 as amended by §10.4) —
 * the `fake` transport, which `src/config` allows only where it is set
 * explicitly (the harnesses) and never on a production build off loopback.
 *
 * FILE-BACKED, so the e2e server and `seed-cli` — two processes — meet the
 * same companies: `.dev-fortnox/` (gitignored, the dev transports' precedent),
 * one JSON file per company and one per authorization code in flight.
 *
 * Its companies' TenantIds are in a RESERVED range — "9" and ten digits, the
 * workspace's own fake company derived from its id — and it refuses any other
 * (the design review's S2: a fake row can never name a real company). Its
 * consent screen is our own route (`FORTNOX_FAKE_CONSENT_PATH`), which makes
 * the company on first sight with the workspace's name and org. number and
 * sends the browser straight back with a code. Tests reach in through
 * `setFakeCompany` (a mismatching org. number, a revoked consent, a missing
 * financial year, an inactive account…).
 */

export type FakeCompany = {
  readonly tenantId: string;
  readonly name: string;
  readonly orgNr: string;
  /** False: the administrator consented as a person, not as a service account (NOT_SERVICE). */
  readonly serviceAccount?: boolean;
  /** The customer removed the integration in Fortnox. */
  readonly consentRevoked?: boolean;
  /** False: no integration add-on. */
  readonly licence?: boolean;
  /** The consent screen answers `error=access_denied`. */
  readonly denies?: boolean;
  /** The access token's tenantId claim says this instead (S10's cross-check). */
  readonly claimOverride?: string;
  readonly years: readonly FortnoxFinancialYear[];
  /** Voucher series by code; absent → none. */
  readonly series: Readonly<Record<string, { readonly manual: boolean }>>;
  /** Accounts that do not exist, and that are inactive; every other one exists and is active. */
  readonly missingAccounts?: readonly string[];
  readonly inactiveAccounts?: readonly string[];
};

const root = (): string => join(process.cwd(), ".dev-fortnox");

const companyFile = (tenantId: string): string => join(root(), `company-${tenantId}.json`);
const codeFile = (code: string): string => join(root(), `code-${createHash("sha256").update(code).digest("hex")}.json`);

/** The reserved range: "9" and ten digits. */
export const isFakeTenantId = (v: string): boolean => /^9\d{10}$/.test(v);

/** A workspace's own fake company — the same one every time it connects. */
export const fakeCompanyTenantIdFor = (workspaceTenantId: string): string => {
  const n = BigInt(`0x${createHash("sha256").update(`fortnox-fake:${workspaceTenantId}`).digest("hex").slice(0, 15)}`) % 10_000_000_000n;
  return `9${n.toString().padStart(10, "0")}`;
};

function writeJson(path: string, value: unknown): void {
  mkdirSync(root(), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** A company as the fake makes it: this year and the next (cash method), series F manual, every account active. */
export function defaultFakeCompany(tenantId: string, name: string, orgNr: string, now: Date = new Date()): FakeCompany {
  const y = now.getUTCFullYear();
  return {
    tenantId,
    name,
    orgNr,
    years: [
      { id: 1, from: `${y}-01-01`, to: `${y}-12-31`, method: "CASH" },
      { id: 2, from: `${y + 1}-01-01`, to: `${y + 1}-12-31`, method: "CASH" },
    ],
    series: { F: { manual: true }, B: { manual: false } },
  };
}

export function readFakeCompany(tenantId: string): FakeCompany | null {
  return isFakeTenantId(tenantId) ? readJson<FakeCompany>(companyFile(tenantId)) : null;
}

/** Make or change a fake company (tests, and the consent screen's first sight). */
export function setFakeCompany(company: FakeCompany): void {
  if (!isFakeTenantId(company.tenantId)) throw new Error("fake fortnox: a TenantId outside the reserved range");
  writeJson(companyFile(company.tenantId), company);
}

/** Forget a fake company (test teardown). */
export function removeFakeCompany(tenantId: string): void {
  if (isFakeTenantId(tenantId)) rmSync(companyFile(tenantId), { force: true });
}

type PendingCode = { readonly tenantId: string; readonly challenge: string; readonly at: number };

/** Codes never exchanged go after their ten minutes (the security review's nit 6). */
function pruneCodes(): void {
  if (!existsSync(root())) return;
  const cutoff = Date.now() - 10 * 60_000;
  for (const name of readdirSync(root())) {
    if (!name.startsWith("code-")) continue;
    const path = join(root(), name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // Gone meanwhile.
    }
  }
}

/**
 * THE CONSENT SCREEN's work (the fake-consent route): the company on first
 * sight, then either a refusal or a code bound to the PKCE challenge.
 */
export function fakeConsent(input: {
  readonly companyTenantId: string;
  readonly name: string;
  readonly orgNr: string;
  readonly codeChallenge: string;
}): { readonly code: string } | { readonly error: "access_denied" } {
  if (!isFakeTenantId(input.companyTenantId)) return { error: "access_denied" };
  let company = readFakeCompany(input.companyTenantId);
  if (!company) {
    company = defaultFakeCompany(input.companyTenantId, input.name, input.orgNr);
    setFakeCompany(company);
  }
  if (company.denies) return { error: "access_denied" };
  pruneCodes();
  const code = randomBytes(24).toString("base64url");
  writeJson(codeFile(code), { tenantId: company.tenantId, challenge: input.codeChallenge, at: Date.now() } satisfies PendingCode);
  return { code };
}

const tokenOf = (tenantId: string): string => `fake.${tenantId}.${randomBytes(18).toString("base64url")}`;

/** The company a fake access token was issued for — refused when it is not one of ours, or gone. */
function companyOfToken(accessToken: string, call: string): FakeCompany {
  const m = /^fake\.(9\d{10})\.[A-Za-z0-9_-]+$/.exec(accessToken);
  const company = m ? readFakeCompany(m[1]!) : null;
  if (!company || company.consentRevoked) throw new FortnoxError("auth", call, 401, null, null);
  return company;
}

export const fakeFortnox: FortnoxTransport = {
  kind: "fake",

  consentUrl({ state, codeChallenge, fake }) {
    if (!fake) throw new Error("fake fortnox: a consent needs the workspace's fake company");
    const params = new URLSearchParams({
      state,
      code_challenge: codeChallenge,
      company: fake.companyTenantId,
      name: fake.name,
      org: fake.orgNr,
    });
    return absoluteUrl(`${FORTNOX_FAKE_CONSENT_PATH}?${params}`);
  },

  async exchangeCode(code, verifier) {
    // Claimed by a rename — atomic, so one code is exchanged once even by two
    // at once (the code review's nit).
    const path = codeFile(code);
    const claimed = `${path}.${randomBytes(6).toString("hex")}.claimed`;
    try {
      renameSync(path, claimed);
    } catch {
      throw new FortnoxError("auth", "token.code", 400, "invalid_grant", null);
    }
    const pending = readJson<PendingCode>(claimed);
    rmSync(claimed, { force: true });
    if (!pending || Date.now() - pending.at > 10 * 60_000 || pending.challenge !== codeChallengeOf(verifier)) {
      throw new FortnoxError("auth", "token.code", 400, "invalid_grant", null);
    }
    const company = readFakeCompany(pending.tenantId);
    if (!company) throw new FortnoxError("auth", "token.code", 400, "invalid_grant", null);
    return { accessToken: tokenOf(company.tenantId), tenantIdClaim: company.claimOverride ?? company.tenantId };
  },

  async tenantToken(tenantId) {
    // Refuses every TenantId outside the reserved range (S2).
    const company = readFakeCompany(tenantId);
    if (!company || company.consentRevoked || company.serviceAccount === false) {
      throw new FortnoxError("auth", "token.tenant", 401, "consent_not_found", null);
    }
    if (company.licence === false) throw new FortnoxError("licence", "token.tenant", 403, "2001103", "Api-licens saknas");
    return tokenOf(tenantId);
  },

  async companyInformation(accessToken) {
    const company = companyOfToken(accessToken, "companyinformation");
    return { name: company.name, orgNr: company.orgNr, databaseNumber: company.tenantId };
  },

  async financialYearOn(accessToken, day) {
    const company = companyOfToken(accessToken, "financialyears");
    return company.years.find((y) => y.from <= day && day <= y.to) ?? null;
  },

  async voucherSeries(accessToken, code, yearId) {
    const company = companyOfToken(accessToken, "voucherseries");
    if (!company.years.some((y) => y.id === yearId)) return null;
    const s = company.series[code];
    return s ? { code, manual: s.manual } : null;
  },

  async account(accessToken, number, yearId) {
    const company = companyOfToken(accessToken, "accounts");
    if (!company.years.some((y) => y.id === yearId) || company.missingAccounts?.includes(number)) return null;
    return { number, active: !company.inactiveAccounts?.includes(number) };
  },
};
