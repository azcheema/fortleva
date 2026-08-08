import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The principal executing a unit of work (TENANCY.md §4.1). Comes from
 * the session / tenant-resolution seam — NEVER from request params.
 */
export type Principal =
  | { type: "member"; id: string }
  | { type: "contact"; id: string; clientId: string }
  | { type: "platform_admin"; id: string }
  | { type: "system" };

export type TenantContext = {
  readonly tenantId: string;
  readonly principal: Principal;
};

/** Carries tenant context to the where-injection extension (belt two)
 * for the duration of one withTenant() unit of work. */
export const tenantContextStorage = new AsyncLocalStorage<TenantContext>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_RE.test(value);
