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
};

export const PREF_KEYS = {
  timezone: "ui.timezone",
  weekStart: "ui.weekStart",
  showIsoWeek: "ui.showIsoWeek",
  durationStyle: "ui.durationStyle",
  currencyDefault: "finance.currencyDefault",
} as const;

const DEFAULTS: Omit<TenantPreferences, "modules" | "defaultLocale"> = {
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
  };
}
