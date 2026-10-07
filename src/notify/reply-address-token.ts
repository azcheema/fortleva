import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * THE REPLY ADDRESS'S CONFIRMATION LINK, PURE (Phase 5 slice 100; founder
 * decision C68 (f)). No database, no clock, so the unit suite covers every
 * branch — the share link's token shape (`src/modules/vault/share-token.ts`),
 * restated here because core code does not import from a module.
 *
 * THE TOKEN is `<tenantId>.<random>`: the tenant id says which tenant to open
 * `withTenant` for (the person confirming has no session to say it), and the
 * random part — 32 bytes, base64url — is the credential. Only its sha256 is
 * stored, in the pending row, so a dump of the table (or a tenant's own data
 * export) confirms nothing. A token whose tenant half was edited simply
 * hashes to nothing in that tenant.
 */

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 32 bytes of base64url, unpadded. */
const RANDOM_PART = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_LENGTH = 36 + 1 + 43;

const HASH = /^[0-9a-f]{64}$/;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A new request's token, and the hash that is all the database keeps of it. */
export function mintReplyAddressToken(tenantId: string): { readonly token: string; readonly tokenHash: string } {
  if (!TENANT_ID.test(tenantId)) throw new Error("notify: a reply-address token needs a tenant id");
  const random = randomBytes(32).toString("base64url");
  return { token: `${tenantId}.${random}`, tokenHash: sha256(random) };
}

/**
 * A token from a URL → the tenant to open and the hash to compare, or null for
 * anything that is not exactly the shape `mintReplyAddressToken` makes. Every
 * malformed token is the same `null`.
 */
export function parseReplyAddressToken(raw: unknown): { readonly tenantId: string; readonly tokenHash: string } | null {
  if (typeof raw !== "string" || raw.length !== TOKEN_LENGTH) return null;
  if (raw.indexOf(".") !== 36) return null;
  const tenantId = raw.slice(0, 36);
  const random = raw.slice(37);
  if (!TENANT_ID.test(tenantId) || !RANDOM_PART.test(random)) return null;
  return { tenantId, tokenHash: sha256(random) };
}

/** Constant-time comparison of two hex hashes; false for anything else. */
export function sameTokenHash(a: unknown, b: unknown): boolean {
  // The shape first: `Buffer.from(…, "hex")` stops at the first non-hex
  // pair, and `timingSafeEqual` throws on buffers of different lengths.
  if (typeof a !== "string" || typeof b !== "string" || !HASH.test(a) || !HASH.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
