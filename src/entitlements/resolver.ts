import { z } from "zod";

import type { TenantDb } from "@/db";
import { PERMISSIONS, type Module } from "@/authz/catalog";
import { authorize, authorizedCodes, type MemberActor } from "@/authz/authorize";
import { AuthzError, deny } from "@/authz/errors";

/**
 * The four gates (AUTHZ.md §5), evaluated 1→2→3→4: flag kill-switch →
 * entitlement → tenant preference → permission. All AND-ed; the order
 * fixes the denial reason and lets the kill-switch dominate during an
 * incident. Only `core` skips gates 1–3 — this header said "`core` and
 * `portal`" until 2026-09-21 and was contradicted by `ALWAYS_ON` forty
 * lines below, which has held exactly `core` since it was written. A
 * plan may gate the portal even though client Contacts are unlimited
 * and free forever (decision 4).
 */

/** Versioned entitlements JSON on Tenant (DATA_MODEL.md §4). Defaults
 * are everything-on/unlimited until Stripe fills this in at Phase 7. */
export const entitlementsSchema = z.object({
  // v2 (2026-08-20, DATA_MODEL §4 / plan §3.5): adds work/time/vault.
  // The reader accepts BOTH versions — parseEntitlements falls back to
  // the everything-on default on a parse failure, so a stored version
  // the reader cannot parse would silently grant everything (fail-open);
  // never ship a writer for a version before this union accepts it.
  schemaVersion: z.union([z.literal(1), z.literal(2)]).default(2),
  planCode: z.string().default("dev-unlimited"),
  source: z.enum(["stripe", "manual_override"]).default("manual_override"),
  modules: z
    .object({
      invoicing: z.boolean().default(true),
      contracts: z.boolean().default(true),
      reports: z.boolean().default(true),
      issues: z.boolean().default(true), // deprecated alias (absorbed by `work`); kept so stored v1 JSON parses
      documentation: z.boolean().default(true),
      continuity_box: z.boolean().default(true),
      portal: z.boolean().default(true),
      work: z.boolean().default(true), // 2W
      time: z.boolean().default(true), // 2T
      vault: z.boolean().default(true), // 3V
    })
    .prefault({}),
  limits: z
    .object({
      maxMembers: z.number().nullable().default(null),
      maxClients: z.number().nullable().default(null),
      maxStorageBytes: z.number().nullable().default(null),
      maxCustomRoles: z.number().nullable().default(null),
    })
    .prefault({}),
  addons: z.object({ bankidSigning: z.boolean().default(false) }).prefault({}),
});

export type Entitlements = z.infer<typeof entitlementsSchema>;

/** Parse the Tenant.entitlements column; unknown/empty shapes resolve
 * to the everything-on default rather than crashing reads. */
export const parseEntitlements = (raw: unknown): Entitlements => {
  const result = entitlementsSchema.safeParse(raw ?? {});
  return result.success ? result.data : entitlementsSchema.parse({});
};

/** Only `core` skips gates 2–3 (AUTHZ.md §5). `portal` IS one of the
 * seven entitlement modules — plans may gate the portal even though
 * client Contacts are unlimited and free forever (decision 4). */
const ALWAYS_ON: ReadonlySet<string> = new Set(["core"]);

type EntitlementModule = keyof Entitlements["modules"];

const isEntitlementModule = (m: Module): m is EntitlementModule => !ALWAYS_ON.has(m);

const flagKey = (module: EntitlementModule): string => `module.${module}`;
const preferenceKey = (module: EntitlementModule): string => `module.${module}.enabled`;

/** Gate 1's rule over a row already read: no row is ON. */
const flagOn = (
  flag: { readonly defaultOn: boolean; readonly tenantOverrides: unknown } | null | undefined,
  tenantId: string,
): boolean => {
  if (!flag) return true;
  const overrides = (flag.tenantOverrides ?? {}) as Record<string, boolean>;
  return overrides[tenantId] ?? flag.defaultOn;
};

/** Gate 3's rule over a row already read: no row is ENABLED. */
const preferenceOn = (pref: { readonly value: unknown } | null | undefined): boolean =>
  !pref || pref.value !== false;

/** Gate 1 — engineering kill-switch. Fail OPEN on a missing flag row:
 * flags gate rollouts, they are not authorization. */
export async function flagEnabled(
  tx: TenantDb,
  key: string,
  tenantId: string,
): Promise<boolean> {
  return flagOn(await tx.featureFlag.findFirst({ where: { key } }), tenantId);
}

/** Gate 2 — commercial entitlement from the tenant row. */
export const entitled = (ents: Entitlements, module: EntitlementModule): boolean =>
  ents.modules[module];

/** Gate 3 — tenant's own module toggle; absent row means enabled. */
export async function preferenceEnabled(
  tx: TenantDb,
  tenantId: string,
  module: EntitlementModule,
): Promise<boolean> {
  return preferenceOn(
    await tx.tenantPreference.findFirst({ where: { tenantId, key: preferenceKey(module) } }),
  );
}

/**
 * Gates 1–3 for several modules at once: which of `modules` are OPEN for
 * this tenant — no kill-switch, entitled, not switched off by the tenant.
 * THREE reads whatever the number of modules, and in SEQUENCE: were the
 * tenant read to lose AGENTS.md's `Promise.all` race and come back
 * `undefined`, `parseEntitlements` would answer everything-on and open a
 * module the plan leaves out (the two lists would throw instead).
 *
 * MODULE-PRIVATE ON PURPOSE. It takes no actor and trusts whatever the
 * transaction can read — and under a CONTACT principal all three tables
 * read as empty (`portal_deny`), which every rule here answers as "open".
 * The portal has its own read for exactly that reason
 * (`src/portal/module-gates.ts`); the member plane reaches this only
 * through `accessibleCodes`, whose permission read comes back empty for a
 * contact and so closes every code first.
 */
