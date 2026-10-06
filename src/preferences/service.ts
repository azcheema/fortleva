import { z } from "zod";

import { record } from "@/audit/record";
import { requireRecentMfa, STEP_UP_WINDOW_MINUTES, type MemberActor } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { LOCALES } from "@/i18n/config";
import { fail } from "@/lib/domain-error";
import { restampSearchLang } from "@/search/rebuild";

import {
  CURRENCIES,
  DURATION_STYLES,
  FINANCE_PREF_KEYS,
  materializePreferences,
  moduleKey,
  portalCredentialsSwitchLockKey,
  PREF_KEYS,
  TIME_HOURS_MAX,
  TIME_HOURS_MIN,
  TIME_PREF_KEYS,
  TIMEZONES,
  TOGGLEABLE_MODULES,
  VAULT_PREF_KEYS,
  VAULT_REVEAL_BUDGET_RANGE,
  VAULT_SEALED_WAIT_DAYS_RANGE,
  VAULT_SHARE_TTL_HOURS_RANGE,
  shareSwitchLockKey,
  VAULT_STEP_UP_MINUTES_RANGE,
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
 * and uniform). The one write with a second effect is the locale: it
 * also restamps the search index (search/rebuild.ts), whose own event
 * carries the two locale keys and a row count — enum values, still no
 * text.
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
  // In SEQUENCE, never a `Promise.all`: both reads share the caller's one
  // transaction connection, which Prisma over the `pg` adapter does not
  // serialise, so a losing leg can resolve `undefined` (AGENTS.md's
  // standing trap). Here that threw on `rows.map` inside whatever
  // transaction called it — since Phase 3V, the vault's reveal, which
  // reads its step-up window and budget through this (both reviews).
  const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { defaultLocale: true } });
  const rows = await tx.tenantPreference.findMany({ select: { key: true, value: true } });
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
    // 3V (whole numbers within the bounds the reader also enforces)
    vault: z
      .object({
        stepUpMinutes: z.number().int().min(VAULT_STEP_UP_MINUTES_RANGE.min).max(VAULT_STEP_UP_MINUTES_RANGE.max),
        revealBudgetPerHour: z.number().int().min(VAULT_REVEAL_BUDGET_RANGE.min).max(VAULT_REVEAL_BUDGET_RANGE.max),
        shareLinkMaxTtlHours: z
          .number()
          .int()
          .min(VAULT_SHARE_TTL_HOURS_RANGE.min)
          .max(VAULT_SHARE_TTL_HOURS_RANGE.max),
        allowExternalShareLinks: z.boolean(),
        allowPortalCredentials: z.boolean(),
        sealedWaitDays: z
          .number()
          .int()
          .min(VAULT_SEALED_WAIT_DAYS_RANGE.min)
          .max(VAULT_SEALED_WAIT_DAYS_RANGE.max),
      })
      .partial(),
  })
  .partial();

export type PreferencePatch = z.infer<typeof patchSchema>;

/** The vault keys a patch may write; `shareLinksStoppedAt` is this service's own stamp. */
const PATCHABLE_VAULT_KEYS = [
  "stepUpMinutes",
  "revealBudgetPerHour",
  "shareLinkMaxTtlHours",
  "allowExternalShareLinks",
  "allowPortalCredentials",
  "sealedWaitDays",
] as const satisfies readonly (keyof NonNullable<PreferencePatch["vault"]>)[];

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
 * SWITCHING CLIENT LOGINS OFF HIDES THEM FOR GOOD (Phase 3V slice 91;
 * founder decision C59 (b)) — the one write this service makes into the
 * vault's tables, kept here rather than in `@/modules/vault`, whose index
 * already imports this service (a cycle) and whose internals nothing
 * outside it may import (`vault-boundary.test.ts`). It touches only
 * `credential_item.visibility`, never a secret.
 *
 * Every login marked CLIENT_VISIBLE goes back to INTERNAL in the
 * transaction that switches `vault.allowPortalCredentials` off, after it
 * took the switch's lock EXCLUSIVELY (`portalCredentialsSwitchLockKey`):
 * showing a login (`src/modules/vault/visibility.ts`) takes it SHARED
 * before reading the switch, so no login is shown while this runs and
 * survives it. Switching on again therefore shows nothing until a member
 * marks each login again — the share links' rule (a switch-off is a stop,
 * never a pause). The vault MODULE switched off, by the tenant or the plan,
 * stays a pause: nothing here runs for it, and the database's
 * `portal_vault_switch` policy and the portal's module gates keep contacts
 * out meanwhile.
 *
 * Deleted (binned) logins are un-marked too, so a restore can never bring
 * one back shown. Each login writes its own `credential.visibility_changed`
 * row (`cause: "switch_off"`), so its own trail says why. Tenant-wide by
 * design — the switch is the workspace's, not one member's scope.
 */
