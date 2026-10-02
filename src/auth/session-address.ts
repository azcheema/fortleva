import { trustedProxyHops } from "@/config";
import { UNKNOWN_SUBJECT, clientIpFrom } from "@/lib/client-ip";

/**
 * THE ADDRESS A NEW SESSION IS STAMPED WITH — the product's one trusted
 * derivation (`src/lib/client-ip.ts`: the hop `TRUSTED_PROXY_HOPS` from
 * the RIGHT of `x-forwarded-for`), not Better Auth's own, which reads
 * headers a caller writes.
 *
 * It matters since slice 84: "Your devices" on `/account` shows each
 * session's network (`./device-label`), and a person deciding whether a
 * session is theirs must not be shown a network the session's holder
 * chose. Written by the member and console instances'
 * `session.create.before` hooks; null when no trustworthy address can be
 * derived (a server-side call with no request, a chain shorter than the
 * proxies declared), which the list shows as no network at all.
 */
export function trustedSessionAddress(headers: Headers | null | undefined): string | null {
  if (!headers) return null;
  const address = clientIpFrom((name) => headers.get(name), trustedProxyHops);
  return address === UNKNOWN_SUBJECT ? null : address;
}
