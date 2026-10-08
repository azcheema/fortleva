/**
 * Phone and browser notifications, the BROWSER's half (Phase 5 slice 106;
 * C74). Client-safe: no server import, no Node builtin (`client-graph.test.ts`
 * walks what client components reach). What the settings island and
 * `PwaRegister` ask of the browser.
 */

/** base64url → bytes, for `applicationServerKey`. */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Whether this browser's subscription was made with THIS server's key. One
 * made with an older key accepts nothing we sign (RFC 8292), and the browser
 * refuses to subscribe again with a new key until the old one is dropped
 * (`InvalidStateError` — the design review's nit).
 */
export function madeWithKey(subscription: PushSubscription, publicKey: string): boolean {
  const held = subscription.options?.applicationServerKey;
  if (!held) return false;
  const a = new Uint8Array(held);
  const b = base64UrlToBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The same 16-hex-character SHA-256 prefix the server gives each device row
 * (`endpointHash`) — over the CANONICAL href, as the server stores it.
 */
export async function endpointHashOf(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(new URL(endpoint).href));
  return [...new Uint8Array(digest)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** iPhone or iPad — including an iPad that says it is a Mac. */
const isAppleMobile = (): boolean =>
  /\b(iPad|iPhone|iPod)\b/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const isInstalled = (): boolean =>
  window.matchMedia?.("(display-mode: standalone)").matches === true ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export type PushSupport = "supported" | "ios-install" | "unsupported";

/**
 * Can this browser take notifications at all? On iPhone and iPad only Fortleva
 * added to the Home Screen can (Apple's rule, ARC-25), and Safari outside it
 * has no `PushManager` — so the answer there is "install first", not "no".
 */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const has = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (has) return "supported";
  return isAppleMobile() && !isInstalled() ? "ios-install" : "unsupported";
}
