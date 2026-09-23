/**
 * WHO IS ASKING, DERIVED FROM A CHAIN THE CALLER CANNOT WRITE ALL OF —
 * one implementation, used by the rate limiter and by the audit trail.
 *
 * **WHY THIS FILE EXISTS.** There were two derivations in the product
 * and they disagreed. `src/ratelimit`'s read `x-real-ip` FIRST and fell
 * back to the LEFTMOST entry of `x-forwarded-for`;
 * `src/lib/request-context`'s did the opposite. Both are values a client
 * can set: RUNBOOK's documented self-host deployment puts one
 * TLS-terminating proxy in front and forwards `x-forwarded-for`, nothing
 * strips an inbound `x-real-ip`, and nginx's standard
 * `$proxy_add_x_forwarded_for` APPENDS the peer to whatever the client
 * sent — so the leftmost entry is the client's own contribution.
 *
 * That was survivable while every bucket was either a no-op or backed by
 * a fail-closed Postgres counter. It stopped being survivable when the
 * portal invitation acceptance page made an in-process limiter the ONLY
 * control on an unauthenticated route: `curl -H 'X-Real-Ip: <random>'`
 * in a loop was a brand-new subject with a brand-new budget every time,
 * and the limit that the page's whole design rests on never refused
 * anything. Found by this slice's security review.
 *
 * **THE RULE: COUNT FROM THE RIGHT, NEVER FROM THE LEFT.** The rightmost
 * entry of `x-forwarded-for` was written by the hop nearest us, which we
 * control; everything to its left may be invention. With `hops` trusted
 * proxies in front, the `hops`-th entry from the right is the first one
 * our own infrastructure wrote and therefore the first one a client could
 * not forge. A chain SHORTER than the declared hop count means the
 * request did not arrive the way the deployment says it does, so it
 * resolves to `UNKNOWN_SUBJECT` rather than to a value from the wrong
 * position — a limiter that shares one bucket is a worse outcome than a
 * forged one only if you ignore that the forged one has no bucket at all.
 *
 * `x-real-ip` is deliberately NOT consulted. It carries no chain, so
 * there is no position from which to read it safely, and the deployment
 * document does not promise it is set.
 */

/** Longest thing that can be an address, plus room for an IPv6 zone. */
const MAX_SUBJECT = 64;

/**
 * The subject when we cannot say who is asking. Every such request
 * shares one bucket, which is the safe direction: a caller who strips
 * the chain gets the tightest budget in the product, not the loosest.
 */
export const UNKNOWN_SUBJECT = "unknown";

/**
 * `get` is a header lookup rather than a `Headers`, so this works for
 * Next's `headers()`, a `Request`, Better Auth's middleware context and
 * a plain object in a test — and so it stays pure and unit-testable.
 */
export function clientIpFrom(get: (name: string) => string | null, hops: number): string {
  if (hops < 1) return UNKNOWN_SUBJECT;
  const chain = (get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop !== "");
  // Fewer hops present than declared: do not reach further left.
  if (chain.length < hops) return UNKNOWN_SUBJECT;
  const value = chain[chain.length - hops];
  if (!value) return UNKNOWN_SUBJECT;
  // BOUNDED, because this string becomes a key in an in-process Map that
  // an unauthenticated caller can cause entries in. The cap on the
  // NUMBER of subjects is worth nothing if one subject may be a megabyte.
  // Truncation can only ever merge two callers into one bucket, which
  // errs toward limiting more.
  return value.length > MAX_SUBJECT ? value.slice(0, MAX_SUBJECT) : value;
}