async function openModules(
  tx: TenantDb,
  tenantId: string,
  modules: readonly EntitlementModule[],
): Promise<ReadonlySet<EntitlementModule>> {
  if (modules.length === 0) return new Set();
  const flags = await tx.featureFlag.findMany({
    where: { key: { in: modules.map(flagKey) } },
    select: { key: true, defaultOn: true, tenantOverrides: true },
  });
  const tenant = await tx.tenant.findFirst({
    where: { id: tenantId },
    select: { entitlements: true },
  });
  const preferences = await tx.tenantPreference.findMany({
    where: { tenantId, key: { in: modules.map(preferenceKey) } },
    select: { key: true, value: true },
  });
  const ents = parseEntitlements(tenant?.entitlements);
  const flagByKey = new Map(flags.map((f) => [f.key, f]));
  const preferenceByKey = new Map(preferences.map((p) => [p.key, p]));
  return new Set(
    modules.filter(
      (m) =>
        flagOn(flagByKey.get(flagKey(m)), tenantId) &&
        entitled(ents, m) &&
        preferenceOn(preferenceByKey.get(preferenceKey(m))),
    ),
  );
}

const MODULE_BY_CODE = new Map(PERMISSIONS.map((p) => [p.code, p.module]));

/**
 * The composite every call site uses (AUTHZ.md §5): one call, all four
 * gates, server-side. The permission code resolves to its module for
 * gates 1–3, then gate 4 checks the actor.
 */
export async function requireAccess(
  tx: TenantDb,
  tenantId: string,
  actor: MemberActor,
  permissionCode: string,
): Promise<void> {
  const mod = MODULE_BY_CODE.get(permissionCode);
  if (!mod) deny("FORBIDDEN", "unknown permission code");

  if (mod && isEntitlementModule(mod)) {
    if (!(await flagEnabled(tx, flagKey(mod), tenantId))) {
      deny("FEATURE_DISABLED");
    }
    const tenant = await tx.tenant.findFirst({
      where: { id: tenantId },
      select: { entitlements: true },
    });
    if (!entitled(parseEntitlements(tenant?.entitlements), mod)) {
      deny("NOT_ENTITLED");
    }
    if (!(await preferenceEnabled(tx, tenantId, mod))) {
      deny("DISABLED_BY_TENANT");
    }
  }

  await authorize(tx, actor, permissionCode);
}

/**
 * `requireAccess` as a boolean — for HIDING a module-gated surface
 * (UI.md §3.1: "module-gated items hidden, not disabled, when the
 * entitlement/preference is off").
 *
 * It exists because `isAuthorized` is the wrong tool for that job and
 * the difference is invisible at the call site: `isAuthorized` runs gate
 * 4 only, so a tab gated on it stays lit for a tenant whose plan does
 * not include the module, and the page behind it then throws
 * NOT_ENTITLED into an error boundary. Measured on the Portal tab
 * (2026-09-21), which is where this helper was written.
 *
 * NOT FOR ✦ CODES. `MFA_REQUIRED` is an `AuthzError` too, so a step-up
 * code asked about here reads as "not held" and its surface would
 * disappear instead of prompting for a factor. Gate a ✦ surface on the
 * permission and let the action step up.
 */
export async function hasAccess(
  tx: TenantDb,
  tenantId: string,
  actor: MemberActor,
  permissionCode: string,
): Promise<boolean> {
  try {
    await requireAccess(tx, tenantId, actor, permissionCode);
    return true;
  } catch (e) {
    if (e instanceof AuthzError) return false;
    throw e;
  }
}

/**
 * `hasAccess` for many codes at once — all four gates, from ONE read of
 * the member's permissions (`authorizedCodes`) and the three of
 * `openModules`, in sequence (none of the three when no code it holds
 * belongs to a gated module). For a surface that HIDES whatever the
 * tenant has switched off: the member shell's rail (UI.md §3.1), where
 * `authorizedCodes` alone answered the permission gate and left Time,
 * Files and the `C` key lit over pages that then refused. The answer per
 * code is exactly `hasAccess`'s (`access.test.ts` holds them to it), so
 * the same caveat applies: NOT FOR ✦ CODES.
 */
export async function accessibleCodes(
  tx: TenantDb,
  tenantId: string,
  actor: MemberActor,
  codes: readonly string[],
): Promise<ReadonlySet<string>> {
  const allowed = await authorizedCodes(tx, actor, codes);
  const moduleOf = (code: string): Module | undefined => MODULE_BY_CODE.get(code);
  const gated = new Set<EntitlementModule>();
  for (const code of allowed) {
    const mod = moduleOf(code);
    if (mod && isEntitlementModule(mod)) gated.add(mod);
  }
  const open = await openModules(tx, tenantId, [...gated]);
  return new Set(
    [...allowed].filter((code) => {
      const mod = moduleOf(code);
      return mod !== undefined && (!isEntitlementModule(mod) || open.has(mod));
    }),
  );
}

/**
 * Creation-time limit check (AUTHZ.md §5): block creation past the
 * limit, never delete or hide existing data (downgrade = read-only
 * grandfathering).
 */
export function enforceLimit(
  ents: Entitlements,
  limit: keyof Entitlements["limits"],
  currentCount: number,
): void {
  const max = ents.limits[limit];
  if (max !== null && currentCount >= max) {
    deny("NOT_ENTITLED", `${limit} reached (${currentCount}/${max})`);
  }
}
