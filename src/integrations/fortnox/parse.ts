import {
  FortnoxError,
  type FortnoxAccount,
  type FortnoxCompany,
  type FortnoxFinancialYear,
  type FortnoxVoucherRef,
  type FortnoxVoucherSeries,
} from "./types";

/**
 * READING FORTNOX'S ANSWERS (Phase 4 slice 114) — pure, so a unit test pins
 * each shape and each refusal. Every field is checked; anything else is a
 * `shape` error, never a guess. Fortnox's own objects are PascalCase
 * (`{"CompanyInformation":{…}}`); its errors come as `{"ErrorInformation":
 * {"error","message","code"}}` (either case) and its OAuth server's as
 * `{"error","error_description"}`.
 */

/** Fortnox's message, cut for the owners to read (never logged). */
export const DETAIL_MAX = 200;

const cut = (s: string): string => (s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 1)}…` : s);

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** A value under either case of its key (Fortnox's error objects use both). */
const either = (o: Record<string, unknown>, key: string): unknown => o[key] ?? o[key.charAt(0).toLowerCase() + key.slice(1)];

const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The licence codes (Fortnox's error page): the add-on, or a scope's module. */
const LICENCE_CODES = new Set(["2001103", "2001101"]);
/** OAuth errors that mean the credentials or the consent are refused. */
const AUTH_ERRORS = new Set(["invalid_client", "invalid_grant", "unauthorized_client", "consent_not_found", "access_denied", "invalid_token"]);

/** A failed answer, classified (the design's §3). */
export function errorFromAnswer(call: string, status: number, text: string | null): FortnoxError {
  const body = obj(json(text ?? ""));
  const info = body ? obj(either(body, "ErrorInformation")) : null;
  let code: string | null = null;
  let message: string | null = null;
  if (info) {
    const c = either(info, "Code");
    if (typeof c === "number" || (typeof c === "string" && /^\d{1,12}$/.test(c))) code = String(c);
    const m = either(info, "Message");
    if (typeof m === "string" && m.trim() !== "") message = cut(m.trim());
  } else if (body && typeof body.error === "string") {
    code = /^[a-z_]{1,64}$/.test(body.error) ? body.error : null;
    if (typeof body.error_description === "string" && body.error_description.trim() !== "") message = cut(body.error_description.trim());
  }
  if (status === 429) return new FortnoxError("rate", call, status, code, message);
  if ((code !== null && LICENCE_CODES.has(code)) || code === "error_missing_license") {
    return new FortnoxError("licence", call, status, code, message);
  }
  if (status === 401 || (code !== null && AUTH_ERRORS.has(code))) return new FortnoxError("auth", call, status, code, message);
  if (status >= 500) return new FortnoxError("unknown", call, status, code, message);
  if (status >= 400) return new FortnoxError("refused", call, status, code, message);
  return new FortnoxError("shape", call, status, code, message);
}

const shape = (call: string): FortnoxError => new FortnoxError("shape", call, null, null, null);

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Digits as a string — Fortnox gives the DatabaseNumber as a number in one place and a string in another. */
const digits = (v: unknown): string | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : typeof v === "string" && /^\d{1,20}$/.test(v) ? v : null;

const day = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/** `GET /3/companyinformation` → `{"CompanyInformation":{CompanyName, OrganizationNumber, DatabaseNumber}}`. */
export function parseCompany(answer: unknown): FortnoxCompany {
  const o = obj(obj(answer)?.CompanyInformation);
  const name = o ? text(o.CompanyName) : null;
  const databaseNumber = o ? digits(o.DatabaseNumber) : null;
  if (!o || name === null || databaseNumber === null) throw shape("companyinformation");
  return { name: name.slice(0, 200), orgNr: text(o.OrganizationNumber), databaseNumber };
}

/** `GET /3/financialyears?date=` → `{"FinancialYears":[{Id, FromDate, ToDate, AccountingMethod}]}` — the first, or null. */
export function parseFinancialYearOn(answer: unknown, on: string): FortnoxFinancialYear | null {
  const list = obj(answer)?.FinancialYears;
  if (!Array.isArray(list)) throw shape("financialyears");
  for (const raw of list) {
    const o = obj(raw);
    const id = o?.Id;
    const from = o ? day(o.FromDate) : null;
    const to = o ? day(o.ToDate) : null;
    if (!o || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || id > INT_MAX || from === null || to === null) throw shape("financialyears");
    if (from <= on && on <= to) {
      const m = o.AccountingMethod;
      return { id, from, to, method: m === "ACCRUAL" || m === "CASH" ? m : null };
    }
  }
  return null;
}

/** `GET /3/voucherseries/{code}` → `{"VoucherSeries":{Code, Manual, NextVoucherNumber}}`. */
export function parseVoucherSeries(answer: unknown): FortnoxVoucherSeries {
  const o = obj(obj(answer)?.VoucherSeries);
  const code = o ? text(o.Code) : null;
  if (!o || code === null || typeof o.Manual !== "boolean") throw shape("voucherseries");
  return { code, manual: o.Manual, nextNumber: positive(o.NextVoucherNumber) };
}

/** The largest value a voucher's columns hold (INTEGER). */
const INT_MAX = 2_147_483_647;

/**
 * A positive integer, given as a number or as digits (Fortnox writes a voucher
 * number both ways) — else null; never past what the columns hold (the
 * security review's nit 5: a write that can never succeed would stall the line).
 */
const positive = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,10}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 && n <= INT_MAX ? n : null;
};

/**
 * `POST /3/vouchers` → `{"Voucher":{VoucherNumber, VoucherSeries, …}}` — the
 * voucher made, in the year it was asked for (its `Year` is not read: the
 * year is the one the request named). A series other than the one asked for
 * is out of shape.
 */
export function parseCreatedVoucher(answer: unknown, yearId: number, series: string): FortnoxVoucherRef {
  const o = obj(obj(answer)?.Voucher);
  const number = o ? positive(o.VoucherNumber) : null;
  const answeredSeries = o ? text(o.VoucherSeries) : null;
  if (!o || number === null || (answeredSeries !== null && answeredSeries !== series)) throw shape("vouchers.create");
  return { year: yearId, series, number };
}

/** `GET /3/vouchers/{series}/{number}` → `{"Voucher":{Comments, …}}` — its comment (a reconcile's marker), or null. */
export function parseVoucherComments(answer: unknown): { readonly comments: string | null } {
  const o = obj(obj(answer)?.Voucher);
  if (!o) throw shape("vouchers.get");
  return { comments: typeof o.Comments === "string" ? o.Comments : null };
}

/** `POST /3/inbox` → `{"File":{Id, …}}` — the file's id, checked before it is used again (S14). */
export function parseInboxFile(answer: unknown): string {
  const id = obj(obj(answer)?.File)?.Id;
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(id)) throw shape("inbox.upload");
  return id;
}

/** `GET /3/voucherfileconnections/{fileId}` → `{"VoucherFileConnection":{VoucherSeries, VoucherNumber}}`. */
export function parseFileConnection(answer: unknown): { readonly series: string; readonly number: number } {
  const o = obj(obj(answer)?.VoucherFileConnection);
  const series = o ? text(o.VoucherSeries) : null;
  const number = o ? positive(o.VoucherNumber) : null;
  if (!o || series === null || number === null) throw shape("voucherfileconnections.get");
  return { series, number };
}

/** `GET /3/accounts/{n}` → `{"Account":{Number, Active}}`. */
export function parseAccount(answer: unknown): FortnoxAccount {
  const o = obj(obj(answer)?.Account);
  const number = o ? digits(o.Number) : null;
  if (!o || number === null || typeof o.Active !== "boolean") throw shape("accounts");
  return { number, active: o.Active };
}

/** An access token from the token endpoint's answer. */
export function parseAccessToken(answer: unknown, call: string): string {
  const token = obj(answer)?.access_token;
  if (typeof token !== "string" || token.length < 16 || token.length > 8192) throw shape(call);
  return token;
}

/**
 * The access token's `tenantId` claim, when it is a JWT that carries one — read,
 * not verified: it came straight from Fortnox's token endpoint over TLS, and
 * it is only CROSS-CHECKED against the DatabaseNumber (the design review's S10).
 */
export function tenantIdClaimOf(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = obj(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
    return payload ? digits(payload.tenantId) : null;
  } catch {
    return null;
  }
}

/** The answer's JSON, or a shape error. */
export function answerJson(call: string, text: string | null): unknown {
  const parsed = text === null ? null : json(text);
  if (parsed === null || typeof parsed !== "object") throw shape(call);
  return parsed;
}
