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

import { isIPv4, isIPv6 } from "node:net";

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

/**
 * THE RATE LIMITER'S SOURCE for an address — the address itself for IPv4,
 * its /64 (or, asked for it, its /48) for IPv6. NOT the audit row's `ip`, which keeps the address as
 * the chain gave it (`clientIpFrom` above); this is only what a budget is
 * counted against.
 *
 * **WHY.** One IPv6 host is routinely handed a whole /64 — 2^64 addresses,
 * every one a fresh per-IP and per-source budget. Counted per address, the
 * per-source tier on sign-in (`src/auth/rate-limit-hook.ts`) let one
 * ordinary VPS put twenty guesses into an account's ceiling from twenty
 * addresses and keep it shut — the one-machine lockout that tier exists to
 * prevent, back again for anybody with IPv6 (slice 81's fix-pass review).
 * A /64 is what one subscriber, one VPS, one LAN is given, so it is the
 * smallest unit that is somebody rather than one of their addresses.
 *
 * **AND A /48 WHERE THE BUDGET IS PER ACCOUNT** (the narrow review after
 * the fix pass): a /64 is not the most one person holds — a free tunnel
 * broker routes a /48 (65,536 /64s) to anyone with an IPv4 address, and
 * VPS hosts and residential ISPs (RIPE-690) hand out /56s and /48s — so a
 * per-account tier counted by /64 was still a one-machine lockout for them.
 * The sign-in limiter's per-CREDENTIAL-from-a-source tier therefore asks
 * for 48; the per-IP tier keeps 64, because it is shared by every account
 * on a plane and a /48 can be a whole organisation.
 *
 * An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`, or its hex spelling) is
 * the IPv4 address it carries, or every IPv4 caller behind a dual-stack
 * listener would share one /64. Anything that is not an IP — `unknown`, a
 * truncated chain entry — is returned as it is: it is already one bucket.
 */
export function rateLimitSource(address: string, ipv6Prefix: 48 | 64 = 64): string {
  if (isIPv4(address)) return address;
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const groups = isIPv6(bare) ? ipv6Groups(bare) : null;
  if (!groups) return address;
  const [a, b, c, d, e, f, g, h] = groups as [number, number, number, number, number, number, number, number];
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return `${g >> 8}.${g & 0xff}.${h >> 8}.${h & 0xff}`;
  }
  const kept = ipv6Prefix === 48 ? [a, b, c] : [a, b, c, d];
  return `${kept.map((n) => n.toString(16)).join(":")}::/${ipv6Prefix}`;
}

/** The eight 16-bit groups of a VALID IPv6 address (`isIPv6` first), `::` and an IPv4 tail expanded. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [, p, q, r, s] = tail.map(Number) as [number, number, number, number, number];
    text = `${text.slice(0, tail.index)}${((p << 8) | q).toString(16)}:${((r << 8) | s).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : null;
}
