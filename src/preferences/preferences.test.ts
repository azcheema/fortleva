import { describe, expect, it } from "vitest";

import { entitlementsSchema } from "@/entitlements/resolver";

import {
  materializePreferences,
  moduleKey,
  PREF_KEYS,
  TIMEZONES,
  TOGGLEABLE_MODULES,
} from "./config";

describe("tenant preferences (pure)", () => {
  it("defaults: sv, Europe/Stockholm, Monday, ISO weeks, h m, SEK, all modules on", () => {
    const p = materializePreferences("sv", []);
    expect(p).toMatchObject({
      defaultLocale: "sv",
      timezone: "Europe/Stockholm",
      weekStart: "MONDAY",
      showIsoWeek: true,
      durationStyle: "hm",
      currencyDefault: "SEK",
    });
    for (const m of TOGGLEABLE_MODULES) expect(p.modules[m]).toBe(true);
  });

  it("reads stored rows and ignores unknown values", () => {
    const p = materializePreferences("en", [
      { key: PREF_KEYS.timezone, value: "America/New_York" },
      { key: PREF_KEYS.weekStart, value: "SUNDAY" },
      { key: PREF_KEYS.showIsoWeek, value: false },
      { key: PREF_KEYS.durationStyle, value: "decimal" },
      { key: PREF_KEYS.currencyDefault, value: "XXX" },
      { key: moduleKey("portal"), value: false },
      { key: moduleKey("invoicing"), value: "nope" },
    ]);
    expect(p.defaultLocale).toBe("en");
    expect(p.timezone).toBe("America/New_York");
    expect(p.weekStart).toBe("SUNDAY");
    expect(p.showIsoWeek).toBe(false);
    expect(p.durationStyle).toBe("decimal");
    expect(p.currencyDefault).toBe("SEK");
    expect(p.modules.portal).toBe(false);
    expect(p.modules.invoicing).toBe(true);
  });

  it("module toggles are exactly the entitlement modules, keyed the way gate 3 reads them", () => {
    expect([...TOGGLEABLE_MODULES].sort()).toEqual(
      Object.keys(entitlementsSchema.parse({}).modules).sort(),
    );
    expect(moduleKey("portal")).toBe("module.portal.enabled");
  });

  it("the curated timezone list is valid IANA and includes Stockholm + common US zones", () => {
    for (const tz of TIMEZONES) {
      expect(() => new Intl.DateTimeFormat("en", { timeZone: tz })).not.toThrow();
    }
    for (const tz of ["Europe/Stockholm", "America/New_York", "America/Chicago", "America/Los_Angeles"]) {
      expect(TIMEZONES).toContain(tz);
    }
  });
});
