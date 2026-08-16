import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { cache } from "react";

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

/** First hop of x-forwarded-for, else x-real-ip; trimmed; undefined if none. */
export const clientIpFromHeaders = (get: (name: string) => string | null): string | undefined => {
  const xff = get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  if (first) return first;
  const real = get("x-real-ip")?.trim();
  return real || undefined;
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
