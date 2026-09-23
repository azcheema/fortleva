import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { cache } from "react";

import { trustedProxyHops } from "@/config";
import { clientIpFrom, UNKNOWN_SUBJECT } from "@/lib/client-ip";

/**
 * Per-request context (DATA_MODEL.md §3: requestId/ip/userAgent on every
 * AuditEvent). Two sources, checked in order:
 *   1. an explicit AsyncLocalStorage store (jobs, tests, anything that
 *      wants to name its own requestId via withRequestContext);
 *   2. the Next.js request scope — `headers()` from next/headers, which
 *      covers pages, server actions and route handlers without any
 *      per-entry-point wrapping. Outside a request it throws → undefined,
 *      and audit rows simply carry NULL request fields.
 */
export type RequestContext = {
  readonly requestId: string;
  readonly ip?: string;
  readonly userAgent?: string;
};

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/** Synchronous ALS read only — kept for callers that own the store. */
export const requestContext = (): RequestContext | undefined =>
  requestContextStorage.getStore();

export const withRequestContext = <T>(ctx: RequestContext, fn: () => T): T =>
  requestContextStorage.run(ctx, fn);

/**
 * One generated id per React request scope (cache() memoizes per
 * request on the server; outside a request it just calls through).
 */
const generatedRequestId = cache((): string => randomUUID());

/**
 * The client address for an audit row — THE SAME DERIVATION THE RATE
 * LIMITER USES, and that is the point of the shared leaf.
 *
 * These were two functions with OPPOSITE precedences over the same two
 * headers: this one preferred the leftmost `x-forwarded-for` hop, the
 * limiter's preferred `x-real-ip`. So one request could be limited under
 * one address and recorded under another, and a caller who forged the
 * header the limiter read did not even appear in the trail the row
 * exists to provide. Both now count from the right of a chain the caller
 * cannot write all of (`src/lib/client-ip.ts`), and `undefined` here
 * means the same thing the limiter's `UNKNOWN_SUBJECT` means: the
 * request did not arrive the way the deployment says it does.
 */
export const clientIpFromHeaders = (get: (name: string) => string | null): string | undefined => {
  const subject = clientIpFrom(get, trustedProxyHops);
  return subject === UNKNOWN_SUBJECT ? undefined : subject;
};

/** Derive a RequestContext from a header lookup (pure; unit-tested). */
export const requestContextFromHeaders = (
  get: (name: string) => string | null,
  fallbackRequestId: () => string,
): RequestContext => {
  const requestId =
    get("x-vercel-id")?.trim() || get("x-request-id")?.trim() || fallbackRequestId();
  const ip = clientIpFromHeaders(get);
  const userAgent = get("user-agent")?.trim() || undefined;
  return { requestId, ...(ip ? { ip } : {}), ...(userAgent ? { userAgent } : {}) };
};

export async function getRequestContext(): Promise<RequestContext | undefined> {
  const explicit = requestContextStorage.getStore();
  if (explicit) return explicit;
  try {
    // Dynamic import keeps DB-free unit tests and jobs from loading the
    // Next request machinery; outside a request scope headers() throws.
    const { headers } = await import("next/headers");
    const h = await headers();
    return requestContextFromHeaders((name) => h.get(name), generatedRequestId);
  } catch {
    return undefined;
  }
}
