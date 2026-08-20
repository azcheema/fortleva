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

export async function ensureTimeDefaults(tenantId: string): Promise<void> {
  if (seeded.has(tenantId)) return;
  await withTenant(tenantId, { type: "system" }, async (tx) => {
    await ensureStaffNotice(tx, tenantId);
    await ensureWorkTypes(tx, tenantId);
  });
  seeded.add(tenantId);
}

/** Test hook: forget the memo (a torn-down tenant id may be reused). */
export const resetTimeDefaultsMemo = (): void => {
  seeded.clear();
};
