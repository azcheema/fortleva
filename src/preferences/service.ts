import { z } from "zod";

import { record } from "@/audit/record";
import type { MemberActor } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { LOCALES } from "@/i18n/config";
import { fail } from "@/lib/domain-error";

import {
  CURRENCIES,
  DURATION_STYLES,
  FINANCE_PREF_KEYS,
  materializePreferences,
  moduleKey,
  PREF_KEYS,
  TIME_HOURS_MAX,
  TIME_HOURS_MIN,
  TIME_PREF_KEYS,
  TIMEZONES,
  TOGGLEABLE_MODULES,
  WEEK_STARTS,
  type TenantPreferences,
  type ToggleableModule,
} from "./config";

export * from "./config";

/**
 * Tenant preferences (DATA_MODEL.md §4 TenantPreference; PLAN.md Phase 2
 * "/settings/preferences"). Two storage shapes, one service:
 *   - Tenant.defaultLocale is a Tenant COLUMN (locale resolution reads it
 *     per request) — written on the tenant row;
 *   - everything else is a TenantPreference row keyed `ui.*` / `finance.*`
 *     / `module.<key>.enabled` (the key AUTHZ gate 3 reads, see
 *     src/entitlements/resolver.ts preferenceEnabled()).
 * Gates: settings:view reads, settings:edit writes, settings:manage_modules
 * (✦) flips module toggles. Every write audits preference.changed {key}
 * — keys only, never values (none are secrets, but the log stays small
 * and uniform).
 */

export type PreferenceCtx = {
  readonly tenantId: string;
  /** From requireTenantContext() — never from form params. */
  readonly actor: MemberActor;
};

const memberPrincipal = (ctx: PreferenceCtx) =>
  ({ type: "member", id: ctx.actor.memberId }) as const;

/** Read inside an existing tenant tx (no permission gate — used by request-time formatting). */
export async function readPreferences(tx: TenantDb, tenantId: string): Promise<TenantPreferences> {
  const [tenant, rows] = await Promise.all([
    tx.tenant.findFirst({ where: { id: tenantId }, select: { defaultLocale: true } }),
    tx.tenantPreference.findMany({ select: { key: true, value: true } }),
  ]);
  return materializePreferences(tenant?.defaultLocale ?? "sv", rows);
}

/** settings:view — the preferences page read. */
export async function getPreferences(ctx: PreferenceCtx): Promise<TenantPreferences> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:view");
    return readPreferences(tx, ctx.tenantId);
  });
}

const patchSchema = z
  .object({
    defaultLocale: z.enum(LOCALES),
    timezone: z.enum(TIMEZONES),
    weekStart: z.enum(WEEK_STARTS),
    showIsoWeek: z.boolean(),
    durationStyle: z.enum(DURATION_STYLES),
    currencyDefault: z.enum(CURRENCIES),
    // 2T (numbers are whole hours within the form's bounds)
    time: z
      .object({
        autoStopHours: z.number().int().min(TIME_HOURS_MIN).max(TIME_HOURS_MAX),
        nudgeHours: z.number().int().min(TIME_HOURS_MIN).max(TIME_HOURS_MAX),
        allowOverlap: z.boolean(),
        allowEntriesWithoutItem: z.boolean(),
        allowAdhocEntries: z.boolean(),
        shiftsEnabled: z.boolean(),
        shiftAutoStopHours: z.number().int().min(TIME_HOURS_MIN).max(TIME_HOURS_MAX),
      })
      .partial(),
    finance: z.object({ costRatesEnabled: z.boolean() }).partial(),
  })
  .partial();

export type PreferencePatch = z.infer<typeof patchSchema>;

async function upsertPreference(
  tx: TenantDb,
  ctx: PreferenceCtx,
  key: string,
  value: string | boolean | number,
): Promise<boolean> {
  const existing = await tx.tenantPreference.findFirst({ where: { key }, select: { id: true, value: true } });
  if (existing && existing.value === value) return false;
  if (existing) {
    await tx.tenantPreference.update({
      where: { id: existing.id },
      data: { value, updatedByMemberId: ctx.actor.memberId },
    });
  } else {
    await tx.tenantPreference.create({
      data: { tenantId: ctx.tenantId, key, value, updatedByMemberId: ctx.actor.memberId },
    });
  }
  await record(tx, {
    action: "preference.changed",
    targetType: "TenantPreference",
    targetId: key,
    metadata: { key },
  });
  return true;
}

/**
 * settings:edit — write the general preferences. Only the keys present
 * in the patch are written; unchanged values write nothing (no noise in
 * the audit log). Returns the keys that changed.
 */
export async function updatePreferences(
  ctx: PreferenceCtx,
  raw: PreferencePatch,
): Promise<string[]> {
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) fail("INVALID_INPUT");
  const patch = parsed.data!;
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:edit");
    const changed: string[] = [];
    if (patch.defaultLocale !== undefined) {
      const t = await tx.tenant.findFirst({
        where: { id: ctx.tenantId },
        select: { defaultLocale: true },
      });
      if (t && t.defaultLocale !== patch.defaultLocale) {
        await tx.tenant.update({
          where: { id: ctx.tenantId },
          data: { defaultLocale: patch.defaultLocale },
        });
        await record(tx, {
          action: "preference.changed",
          targetType: "Tenant",
          targetId: ctx.tenantId,
          metadata: { key: "locale.default" },
        });
        changed.push("locale.default");
      }
    }
    for (const [field, key] of Object.entries(PREF_KEYS) as [keyof typeof PREF_KEYS, string][]) {
      const value = patch[field];
      if (value === undefined) continue;
      if (await upsertPreference(tx, ctx, key, value)) changed.push(key);
    }
    for (const [field, key] of Object.entries(TIME_PREF_KEYS) as [keyof typeof TIME_PREF_KEYS, string][]) {
      const value = patch.time?.[field];
      if (value === undefined) continue;
      if (await upsertPreference(tx, ctx, key, value)) changed.push(key);
    }
    for (const [field, key] of Object.entries(FINANCE_PREF_KEYS) as [keyof typeof FINANCE_PREF_KEYS, string][]) {
      const value = patch.finance?.[field];
      if (value === undefined) continue;
      if (await upsertPreference(tx, ctx, key, value)) changed.push(key);
    }
    return changed;
  });
}

/**
 * settings:manage_modules (✦) — the tenant's own kill-switch for a
 * module (AUTHZ.md §5 gate 3). Entitlement (gate 2) is not touched:
 * a module the plan lacks stays unavailable however this is set.
 */
export async function setModuleEnabled(
  ctx: PreferenceCtx,
  module: ToggleableModule,
  enabled: boolean,
): Promise<void> {
  if (!TOGGLEABLE_MODULES.includes(module)) fail("INVALID_INPUT");
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:manage_modules");
    await upsertPreference(tx, ctx, moduleKey(module), enabled);
  });
}
