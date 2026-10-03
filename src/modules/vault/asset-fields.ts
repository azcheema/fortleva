import { z } from "zod";

import { fail } from "@/lib/domain-error";

import { trimmedOrNull } from "./fields";

/**
 * What an ASSET is, by type — the registry's vocabulary and the bounds every
 * input is held to (DATA_MODEL.md §6.17 `ClientAsset`; Phase 3V slice 87).
 * Pure: no database, so the unit suite covers it.
 *
 * An asset is NON-SECRET by contract. Nothing here is a place for a
 * password or a licence key — those are credentials, in the vault — which
 * is why no per-type field below is one: a licence's SEATS are an asset
 * fact, its key is not.
 */

export const ASSET_TYPES = [
  "DOMAIN",
  "HOSTING",
  "DNS_ZONE",
  "SSL_CERT",
  "EMAIL",
  "CMS_APP",
  "THIRD_PARTY_SERVICE",
  "LICENSE",
  "CUSTOM",
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const isAssetType = (v: unknown): v is AssetType =>
  typeof v === "string" && (ASSET_TYPES as readonly string[]).includes(v);

export const ASSET_STATUSES = ["ACTIVE", "RETIRED"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const isAssetStatus = (v: unknown): v is AssetStatus =>
  typeof v === "string" && (ASSET_STATUSES as readonly string[]).includes(v);

/**
 * The few extra facts a type carries, in display order — DATA_MODEL's
 * "`fields Json` (zod per type)". Three kinds: a line of text, a LIST
 * (typed as one line, split on commas, spaces or new lines: nameservers, a
 * certificate's names), and a COUNT (mailboxes, seats).
 */
export type AssetFieldKind = "text" | "list" | "count";
export type AssetFieldSpec = { readonly key: string; readonly kind: AssetFieldKind };

export const ASSET_FIELDS: Readonly<Record<AssetType, readonly AssetFieldSpec[]>> = {
  DOMAIN: [{ key: "nameservers", kind: "list" }],
  HOSTING: [
    { key: "plan", kind: "text" },
    { key: "server", kind: "text" },
  ],
  DNS_ZONE: [{ key: "nameservers", kind: "list" }],
  SSL_CERT: [{ key: "domains", kind: "list" }],
  EMAIL: [
    { key: "plan", kind: "text" },
    { key: "mailboxes", kind: "count" },
  ],
  CMS_APP: [
    { key: "platform", kind: "text" },
    { key: "version", kind: "text" },
  ],
  THIRD_PARTY_SERVICE: [{ key: "plan", kind: "text" }],
  LICENSE: [{ key: "seats", kind: "count" }],
  CUSTOM: [],
};

export type AssetFieldValue = string | readonly string[] | number;
export type AssetFieldValues = Readonly<Record<string, AssetFieldValue>>;

export const PROVIDER_MAX = 200;
export const IDENTIFIER_MAX = 255;
export const FIELD_TEXT_MAX = 200;
/** A hostname's own limit (RFC 1035), which every list here is made of. */
export const FIELD_LIST_ITEM_MAX = 253;
export const FIELD_LIST_MAX = 20;
export const FIELD_COUNT_MAX = 1_000_000;
/**
 * The whole `fields` object, JSON-encoded, in UTF-8 bytes. Twenty long
 * hostnames fit; the database's own belt (`client_asset_fields_object`)
 * sits at twice this, so the service is always the side that refuses —
 * with INVALID_INPUT, not a constraint error (the migration's pre-apply review).
 */
export const FIELDS_BYTES_MAX = 8192;
export const EXPIRY_YEAR_MIN = 2000;
export const EXPIRY_YEAR_MAX = 2199;

const LIST_SPLIT = /[\s,;]+/;

/** One kind's schema: the value a caller sent, or a form's string of it. */
const SCHEMA: Record<AssetFieldKind, z.ZodType<AssetFieldValue>> = {
  text: z.string().trim().min(1).max(FIELD_TEXT_MAX),
  list: z.preprocess(
    // A form's one line, or a caller's array — whose items are split too,
    // so `["a, b"]` and `"a, b"` store the same list and a row's round
    // trip through its one-line input never rewrites it (the code review).
    (v) =>
      typeof v === "string"
        ? v.split(LIST_SPLIT)
        : Array.isArray(v)
          ? v.flatMap((i: unknown) => (typeof i === "string" ? i.split(LIST_SPLIT) : [i]))
          : v,
    z
      .array(z.string().trim().max(FIELD_LIST_ITEM_MAX))
      .transform((items) => [...new Set(items.filter((i) => i.length > 0))])
      .pipe(z.array(z.string()).min(1).max(FIELD_LIST_MAX)),
  ),
  count: z.preprocess(
    (v) => (typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v.trim()) : v),
    z.number().int().min(0).max(FIELD_COUNT_MAX),
  ),
};

/** "Nothing typed": a removal in a patch, a skipped field on create. */
const isBlank = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.every((i) => typeof i === "string" && i.trim() === ""));

/**
 * A fields PATCH, held to its type: only the type's keys; a blank value
 * (`null`, an empty string, an empty list) REMOVES the field; anything
 * else must pass the kind's schema. A key outside the type is refused
 * rather than stored — and the message never echoes it, because a client
 * bug that posts a value as a key would otherwise put the value into a
 * message (the vault's rule, kept here although nothing here is secret).
 */
