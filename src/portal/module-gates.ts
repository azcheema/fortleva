import { withTenant } from "@/db";
import { parseEntitlements } from "@/entitlements/resolver";

import { PORTAL_MODULES } from "./capabilities";
import { computePortalModuleGates, type PortalModuleGates } from "./policy";

/**
 * GATES 1–3 FOR THE PORTAL PLANE, AND WHY THEY CANNOT BE READ THE WAY
 * EVERY OTHER GATE IN THE PRODUCT IS READ.
 *
 * `requireAccess()` resolves the kill-switch, the entitlement and the
 * tenant preference inside the CALLER'S transaction. Doing the same
 * under a contact principal is not a cheaper or slower choice — it is
 * a silently WRONG one, and it fails in the worst available direction:
 *
 *   `feature_flag` is a global table with `portal_deny`;
 *   `tenant_preference` is class A with `portal_deny`;
 *   `tenant` carries `portal_deny` as well.
 *
 * A contact-principal read of all three returns ZERO ROWS — and every
 * one of those three "no row" answers means *enabled* to the existing
 * readers. `flagEnabled` treats a missing flag as on (correctly: flags
 * gate rollouts). `parseEntitlements(undefined)` falls back to the
 * everything-on default. `preferenceEnabled` treats a missing row as
 * enabled. So gates 1, 2 and 3 would every one of them have PASSED for
 * every tenant, including a tenant that had deliberately switched the
 * portal off, and no test that ran inside a contact transaction could
 * have seen it: the result is identical to the correct answer whenever
 * the tenant has nothing switched off.
 *
 * So the read happens here, in its own short transaction under the
 * SYSTEM principal, and the portal's own rule — "portal reads never run
 * under a system principal" (TENANCY.md §7.2) — is respected rather than
 * bent, because that rule is about PROJECTIONS: "a projection built
 * under `system` has lost the RLS net and is the archetype of this bug."
 * Nothing client-scoped is read here and nothing client-scoped can be
 * returned: the value is a fixed-shape map from module name to one of
 * four enum states, over a module list that is a compile-time constant.
 * There is no row, no id and no string from the database in the result.
 * `portal-authz.dbtest.ts` pins that shape.
 *
 * It is resolved ONCE per request (`src/portal/context.ts` memoises it
 * with React's request-scoped `cache`) and handed to `authorizePortal()`
 * as data, so a capability check inside a projection costs nothing and
 * cannot forget to ask.
 */

const flagKey = (module: string) => `module.${module}`;
const preferenceKey = (module: string) => `module.${module}.enabled`;

const FLAG_KEYS = PORTAL_MODULES.map(flagKey);
const PREFERENCE_KEYS = PORTAL_MODULES.map(preferenceKey);

export async function resolvePortalModuleGates(tenantId: string): Promise<PortalModuleGates> {
  return withTenant(tenantId, { type: "system" }, async (tx) => {
    const [tenant, flags, preferences] = await Promise.all([
      tx.tenant.findFirst({ where: { id: tenantId }, select: { entitlements: true } }),
      tx.featureFlag.findMany({
        where: { key: { in: FLAG_KEYS } },
        select: { key: true, defaultOn: true, tenantOverrides: true },
      }),
      tx.tenantPreference.findMany({
        where: { tenantId, key: { in: PREFERENCE_KEYS } },
        select: { key: true, value: true },
      }),
    ]);

    const flagOff = new Set<string>();
    for (const flag of flags) {
      // The same resolution `flagEnabled` performs, kept in step with it
      // deliberately rather than shared: this one answers for several
      // modules from one read, and a per-module call would be four more
      // round trips on the plane that can least afford them.
      const overrides = (flag.tenantOverrides ?? {}) as Record<string, boolean>;
      const on = overrides[tenantId] ?? flag.defaultOn;
      if (!on) flagOff.add(flag.key.slice("module.".length));
    }

    const preferenceOff = new Set<string>();
    for (const pref of preferences) {
      // `preferenceEnabled`'s predicate exactly: only a literal `false`
      // disables. Anything else — including a missing row — is enabled.
      if (pref.value === false) {
        preferenceOff.add(pref.key.slice("module.".length, -".enabled".length));
      }
    }

    // A MISSING TENANT ROW DENIES, and this line is the one the rest
    // of this file's argument would otherwise have walked straight into
    // (code review, 2026-09-20). `parseEntitlements(undefined)` returns
    // the everything-on default, so `tenant?.entitlements` on a null row
    // would have resolved every gate to "ok" — reproducing, in the
    // fallback, exactly the "absent means enabled" failure the header
    // above refuses to accept from the contact principal. Unreachable in
    // practice (a system principal reading its own tenant inside
    // `withTenant`), and one line to close.
    if (!tenant) {
      return Object.fromEntries(
        PORTAL_MODULES.map((m) => [m, "NOT_ENTITLED"]),
      ) as PortalModuleGates;
    }

    return computePortalModuleGates({
      entitlements: parseEntitlements(tenant.entitlements),
      flagOff,
      preferenceOff,
    });
  });
}
