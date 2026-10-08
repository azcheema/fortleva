import { createHash } from "node:crypto";

import { webPushConfig } from "@/config";

import { vapidKeysOf, type VapidKeys } from "./web-push";

/**
 * THIS SERVER'S VAPID PAIR, decoded once (`src/config` already refused a pair
 * that does not belong together), and its FINGERPRINT — what each device row
 * records as the key it subscribed with (`push_subscription.vapid_key`).
 *
 * WHY A FINGERPRINT ON THE ROW (the design review's M3): a browser accepts
 * pushes signed only with the key it subscribed against, so a row made under
 * another key — another environment sharing or copying this database, a key
 * pair replaced — can never be delivered by this server, and its push service
 * answers 401/403 for reasons that are OURS, not the device's. Counting those
 * would delete every device in three pushes. So a server claims and sends only
 * for rows carrying its own fingerprint, and never counts refusals against the
 * others. (Housekeeping — a member no longer active, a sign-in dormant 90 days —
 * applies to every row whatever its key: those facts live in this database,
 * and every environment reading it reaches the same answer.)
 */

let cached: { readonly keys: VapidKeys; readonly fingerprint: string } | null | undefined;

/** 22 base64url characters of SHA-256 over the raw public key: enough to tell pairs apart, nothing to sign with. */
export const vapidFingerprint = (publicKey: Uint8Array): string =>
  createHash("sha256").update(publicKey).digest("base64url").slice(0, 22);

export function serverVapid(): { readonly keys: VapidKeys; readonly fingerprint: string } | null {
  if (cached !== undefined) return cached;
  const keys = webPushConfig === null ? null : vapidKeysOf(webPushConfig.publicKey, webPushConfig.privateKey, webPushConfig.subject);
  cached = keys === null ? null : { keys, fingerprint: vapidFingerprint(keys.publicKey) };
  return cached;
}

/** The public key browsers subscribe with (`applicationServerKey`), or null when push is not configured. */
export const serverVapidPublicKey = (): string | null => webPushConfig?.publicKey ?? null;
