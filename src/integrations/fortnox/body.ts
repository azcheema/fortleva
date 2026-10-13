import { FortnoxError, type FortnoxVoucherDraft } from "./types";

/**
 * WHAT THE NIGHTLY SEND SENDS (Phase 4 slice 114b; the design's §5.3) — pure,
 * so a unit test pins the bytes.
 *
 * A voucher's amounts go into the JSON EXACTLY as the bookkeeping file froze
 * them: each row's decimal string to the öre (`-?\d{1,15}\.\d{2}` — the entry
 * guard's own shape) becomes a JSON number literal as written, never a float
 * that `JSON.stringify` would round. A positive amount is a DEBIT, a negative
 * one a CREDIT (its magnitude), the other side 0. Text goes through
 * `JSON.stringify`, so nothing in it can break out of its string.
 */

const AMOUNT = /^-?\d{1,15}\.\d{2}$/;
/** A BAS account: four digits, never a leading zero (it is sent as a JSON number). */
const ACCOUNT = /^[1-9]\d{3}$/;
const SERIES = /^[A-Z0-9]{1,10}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FILE_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Fortnox's limits: a voucher's description and its comments (the design's research). */
export const DESCRIPTION_MAX = 200;
export const COMMENTS_MAX = 1000;

const refuse = (call: string): never => {
  throw new FortnoxError("shape", call, null, null, null);
};

/** `{"Voucher":{…}}` for `POST /3/vouchers`. Throws a `shape` error (nothing sent) for anything out of shape. */
export function voucherBody(draft: FortnoxVoucherDraft): string {
  const call = "vouchers.create";
  if (!SERIES.test(draft.series) || !DAY.test(draft.date)) refuse(call);
  if (draft.description.length < 1 || draft.description.length > DESCRIPTION_MAX) refuse(call);
  if (draft.comments.length < 1 || draft.comments.length > COMMENTS_MAX) refuse(call);
  if (draft.rows.length === 0) refuse(call);
  let total = 0n;
  const rows = draft.rows.map((r) => {
    if (!ACCOUNT.test(r.account) || !AMOUNT.test(r.amount)) refuse(call);
    const negative = r.amount.startsWith("-");
    // A JSON number has no leading zeros: "007.50" → "7.50" ("0.50" stays).
    const magnitude = (negative ? r.amount.slice(1) : r.amount).replace(/^0+(?=\d)/, "");
    const ore = BigInt(magnitude.replace(".", ""));
    if (ore === 0n) refuse(call);
    total += negative ? -ore : ore;
    // Account a number, the amounts written as they stand (a valid JSON number:
    // no sign on the magnitude, digits, a point, two digits).
    return `{"Account":${Number(r.account)},"Debit":${negative ? "0" : magnitude},"Credit":${negative ? magnitude : "0"}}`;
  });
  // It balances, as the file booked it (the entry guard's own rule) — a voucher that does not is never sent.
  if (total !== 0n) refuse(call);
  return (
    `{"Voucher":{` +
    `"Description":${JSON.stringify(draft.description)},` +
    `"Comments":${JSON.stringify(draft.comments)},` +
    `"TransactionDate":${JSON.stringify(draft.date)},` +
    `"VoucherSeries":${JSON.stringify(draft.series)},` +
    `"VoucherRows":[${rows.join(",")}]}}`
  );
}

/** `{"VoucherFileConnection":{…}}` for `POST /3/voucherfileconnections` (Fortnox takes the number as a string). */
export function fileConnectionBody(fileId: string, series: string, number: number): string {
  const call = "voucherfileconnections.create";
  if (!FILE_ID.test(fileId) || !SERIES.test(series) || !Number.isSafeInteger(number) || number <= 0) refuse(call);
  return JSON.stringify({ VoucherFileConnection: { FileId: fileId, VoucherNumber: String(number), VoucherSeries: series } });
}

/** A file id from Fortnox, checked before it is used again in a path or a body (the design review's S14). */
export const isFileId = (v: unknown): v is string => typeof v === "string" && FILE_ID.test(v);
