import { entitlementsSchema, type Entitlements } from "@/entitlements/resolver";
import { LOCALES, type AppLocale } from "@/i18n/config";

/**
 * Preference vocabulary + pure materialisation (no database import so
 * client components and unit tests can use it). The service half is
 * ./service.ts.
 */

export const WEEK_STARTS = ["MONDAY", "SUNDAY", "SATURDAY"] as const;
export const DURATION_STYLES = ["hm", "clock", "decimal"] as const;
export const CURRENCIES = ["SEK", "EUR", "USD", "GBP", "NOK", "DKK"] as const;

/**
 * Curated IANA zone list (UI.md §8): the ones an EU agency and its
 * US-facing colleagues need. Not exhaustive by design — a free-text
 * override is a later request; anything here is accepted by Intl.
 */
export const TIMEZONES = [
  "Europe/Stockholm",
  "Europe/Oslo",
  "Europe/Copenhagen",
  "Europe/Helsinki",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Paris",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Warsaw",
  "Europe/Dublin",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Athens",
  "Europe/Kyiv",
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;

export type Timezone = (typeof TIMEZONES)[number];
export const isTimezone = (v: unknown): v is Timezone =>
  typeof v === "string" && (TIMEZONES as readonly string[]).includes(v);

/** Entitlement modules a tenant may switch off for itself (gate 3). */
export const TOGGLEABLE_MODULES = Object.keys(
  entitlementsSchema.parse({}).modules,
) as readonly ToggleableModule[];
export type ToggleableModule = keyof Entitlements["modules"];

export const moduleKey = (m: ToggleableModule): string => `module.${m}.enabled`;

/** The typed view every page reads; defaults are the DATA_MODEL defaults. */
export type TenantPreferences = {
  defaultLocale: AppLocale;
  timezone: Timezone;
  weekStart: (typeof WEEK_STARTS)[number];
  showIsoWeek: boolean;
  durationStyle: (typeof DURATION_STYLES)[number];
  currencyDefault: (typeof CURRENCIES)[number];
  /** Tenant's own toggle per module (absent row ⇒ true). */
  modules: Record<ToggleableModule, boolean>;
  time: TimePreferences;
  finance: FinancePreferences;
  vault: VaultPreferences;
};

export const PREF_KEYS = {
  timezone: "ui.timezone",
  weekStart: "ui.weekStart",
  showIsoWeek: "ui.showIsoWeek",
  durationStyle: "ui.durationStyle",
  currencyDefault: "finance.currencyDefault",
} as const;

/** Time module (2T — PLAN.md Phase 2T "Preferences"; DATA_MODEL.md §6.15). */
export type TimePreferences = {
  /** Running entry auto-stops at this bound (hours); lazy + cron, deterministic. */
  autoStopHours: number;
  /** In-app nudge after this many hours running. */
  nudgeHours: number;
  /** D6 amendment 2026-08-20: allow + flag by default; blocking is the tenant opt-in. */
  allowOverlap: boolean;
  /** Project-level entries (no task) with a required note. */
  allowEntriesWithoutItem: boolean;
  /** D2 instant tasks: project-less, description-only, forced non-billable. */
  allowAdhocEntries: boolean;
  /** D1 shifts: clock-in/out + breaks. */
  shiftsEnabled: boolean;
  /** Open shift auto-stops at this bound (hours). */
  shiftAutoStopHours: number;
};
export const TIME_PREF_KEYS: Readonly<Record<keyof TimePreferences, string>> = {
  autoStopHours: "time.autoStopHours",
  nudgeHours: "time.nudgeHours",
  allowOverlap: "time.allowOverlap",
  allowEntriesWithoutItem: "time.allowEntriesWithoutItem",
  allowAdhocEntries: "time.allowAdhocEntries",
  shiftsEnabled: "time.shiftsEnabled",
  shiftAutoStopHours: "time.shiftAutoStopHours",
};
export const TIME_DEFAULTS: TimePreferences = {
  autoStopHours: 12,
  nudgeHours: 8,
  allowOverlap: true,
  allowEntriesWithoutItem: true,
  allowAdhocEntries: true,
  shiftsEnabled: true,
  shiftAutoStopHours: 14,
};
/** Hour bounds the preference form and the parser both enforce. */
export const TIME_HOURS_MIN = 1;
export const TIME_HOURS_MAX = 48;

export type FinancePreferences = {
  /** The optional encrypted internal-cost layer (CEO/finance ✦). */
  costRatesEnabled: boolean;
};
export const FINANCE_PREF_KEYS: Readonly<Record<keyof FinancePreferences, string>> = {
  costRatesEnabled: "finance.costRates.enabled",
};
export const FINANCE_DEFAULTS: FinancePreferences = { costRatesEnabled: false };

/**
 * Vault (Phase 3V — AUTHZ.md §5's preference table, plan §3.4). The other
 * two `vault.*` keys land with the slices that build their surfaces.
 */
export type VaultPreferences = {
  /** A Reveal, Copy or TOTP code needs a second factor this recent (minutes). */
  stepUpMinutes: number;
  /** Reveals + copies + codes one member may take per rolling hour. */
  revealBudgetPerHour: number;
  /** The longest a share link may live (hours; slice 90). The database caps it at 7 days whatever this says. */
  shareLinkMaxTtlHours: number;
  /** Share links on or off for the whole workspace (slice 90; CP4: on). */
  allowExternalShareLinks: boolean;
  /**
   * When share links were last switched OFF (slice 90, the security
   * review's medium): every link made before this moment is dead for good,
   * so switching links back on never revives one that was live when they
   * were stopped. Written only by the preference service, on the true →
   * false change, from the database's clock; never part of a patch.
   */
  shareLinksStoppedAt: Date | null;
  /**
   * Logins shown to clients on or off for the whole workspace (slice 91;
   * C52 (d): default OFF). Switching it ON is `settings:manage_modules` ✦;
   * switching it OFF un-marks every shown login for good (C59 (b)). The
   * database reads this key itself (`vault_portal_credentials_on()`, the
   * `portal_vault_switch` policy): a contact sees no login while it is
   * anything but `true`.
   */
  allowPortalCredentials: boolean;
  /**
   * How long a client's ask to open their SEALED logins waits for an answer
   * before the client may confirm it themselves (slice 93; founder decision
   * C52 (g): 7 days by default, then the 48-hour notice — "7 + 2"; an agency
   * may lengthen it, a Swedish summer closure being longer than nine days).
   * Frozen on each ask when it is made, so changing it never moves an ask
   * already waiting.
   */
  sealedWaitDays: number;
  /**
   * Clients may hand logins over through their portal (slice 96; founder
   * decision C64; PLAN Phase 3V: default ON). Off, the portal offers no
   * "Send us a login" and the broker refuses — a pause on intake, never a
   * disclosure control: what was sent stays in the vault, for the team only.
   * `settings:edit` both ways (AUTHZ.md §5: a behavioural key).
   */
  allowContactSubmission: boolean;
};
export const VAULT_PREF_KEYS: Readonly<Record<keyof VaultPreferences, string>> = {
  stepUpMinutes: "vault.stepUpMinutes",
  revealBudgetPerHour: "vault.revealBudgetPerHour",
  shareLinkMaxTtlHours: "vault.shareLinkMaxTtlHours",
  allowExternalShareLinks: "vault.allowExternalShareLinks",
  shareLinksStoppedAt: "vault.shareLinksStoppedAt",
  // Spelled out in migration 20261005120000 too (the policy's function).
  allowPortalCredentials: "vault.allowPortalCredentials",
  sealedWaitDays: "vault.sealedWaitDays",
  allowContactSubmission: "vault.allowContactSubmission",
};
export const VAULT_DEFAULTS: VaultPreferences = {
  stepUpMinutes: 10,
  revealBudgetPerHour: 30,
  shareLinkMaxTtlHours: 168,
  allowExternalShareLinks: true,
  shareLinksStoppedAt: null,
  allowPortalCredentials: false,
  sealedWaitDays: 7,
  allowContactSubmission: true,
};
/**
 * Bounds the parser enforces (a stored value outside them falls back to
 * the default). The step-up window can only TIGHTEN the ✦ window every
 * credential:reveal check already applies (`STEP_UP_WINDOW_MINUTES`, 15),
 * so a longer one would be a setting that silently did nothing; the
 * budget is capped so no tenant setting turns it off.
 */
export const VAULT_STEP_UP_MINUTES_RANGE = { min: 1, max: 15 } as const;
export const VAULT_REVEAL_BUDGET_RANGE = { min: 1, max: 100 } as const;
/** A sealed ask's wait (days): never shorter than C52 (g)'s seven, at most sixty — the database's CHECK says the same. */
export const VAULT_SEALED_WAIT_DAYS_RANGE = { min: 7, max: 60 } as const;
/**
 * THE SHARE-LINK SWITCH'S ADVISORY LOCK KEY (slice 90's fix-pass review).
 * Switching links OFF takes it EXCLUSIVELY and stamps
 * `shareLinksStoppedAt` after it; making a link takes it SHARED before it
 * reads the switch. So a link is either made before the switch-off begins
 * stamping (and is stopped by the stamp, which is later than its birth),
 * or waits for the switch-off to commit and is then refused — links are
 * off, or, if they were switched on again meanwhile, its transaction began
 * before the stamp (`createShareLink` checks) — never a link born while
 * the switch was going off that escapes the stamp. The exclusive wait has
 * no `lock_timeout`: switching is a rare owner act, and links being made
 * meanwhile wait out their own bounded attempts and answer VAULT_BUSY. One
 * key per tenant; the single-argument 64-bit space every
 * `pg_advisory_xact_lock(hashtext(…))` in the product shares
 * (`src/modules/vault/budget.ts` says why that is acceptable).
 */
export const shareSwitchLockKey = (tenantId: string): string => `vault_share_switch:${tenantId}`;

/**
 * THE CLIENT-LOGINS SWITCH'S ADVISORY LOCK KEY (slice 91), the share
 * switch's protocol for C59 (b): switching client logins OFF takes it
 * EXCLUSIVELY and then un-marks every shown login; showing a login takes it
 * SHARED before it reads the switch. So a login is shown wholly before a
 * switch-off begins (and is un-marked by it) or after it commits (and is
 * then refused, the switch being off) — never shown in between and left
 * behind for the next switch-on to reveal. Same key space and the same
 * no-`lock_timeout` stance on the exclusive side as `shareSwitchLockKey`.
 */
export const portalCredentialsSwitchLockKey = (tenantId: string): string => `vault_portal_switch:${tenantId}`;

/** A share link lives an hour at least and seven days at most (CP4; the table's CHECK says 7 days too). */
export const VAULT_SHARE_TTL_HOURS_RANGE = { min: 1, max: 168 } as const;

const DEFAULTS: Omit<TenantPreferences, "modules" | "defaultLocale" | "time" | "finance" | "vault"> = {
  timezone: "Europe/Stockholm",
  weekStart: "MONDAY",
  showIsoWeek: true,
  durationStyle: "hm",
  currencyDefault: "SEK",
};

/** Parse the stored TenantPreference rows into the typed view (unknown values fall back). */
export function materializePreferences(
  defaultLocale: string,
  rows: readonly { key: string; value: unknown }[],
): TenantPreferences {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const pick = <T extends string>(key: string, allowed: readonly T[], dflt: T): T => {
    const v = map.get(key);
    return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
  };
  const modules = Object.fromEntries(
    TOGGLEABLE_MODULES.map((m) => [m, map.get(moduleKey(m)) !== false]),
  ) as Record<ToggleableModule, boolean>;
  const iso = map.get(PREF_KEYS.showIsoWeek);
  const bool = (key: string, dflt: boolean): boolean => {
    const v = map.get(key);
    return typeof v === "boolean" ? v : dflt;
  };
  const intIn = (key: string, range: { min: number; max: number }, dflt: number): number => {
    const v = map.get(key);
    return typeof v === "number" && Number.isInteger(v) && v >= range.min && v <= range.max ? v : dflt;
  };
  /** An ISO instant, or null for anything else. */
  const instant = (key: string): Date | null => {
    const v = map.get(key);
    if (typeof v !== "string") return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const hours = (key: string, dflt: number): number => {
    const v = map.get(key);
    return typeof v === "number" && Number.isFinite(v) && v >= TIME_HOURS_MIN && v <= TIME_HOURS_MAX ? v : dflt;
  };
  return {
    defaultLocale: (LOCALES as readonly string[]).includes(defaultLocale)
      ? (defaultLocale as AppLocale)
      : "sv",
    timezone: pick(PREF_KEYS.timezone, TIMEZONES, DEFAULTS.timezone),
    weekStart: pick(PREF_KEYS.weekStart, WEEK_STARTS, DEFAULTS.weekStart),
    showIsoWeek: typeof iso === "boolean" ? iso : DEFAULTS.showIsoWeek,
    durationStyle: pick(PREF_KEYS.durationStyle, DURATION_STYLES, DEFAULTS.durationStyle),
    currencyDefault: pick(PREF_KEYS.currencyDefault, CURRENCIES, DEFAULTS.currencyDefault),
    modules,
    time: {
      autoStopHours: hours(TIME_PREF_KEYS.autoStopHours, TIME_DEFAULTS.autoStopHours),
      nudgeHours: hours(TIME_PREF_KEYS.nudgeHours, TIME_DEFAULTS.nudgeHours),
      allowOverlap: bool(TIME_PREF_KEYS.allowOverlap, TIME_DEFAULTS.allowOverlap),
      allowEntriesWithoutItem: bool(TIME_PREF_KEYS.allowEntriesWithoutItem, TIME_DEFAULTS.allowEntriesWithoutItem),
      allowAdhocEntries: bool(TIME_PREF_KEYS.allowAdhocEntries, TIME_DEFAULTS.allowAdhocEntries),
      shiftsEnabled: bool(TIME_PREF_KEYS.shiftsEnabled, TIME_DEFAULTS.shiftsEnabled),
      shiftAutoStopHours: hours(TIME_PREF_KEYS.shiftAutoStopHours, TIME_DEFAULTS.shiftAutoStopHours),
    },
    finance: { costRatesEnabled: bool(FINANCE_PREF_KEYS.costRatesEnabled, FINANCE_DEFAULTS.costRatesEnabled) },
    vault: {
      stepUpMinutes: intIn(VAULT_PREF_KEYS.stepUpMinutes, VAULT_STEP_UP_MINUTES_RANGE, VAULT_DEFAULTS.stepUpMinutes),
      revealBudgetPerHour: intIn(
        VAULT_PREF_KEYS.revealBudgetPerHour,
        VAULT_REVEAL_BUDGET_RANGE,
        VAULT_DEFAULTS.revealBudgetPerHour,
      ),
      shareLinkMaxTtlHours: intIn(
        VAULT_PREF_KEYS.shareLinkMaxTtlHours,
        VAULT_SHARE_TTL_HOURS_RANGE,
        VAULT_DEFAULTS.shareLinkMaxTtlHours,
      ),
      allowExternalShareLinks: bool(VAULT_PREF_KEYS.allowExternalShareLinks, VAULT_DEFAULTS.allowExternalShareLinks),
      shareLinksStoppedAt: instant(VAULT_PREF_KEYS.shareLinksStoppedAt),
      allowPortalCredentials: bool(VAULT_PREF_KEYS.allowPortalCredentials, VAULT_DEFAULTS.allowPortalCredentials),
      sealedWaitDays: intIn(VAULT_PREF_KEYS.sealedWaitDays, VAULT_SEALED_WAIT_DAYS_RANGE, VAULT_DEFAULTS.sealedWaitDays),
      allowContactSubmission: bool(VAULT_PREF_KEYS.allowContactSubmission, VAULT_DEFAULTS.allowContactSubmission),
    },
  };
}
