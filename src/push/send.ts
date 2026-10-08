import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { pushEndpointUrl, pushTransportKind } from "@/config";

import type { PushRequest } from "./web-push";

/**
 * HOW ONE PUSH LEAVES, AND WHAT ITS ANSWER MEANS (Phase 5 slice 106).
 *
 * The endpoint is a URL the member's browser chose, so the request is fenced
 * (`pushEndpointUrl` again here, whatever was checked at registration): no
 * redirect is followed (a push service never redirects; a 3xx is a refusal), a
 * ten-second ceiling, and the answer's body is never read — only its status.
 *
 * The answer, as the drain counts it (`src/jobs/push.ts`; SECURITY.md §10
 * "until unsubscribed / 3 consecutive failures"):
 *   - 2xx → delivered.
 *   - 404 / 410 → GONE: the browser dropped the subscription (signed out of
 *     the browser profile, cleared site data, uninstalled) — the row goes now.
 *   - 400, 413 and any other 4xx not named here, and a 3xx → REFUSED: the
 *     push service will not take THIS subscription (malformed, too large).
 *     Three in a row and the row goes.
 *   - 401, 403, 406, 429, 5xx, a timeout, a network error → TRANSIENT: never
 *     counted. 429 and 5xx are the vendor's trouble; 401 and 403 are almost
 *     always OURS — a VAPID signature the service will not accept (a subject
 *     it refuses, a clock that skews the token's expiry, a key pair replaced)
 *     — and 406 is Microsoft's throttling. Counting any of them would forget
 *     every device a vendor serves in three pushes, for a fault no device has
 *     (both reviews' medium; `src/push/keys.ts` says the same of other
 *     environments' rows).
 * Nothing is retried: a push is late or never (the email and the inbox carry
 * it — C74 (e)).
 */

export type PushOutcome =
  | { readonly kind: "delivered" }
  | { readonly kind: "gone"; readonly status: number }
  | { readonly kind: "refused"; readonly status: number }
  | { readonly kind: "transient"; readonly status: number | null; readonly error: string | null };

export type PushTransport = (request: PushRequest) => Promise<PushOutcome>;

const SEND_TIMEOUT_MS = 10_000;

/** Answers that are never the device's fault (see above). */
const NOT_THE_DEVICE = new Set([401, 403, 406, 429]);

export function classifyPushStatus(status: number): PushOutcome {
  if (status >= 200 && status < 300) return { kind: "delivered" };
  if (status === 404 || status === 410) return { kind: "gone", status };
  if (NOT_THE_DEVICE.has(status) || status >= 500) return { kind: "transient", status, error: null };
  return { kind: "refused", status };
}

/** The error's NAME only — a message can carry the URL, and the endpoint is a device's address. */
const errorName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

/** POST to the push service. */
export const webPushTransport: PushTransport = async (request) => {
  // The fence again at the last moment, on the URL actually requested.
  if (pushEndpointUrl(request.endpoint.toString()) === null) return { kind: "refused", status: 0 };
  let response: Response;
  try {
    response = await fetch(request.endpoint, {
      method: "POST",
      headers: request.headers,
      body: new Uint8Array(request.body),
      redirect: "manual",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    return { kind: "transient", status: null, error: errorName(e) };
  }
  // Never read: release the connection.
  await response.body?.cancel().catch(() => undefined);
  return classifyPushStatus(response.status);
};

/**
 * `PUSH_TRANSPORT=dev` (`src/config`): one JSON line per request in
 * `.dev-outbox/push.jsonl` — the endpoint, the headers WITHOUT the VAPID
 * signature, and the encrypted body — for the e2e harness to decrypt with the
 * private key it made the device's keys from. Always "delivered".
 */
export const devPushTransport: PushTransport = async (request) => {
  const dir = join(process.cwd(), ".dev-outbox");
  mkdirSync(dir, { recursive: true });
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name !== "Authorization"));
  appendFileSync(
    join(dir, "push.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), endpoint: request.endpoint.toString(), headers, body: request.body.toString("base64url") })}\n`,
  );
  return { kind: "delivered" };
};

/** The transport this process uses, or null when push is not configured. */
export const configuredPushTransport = (): PushTransport | null =>
  pushTransportKind === "web-push" ? webPushTransport : pushTransportKind === "dev" ? devPushTransport : null;
