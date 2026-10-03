import { fail } from "@/lib/domain-error";

/**
 * What a credential IS, by type — the secret field keys each type may
 * carry (DATA_MODEL.md §6.17: `secretFieldKeys` holds the KEYS only, the
 * values live in the ciphertext) and the bounds every input is held to.
 * Pure: no database, so the unit suite covers it.
 */

export const CREDENTIAL_TYPES = [
  "LOGIN",
  "SECURE_NOTE",
  "API_KEY",
  "SSH_KEY",
  "DATABASE",
  "SERVER",
  "WIFI",
  "SOFTWARE_LICENSE",
  "OTHER",
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const isCredentialType = (v: unknown): v is CredentialType =>
  typeof v === "string" && (CREDENTIAL_TYPES as readonly string[]).includes(v);

/**
 * The secret fields per type, in display order. A key outside its type's
 * list is refused rather than stored: an unknown key is either a client
 * bug or a value somebody meant to put in a non-secret field, and both
 * should fail loudly.
 */
export const SECRET_FIELDS: Readonly<Record<CredentialType, readonly string[]>> = {
  LOGIN: ["password"],
  SECURE_NOTE: ["note"],
  API_KEY: ["apiKey", "apiSecret"],
  SSH_KEY: ["privateKey", "passphrase"],
  DATABASE: ["password", "connectionString"],
  SERVER: ["password"],
  WIFI: ["password"],
  SOFTWARE_LICENSE: ["licenseKey"],
  OTHER: ["secret"],
};

/** One secret value — a 4096-bit RSA key in PEM is ~3.3 KB; a note gets room. */
export const SECRET_VALUE_MAX = 16_384;
export const NAME_MAX = 200;
export const USERNAME_MAX = 320;
export const URL_MAX = 2048;
export const NOTES_MAX = 5000;
export const TAG_MAX = 50;
export const TAGS_MAX = 20;
export const ROTATE_DAYS_MAX = 3650;

/**
 * The secret map a caller sent, held to its type: only the type's keys,
 * every value a string within the cap. A value is NEVER trimmed or
 * otherwise changed — a password with a trailing space is a different
 * password — and an empty string means "this field is not set", so it
 * is dropped. NO ERROR CARRIES A KEY THE CALLER SENT: a client bug that
 * posts `{ [value]: … }` would otherwise put the value into a message
 * (security review, 2026-10-01). A key that IS one of the type's is safe
 * to name, and is named.
 */
export function normalizeSecretFields(type: CredentialType, raw: unknown): Record<string, string> {
  const patch = normalizeSecretPatch(type, raw);
  for (const key of Object.keys(patch)) {
    if (patch[key] === null) fail("INVALID_INPUT", `secret field "${key}" cannot be removed here`);
  }
  return patch as Record<string, string>;
}

/**
 * A secret PATCH (replacing a credential's secret): like
 * `normalizeSecretFields`, but `null` removes a field. An empty string
 * still means "unchanged", so a form that posts its blank inputs never
 * wipes a field it did not show.
 */
export function normalizeSecretPatch(type: CredentialType, raw: unknown): Record<string, string | null> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) fail("INVALID_INPUT", "secret must be an object");
  const allowed = SECRET_FIELDS[type];
  const out: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.includes(key)) fail("INVALID_INPUT", `a secret field is not a ${type} field`);
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (typeof value !== "string") fail("INVALID_INPUT", `secret field "${key}" must be a string`);
    const v = value as string;
    if (v.length === 0) continue;
    if (v.length > SECRET_VALUE_MAX) fail("INVALID_INPUT", `secret field "${key}" is too long`);
    out[key] = v;
  }
  // A plain object again, keys in the type's display order — the payload
  // is JSON-encoded before encryption, and a null-prototype object is
  // fine for that, but a stable order keeps two encodings of one secret
  // comparable in a test.
  return Object.fromEntries(allowed.filter((k) => k in out).map((k) => [k, out[k] as string | null]));
}

/** A trimmed string within `max`, or null for nothing; anything else is refused. Shared with `asset-fields.ts`. */
export const trimmedOrNull = (raw: unknown, max: number, what: string): string | null => {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") fail("INVALID_INPUT", `${what} must be a string`);
  const v = (raw as string).trim();
  if (v.length === 0) return null;
  if (v.length > max) fail("INVALID_INPUT", `${what} is too long`);
  return v;
};

export function normalizeName(raw: unknown): string {
  const v = trimmedOrNull(raw, NAME_MAX, "name");
  if (v === null) fail("NAME_REQUIRED");
  return v as string;
}

export const normalizeUsername = (raw: unknown): string | null => trimmedOrNull(raw, USERNAME_MAX, "username");
export const normalizeNotes = (raw: unknown): string | null => trimmedOrNull(raw, NOTES_MAX, "notes");

/** An `@` in the authority — the pattern `client_asset_url_http` refuses. */
const USERINFO = /^[A-Za-z]+:\/\/[^/?#]*@/;

/**
 * http(s) only: the URL is rendered as a link on the member's screen, and
 * a `javascript:` or `data:` URL there would be a stored script.
 */
export function normalizeUrl(raw: unknown): string | null {
  const v = trimmedOrNull(raw, URL_MAX, "url");
  if (v === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return fail("INVALID_INPUT", "url is not a URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") fail("INVALID_INPUT", "url must be http(s)");
  // The database's `credential_item_url_http` wants the `//` too, which
  // the URL parser does not (`https:example.com` parses): refused here
  // with a message rather than there with a constraint name.
  if (!/^https?:\/\//i.test(v)) fail("INVALID_INPUT", "url must start with http:// or https://");
  // `https://admin:hunter2@host` would put a password in a NON-SECRET
  // field every credential:view holder lists and the export carries — the
  // likeliest way a secret ends up outside the ciphertext (both reviews).
  if (parsed.username !== "" || parsed.password !== "") fail("INVALID_INPUT", "url must not carry a username or password");
  // …and an `@` anywhere before the path, even one the parser reads
  // another way (`https://@host`, `https://a\@host`): the asset table's
  // CHECK refuses exactly this pattern, and the service must refuse it
  // first, with a message (slice 87's migration review).
  if (USERINFO.test(v)) fail("INVALID_INPUT", "url must not carry a username or password");
  return v;
}

export function normalizeTags(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail("INVALID_INPUT", "tags must be a list");
  const out: string[] = [];
  for (const t of raw as unknown[]) {
    const v = trimmedOrNull(t, TAG_MAX, "tag");
    if (v !== null && !out.includes(v)) out.push(v);
  }
  if (out.length > TAGS_MAX) fail("INVALID_INPUT", "too many tags");
  return out;
}

export function normalizeRotateEveryDays(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > ROTATE_DAYS_MAX) {
    fail("INVALID_INPUT", "rotateEveryDays");
  }
  return raw as number;
}

export function normalizeExpiresAt(raw: unknown): Date | null {
  if (raw === undefined || raw === null) return null;
  if (!(raw instanceof Date) || Number.isNaN(raw.getTime())) fail("INVALID_INPUT", "expiresAt");
  return raw as Date;
}
