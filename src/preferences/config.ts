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

const DEFAULTS: Omit<TenantPreferences, "modules" | "defaultLocale" | "time" | "finance"> = {
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
  };
}