async function hideEveryShownLogin(tx: TenantDb, ctx: PreferenceCtx): Promise<void> {
  // The shown logins locked first, in id order — the order a member's
  // removal locks logins in (the vault's offboarding flags, slice 95): an
  // unordered update crossing it on two logins would deadlock one of the two.
  await tx.$queryRaw`
    SELECT id FROM credential_item
    WHERE tenant_id = ${ctx.tenantId} AND visibility = 'CLIENT_VISIBLE'
    ORDER BY id
    FOR NO KEY UPDATE`;
  // ONE statement that changes and names the rows it changed, so a login
  // hidden or deleted by someone else in between is not recorded as this
  // sweep's (the fix-pass review).
  const hidden = await tx.credentialItem.updateManyAndReturn({
    where: { tenantId: ctx.tenantId, visibility: "CLIENT_VISIBLE" },
    data: { visibility: "INTERNAL", updatedByMemberId: ctx.actor.memberId },
    select: { id: true },
  });
  // In turn, never a `Promise.all` on one interactive transaction (AGENTS.md).
  for (const { id } of hidden) {
    await record(tx, {
      action: "credential.visibility_changed",
      targetType: "CredentialItem",
      targetId: id,
      metadata: { visibility: "INTERNAL", cause: "switch_off" },
    });
  }
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
    // The vault's two keys decide how easily its secrets can be read
    // (the re-check window, the hourly budget): a stolen admin session
    // must not be able to loosen them without the second factor
    // (security review, 2026-10-01). Any change to them asks for one —
    // the ✦ window every step-up code uses.
    if (patch.vault !== undefined && Object.keys(patch.vault).length > 0) {
      await requireRecentMfa(ctx.actor, STEP_UP_WINDOW_MINUTES);
    }
    // Turning share links ON is a privilege decision, not a settings tweak
    // (AUTHZ.md §5: `vault.allowExternalShareLinks` sits under
    // `settings:manage_modules` ✦ as well). Turning them OFF is the
    // incident's direction and stays with `settings:edit`, so whoever is
    // looking after the settings can stop every link at once (the fix-pass
    // review: gating both ways kept an admin from pulling the plug).
    if (patch.vault?.allowExternalShareLinks === true) {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:manage_modules");
    }
    // Any change of the switch serialises with every link being made
    // (`shareSwitchLockKey`'s note): taken here, before the switch is read.
    if (patch.vault?.allowExternalShareLinks !== undefined) {
      // `$executeRaw`: the lock returns `void`, which `$queryRaw` cannot read.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${shareSwitchLockKey(ctx.tenantId)}))`;
    }
    // Showing logins to clients (slice 91, AUTHZ.md §5): ON is a privilege
    // decision like share links'; OFF stays with `settings:edit`. Any change
    // serialises with every login being shown
    // (`portalCredentialsSwitchLockKey`'s note) — taken before the switch is
    // read, and after the share switch's lock: one fixed order.
    if (patch.vault?.allowPortalCredentials === true) {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:manage_modules");
    }
    if (patch.vault?.allowPortalCredentials !== undefined) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${portalCredentialsSwitchLockKey(ctx.tenantId)}))`;
    }
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
        // The search index is stemmed per row in the language it was fed
        // in. Restamped HERE, in the same transaction, so a workspace that
        // switches language is not left searching yesterday's rows with
        // today's stemmer (search/rebuild.ts carries the cost argument).
        await restampSearchLang(tx, {
          tenantId: ctx.tenantId,
          from: t.defaultLocale,
          to: patch.defaultLocale,
        });
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
    for (const field of PATCHABLE_VAULT_KEYS) {
      const key = VAULT_PREF_KEYS[field];
      const value = patch.vault?.[field];
      if (value === undefined) continue;
      // SWITCHING SHARE LINKS OFF STOPS EVERY LINK FOR GOOD (slice 90, the
      // security review's medium). The switch is read on every visit, so
      // without this an agency that stopped links in an incident and turned
      // them on again a day later would revive every one still in date. The
      // moment is the DATABASE's, the clock the links' `created_at` is on —
      // and the WALL clock read after the switch's lock (`clock_timestamp`,
      // not `now()`, which is this transaction's start): every link that
      // could have been made before the lock was ours has a `created_at`
      // before it (the fix-pass review).
      if (field === "allowExternalShareLinks" && value === false) {
        if ((await readPreferences(tx, ctx.tenantId)).vault.allowExternalShareLinks) {
          const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
          const stoppedAt = rows[0]?.now;
          if (!stoppedAt) throw new Error("preferences: the database returned no clock");
          await upsertPreference(tx, ctx, VAULT_PREF_KEYS.shareLinksStoppedAt, stoppedAt.toISOString());
          changed.push(VAULT_PREF_KEYS.shareLinksStoppedAt);
        }
      }
      // SWITCHING CLIENT LOGINS OFF HIDES EVERY SHOWN LOGIN FOR GOOD
      // (slice 91, founder decision C59 (b)): on again shows nothing until
      // each is marked again. Under the switch's exclusive lock (above).
      // On EVERY "off", not only a change of it: a shown login left behind
      // while the switch was already off (nothing writes one, but nothing
      // could tell) goes too, and with none the sweep writes nothing.
      if (field === "allowPortalCredentials" && value === false) {
        await hideEveryShownLogin(tx, ctx);
      }
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
