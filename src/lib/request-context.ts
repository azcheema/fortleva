import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context propagated via AsyncLocalStorage (DATA_MODEL.md
 * §3: requestId on every AuditEvent). Populated at the route-group
 * entry points; absent in jobs/tests, where audit rows simply carry
 * NULL request fields.
 */
export type RequestContext = {
  readonly requestId: string;
  readonly ip?: string;
  readonly userAgent?: string;
};

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export const requestContext = (): RequestContext | undefined =>
  requestContextStorage.getStore();

export const withRequestContext = <T>(ctx: RequestContext, fn: () => T): T =>
  requestContextStorage.run(ctx, fn);
