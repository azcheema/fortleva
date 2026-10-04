import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";

import { shareCodeKey } from "@/config";

/**
 * THE SHARE LINK'S TWO SECRETS, PURE (Phase 3V slice 90; DATA_MODEL.md
 * §6.17; SECURITY.md's "Credential share links" row). No database, no
 * clock, so the unit suite covers every branch.
 *
 * THE TOKEN is `<tenantId>.<random>`: the tenant id says which tenant to
 * open `withTenant` for (there is no session to say it), and the random
 * part — 32 bytes, base64url — is the credential. Only the sha256 of the
 * random part is stored, so a dump of the table opens nothing. A token
 * whose tenant half was edited simply hashes to nothing in that tenant.
 *
 * THE CODE is six digits, mailed to the link's recipient each time they
 * ask, and stored as HMAC-SHA256(`<linkId>:<code>`) under `shareCodeKey`
 * (src/config): bound to ONE link, so a hash copied onto another row
 * matches nothing, and KEYED, because a plain hash of six digits is the
 * code — a dump plus a forwarded link would reverse it in a second (the
 * migration's pre-apply review). Six digits are guessable only by trying,
 * and the link's row allows five tries in its whole life — that, not the
 * code's length, is the bound.
 */

/**
 * THE BOUNDS, each restated by a CHECK on `credential_share_link`
 * (migration 20261004120000): five code checks in a link's whole life —
 * the fifth wrong one ends it, so a guesser gets five tries at a million —
 * and five codes mailed. A code lives ten minutes, and a new one may be
 * asked for half a minute after the last.
 */
export const SHARE_MAX_CODE_ATTEMPTS = 5;
export const SHARE_MAX_CODES = 5;
export const SHARE_CODE_TTL_MS = 10 * 60_000;
export const SHARE_CODE_SPACING_MS = 30_000;

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 32 bytes of base64url, unpadded. */
const RANDOM_PART = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_MAX = 36 + 1 + 43;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A new link's token, and the hash that is all the database keeps of it. */
export function mintShareToken(tenantId: string): { readonly token: string; readonly tokenHash: string } {
  if (!TENANT_ID.test(tenantId)) throw new Error("vault: a share token needs a tenant id");
  const random = randomBytes(32).toString("base64url");
  return { token: `${tenantId}.${random}`, tokenHash: sha256(random) };
}

/**
 * A token from a URL → the tenant to open and the hash to look up, or null
 * for anything that is not exactly the shape `mintShareToken` makes. Every
 * malformed token is the same `null`: on the share page a difference is a
 * fact about the agency.
 */
export function parseShareToken(raw: unknown): { readonly tenantId: string; readonly tokenHash: string } | null {
  if (typeof raw !== "string" || raw.length !== TOKEN_MAX) return null;
  const dot = raw.indexOf(".");
  if (dot !== 36) return null;
  const tenantId = raw.slice(0, dot);
  const random = raw.slice(dot + 1);
  if (!TENANT_ID.test(tenantId) || !RANDOM_PART.test(random)) return null;
  return { tenantId, tokenHash: sha256(random) };
}

/** Where a link stands. Only `waiting` can still be opened. */
export type ShareLinkStatus = "waiting" | "viewed" | "revoked" | "stopped" | "expired" | "locked" | "changed";

/**
 * ONE RULE FOR BOTH HALVES — the member's list says it, the share page
 * acts on it — in the order that names what actually ended a link: a link
 * opened and then expired was OPENED. `stopped` is a link made before
 * share links were last switched OFF for the workspace (`stoppedBefore`,
 * the `vault.shareLinksStoppedAt` stamp) and still in date then — dead for
 * good, so switching them on again revives nothing. `locked` is five code checks spent, or
 * five codes mailed with none still live (nothing could open it now);
 * `changed` is a login whose secret was replaced after the link was made
 * (`currentVersion` null: the secret row is gone, which is changed too),
 * named only for a link still in date — one that had already expired
 * expired.
 */
export function shareLinkStatus(
  link: {
    readonly viewedAt: Date | null;
    readonly revokedAt: Date | null;
    readonly codeAttempts: number;
    readonly codesSent: number;
    readonly codeExpiresAt: Date | null;
    readonly secretVersion: number;
    readonly expiresAt: Date;
    readonly createdAt: Date;
  },
  currentVersion: number | null,
  now: Date,
  stoppedBefore: Date | null,
): ShareLinkStatus {
  if (link.viewedAt !== null) return "viewed";
  if (link.revokedAt !== null) return "revoked";
  // Five wrong codes ended a link before any stop could: nothing is checked
  // once links are off.
  if (link.codeAttempts >= SHARE_MAX_CODE_ATTEMPTS) return "locked";
  // Five codes mailed with none live (now — or already at the stop) leave
  // nothing that could open it.
  const codesSpentBy = (at: Date) =>
    link.codesSent >= SHARE_MAX_CODES && !(link.codeExpiresAt !== null && link.codeExpiresAt.getTime() > at.getTime());
  // Stopped only if the stop came while it was still in date and still
  // openable — one that had already expired EXPIRED, one whose last code
  // had lapsed was LOCKED (the reviews: the label names what ended it).
  if (stoppedBefore !== null && link.createdAt.getTime() <= stoppedBefore.getTime()) {
    if (codesSpentBy(stoppedBefore)) return "locked";
    if (link.expiresAt.getTime() > stoppedBefore.getTime()) return "stopped";
  }
  if (codesSpentBy(now)) return "locked";
  if (link.expiresAt.getTime() <= now.getTime()) return "expired";
  if (currentVersion !== link.secretVersion) return "changed";
  return "waiting";
}

/** The path a share link opens — the one place it is spelled. */
export const shareLinkPath = (token: string): string => `/portal/share/${token}`;

/** A fresh six-digit code, every value equally likely. */
export const newShareCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** What the database keeps of a code: keyed, and bound to the link it was sent for. */
export const hashShareCode = (linkId: string, code: string): string =>
  createHmac("sha256", shareCodeKey).update(`${linkId}:${code}`).digest("hex");

/**
 * What a visitor typed → six digits, or null. Spaces and dashes are
 * forgiven (a code read aloud or pasted from a mail arrives as "123 456");
 * anything else is not a code.
 */
export function normalizeShareCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 32) return null;
  const digits = raw.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}
