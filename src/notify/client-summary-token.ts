import { createHmac, timingSafeEqual } from "node:crypto";

import { clientSummaryLinkKey } from "@/config";

/**
 * THE CLIENTS' WEEKLY SUMMARY'S UNSUBSCRIBE LINK, PURE (Phase 5 slice 101;
 * founder decision C69; RFC 8058). No database, no clock, so the unit suite
 * covers every branch.
 *
 * THE TOKEN is `<tenantId>.<contactId>.<mac>`: the two ids say which
 * workspace to open and whose summary it is (the person pressing has no
 * session to say either), and the mac — HMAC-SHA256 over both under
 * `clientSummaryLinkKey`, base64url — is what makes it theirs. STATELESS on
 * purpose: a link stored as a hash could not be put into next week's mail
 * again, and a link minted afresh each week would kill the one in every
 * older mail, which a person who wants these to stop is entitled to use
 * (`notification_preference.unsubscribe_token_hash` stays unused — DATA_MODEL
 * §6.18 item 9). It never expires; rotating the secret voids every link.
 *
 * ALL IT CAN EVER DO is stop or start one person's weekly summary, and the
 * ids in it are not secrets — so its leaking (a forwarded mail) costs that
 * person a setting they can flip back, never anything they can see.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 32 bytes of base64url, unpadded. */
const MAC = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_LENGTH = 36 + 1 + 36 + 1 + 43;

const macOf = (tenantId: string, contactId: string): string =>
  createHmac("sha256", clientSummaryLinkKey).update(`client-summary:v1:${tenantId}:${contactId}`).digest("base64url");

/** The link token for one person's summary. */
export function clientSummaryToken(tenantId: string, contactId: string): string {
  if (!UUID.test(tenantId) || !UUID.test(contactId)) throw new Error("notify: a summary link needs two ids");
  return `${tenantId}.${contactId}.${macOf(tenantId, contactId)}`;
}

/**
 * A token from a URL → whose summary it is, or null for anything that is not
 * exactly what `clientSummaryToken` makes under this deployment's key. Every
 * refusal is the same `null`, and none of them reads the database.
 */
export function readClientSummaryToken(raw: unknown): { readonly tenantId: string; readonly contactId: string } | null {
  if (typeof raw !== "string" || raw.length !== TOKEN_LENGTH) return null;
  if (raw.indexOf(".") !== 36 || raw.indexOf(".", 37) !== 73) return null;
  const tenantId = raw.slice(0, 36);
  const contactId = raw.slice(37, 73);
  const mac = raw.slice(74);
  if (!UUID.test(tenantId) || !UUID.test(contactId) || !MAC.test(mac)) return null;
  // Compared as the TEXT, not the decoded bytes: base64url's last character
  // carries two unused bits, so four spellings decode alike — and one link
  // should have one spelling.
  const expected = Buffer.from(macOf(tenantId, contactId), "ascii");
  const given = Buffer.from(mac, "ascii");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { tenantId, contactId };
}
