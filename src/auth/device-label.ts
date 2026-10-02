import { isIP } from "node:net";

import { rateLimitSource } from "@/lib/client-ip";

/**
 * What "Your devices" says about a session (slice 84, C50): the browser
 * and system its user agent names, and the network its address sits in.
 *
 * PURE, and deliberately small. A user agent is the client's own claim —
 * a thief's browser can say anything — so this is a recognition aid for
 * the account's owner ("that's my laptop"), never evidence, and it is
 * not worth a parsing library: the dozen families people actually use,
 * in the order their strings overlap (Edge and Opera carry "Chrome";
 * Chrome carries "Safari"), and "unknown" for the rest.
 *
 * THE NETWORK, NOT THE ADDRESS. The brief asked for a rough PLACE, and a
 * place name needs a geolocation database the product does not ship —
 * sending members' addresses to a third-party lookup is not something
 * this product does (EU residency). So the row shows the network the
 * address belongs to — an IPv4 /24, an IPv6 /48 — which is what a person
 * can recognise ("the office", "home") and less than the whole address.
 * The address comes from the product's one trusted derivation
 * (`src/lib/client-ip.ts`), stamped on the session when it is created
 * (`./index` and `./platform`, `session.create.before`), so a caller
 * cannot write the network their session shows.
 */

export type DeviceKind = "desktop" | "mobile" | "tablet";

export type DeviceLabel = {
  /** A product name ("Chrome", "Firefox"), or null when unrecognised. */
  readonly browser: string | null;
  /** A system name ("Windows", "iOS"), or null when unrecognised. */
  readonly os: string | null;
  readonly kind: DeviceKind;
};

/** First match wins, so the families that IMITATE another come first. */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\b(?:OPR|Opera)\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bVivaldi\//, "Vivaldi"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\/|\b(?:Headless)?Chrome\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

const firstMatch = (ua: string, table: ReadonlyArray<readonly [RegExp, string]>): string | null =>
  table.find(([re]) => re.test(ua))?.[1] ?? null;

/** Longer than any real browser sends; past it nothing is parsed. */
const UA_MAX = 512;

export function deviceLabel(userAgent: string | null | undefined): DeviceLabel {
  const ua = (userAgent ?? "").slice(0, UA_MAX);
  // Android says "Mobile" on a phone and nothing on a tablet.
  const kind: DeviceKind = /\biPad\b|\bTablet\b/.test(ua)
    ? "tablet"
    : /\bMobi|\biPhone\b|\biPod\b/.test(ua)
      ? "mobile"
      : /\bAndroid\b/.test(ua)
        ? "tablet"
        : "desktop";
  return { browser: firstMatch(ua, BROWSERS), os: firstMatch(ua, SYSTEMS), kind };
}

/**
 * The network an address belongs to, written the way a person reads it:
 * `203.0.113.x` for IPv4 (an IPv4-mapped IPv6 address, in either spelling,
 * is the IPv4 one) and `2001:db8:1::/48` for IPv6 — or null when the value
 * is not an address. The IPv6 /48 is the rate limiter's own derivation
 * (`rateLimitSource`), not a second parser.
 */
export function networkOf(address: string | null | undefined): string | null {
  const raw = (address ?? "").trim();
  if (raw === "" || raw.length > 64 || isIP(raw) === 0) return null;
  const source = rateLimitSource(raw, 48);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(source);
  return v4 ? `${v4[1]}.${v4[2]}.${v4[3]}.x` : source;
}
