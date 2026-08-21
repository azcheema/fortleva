import { withTenant } from "@/db";

import { ensureStaffNotice } from "./notice";
import { ensureWorkTypes } from "./work-types";

/**
 * First-use bootstrap of the time module in a tenant: the sv/en staff
 * notice (version 1, published by the system) and the six localized
 * work types. Lazy — like ensureProjectStates in the work module — so
 * existing tenants (Naxdor) need no provisioning step, and idempotent
 * (counts + unique constraints). Runs under the SYSTEM principal so the
 * audit row for the seeded notice names SYSTEM. A per-process memo
 * keeps the hot path at zero queries after the first call.
 */
const seeded = new Set<string>();
/** In-flight seeds: concurrent first callers (a page's parallel reads) share ONE transaction instead of racing three. */
const seeding = new Map<string, Promise<void>>();

export async function ensureTimeDefaults(tenantId: string): Promise<void> {
  if (seeded.has(tenantId)) return;
  let p = seeding.get(tenantId);
  if (!p) {
    p = withTenant(tenantId, { type: "system" }, async (tx) => {
      await ensureStaffNotice(tx, tenantId);
      await ensureWorkTypes(tx, tenantId);
    }).then(
      () => {
        seeded.add(tenantId);
        seeding.delete(tenantId);
      },
      (e: unknown) => {
        seeding.delete(tenantId);
        throw e;
      },
    );
    seeding.set(tenantId, p);
  }
  return p;
}

/** Test hook: forget the memo (a torn-down tenant id may be reused). */
export const resetTimeDefaultsMemo = (): void => {
  seeded.clear();
  seeding.clear();
};