export function normalizeAssetFieldsPatch(type: AssetType, raw: unknown): Record<string, AssetFieldValue | null> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return fail("INVALID_INPUT", "fields must be an object");
  const specs = ASSET_FIELDS[type];
  const out: Record<string, AssetFieldValue | null> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const spec = specs.find((s) => s.key === key);
    if (!spec) return fail("INVALID_INPUT", `a field is not a ${type} field`);
    if (isBlank(value)) {
      out[spec.key] = null;
      continue;
    }
    const parsed = SCHEMA[spec.kind].safeParse(value);
    if (!parsed.success) return fail("INVALID_INPUT", `field "${spec.key}"`);
    out[spec.key] = parsed.data;
  }
  return out;
}

/** A NEW asset's fields: the patch rules, with blanks simply left out. */
export function normalizeAssetFields(type: AssetType, raw: unknown): Record<string, AssetFieldValue> {
  return applyAssetFieldsPatch(type, {}, normalizeAssetFieldsPatch(type, raw));
}

/**
 * `current` with `patch` applied, keyed in the type's display order and
 * holding only the type's keys — so a type change drops the fields the new
 * type does not have, and two encodings of one value compare equal.
 */
export function applyAssetFieldsPatch(
  type: AssetType,
  current: AssetFieldValues,
  patch: Readonly<Record<string, AssetFieldValue | null>>,
): Record<string, AssetFieldValue> {
  const out: Record<string, AssetFieldValue> = {};
  const before: Record<string, AssetFieldValue> = {};
  for (const { key } of ASSET_FIELDS[type]) {
    const next = key in patch ? patch[key] : current[key];
    if (next !== null && next !== undefined) out[key] = next;
    if (current[key] !== undefined) before[key] = current[key];
  }
  // Only facts that CHANGE are measured — so a row an import stored between
  // this cap and the database's can still be renamed or retired from the
  // tab, whose every save re-posts the type's facts as they are (the
  // narrow review, then the code review).
  const encoded = JSON.stringify(out);
  if (encoded !== JSON.stringify(before) && new TextEncoder().encode(encoded).length > FIELDS_BYTES_MAX) {
    return fail("INVALID_INPUT", "fields are too long");
  }
  return out;
}

/**
 * The stored `fields` as the type reads it. TOLERANT, unlike the writers:
 * a value that no longer passes (a type changed by an import, a bound
 * tightened later) is left out rather than thrown, so one odd row can
 * never take the client's Assets tab down with it.
 */
export function readAssetFields(type: AssetType, stored: unknown): AssetFieldValues {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return {};
  const out: Record<string, AssetFieldValue> = {};
  for (const { key, kind } of ASSET_FIELDS[type]) {
    const parsed = SCHEMA[kind].safeParse((stored as Record<string, unknown>)[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

export const normalizeProvider = (raw: unknown): string | null => trimmedOrNull(raw, PROVIDER_MAX, "provider");
export const normalizeIdentifier = (raw: unknown): string | null => trimmedOrNull(raw, IDENTIFIER_MAX, "identifier");

/**
 * A renewal cost: Decimal(12,2) as a string, never a float on the wire. A
 * form's "1 200,50" and "1200.50" read the same; `null` or blank clears it.
 */
export function normalizeRenewalCost(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" && typeof raw !== "number") return fail("INVALID_INPUT", "renewalCost");
  const s = String(raw).replace(/\s/g, "").replace(",", ".");
  if (s === "") return null;
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return fail("INVALID_INPUT", "renewalCost");
  // Canonical: no leading zeros, always two decimals — the shape a stored
  // Decimal(12,2) reads back as, so "149" posted over "149.00" is no change.
  return `${m[1]!.replace(/^0+(?=\d)/, "")}.${(m[2] ?? "").padEnd(2, "0")}`;
}

/** An ISO 4217-shaped code, upper-cased; blank is none. */
export function normalizeCurrency(raw: unknown): string | null {
  const v = trimmedOrNull(raw, 3, "currency");
  if (v === null) return null;
  const up = v.toUpperCase();
  if (!/^[A-Z]{3}$/.test(up)) fail("INVALID_INPUT", "currency");
  return up;
}

/**
 * A renewal DATE, held to the convention every reader assumes: UTC
 * midnight (`dateField`'s, the form's). A writer that sends another time
 * of day — an import, a script — has its date's UTC day kept and the time
 * dropped, so the shown date and the reminder offsets can never drift by
 * a day between writers (the migration's pre-apply review). The time is
 * cut IN PLACE: rebuilding through `Date.UTC` would read a typed year 26
 * as 1926. A year outside 2000–2199 is a typo, never a renewal, and is
 * refused (the narrow review). Callers send UTC midnight or an ISO date:
 * a local midnight east of UTC is the previous UTC day, and stays it.
 */
export function normalizeExpiryDay(raw: unknown): Date | null {
  if (raw === undefined || raw === null) return null;
  if (!(raw instanceof Date) || Number.isNaN(raw.getTime())) return fail("INVALID_INPUT", "expiresAt");
  const year = raw.getUTCFullYear();
  if (year < EXPIRY_YEAR_MIN || year > EXPIRY_YEAR_MAX) return fail("INVALID_INPUT", "expiresAt");
  const day = new Date(raw.getTime());
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

/** Renews by itself: yes, no, or not known (`null`). */
export function normalizeAutoRenew(raw: unknown): boolean | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "boolean") return fail("INVALID_INPUT", "autoRenew");
  return raw;
}
