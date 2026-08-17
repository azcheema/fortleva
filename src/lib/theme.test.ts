import { describe, expect, it } from "vitest";

import {
  THEME_COOKIE,
  isThemePreference,
  resolveThemePreference,
  themeFromCookieString,
  themeOnMount,
  type ThemePreference,
} from "./theme";

/**
 * The theme-persistence rule, pinned. The regression this guards
 * against: a ThemeToggle mounted after the page (the one in the user
 * menu is re-created every time the menu opens) re-applied its own
 * default — "system" — over an explicit Light, so on a dark machine the
 * app snapped back to dark. A control's default must NEVER outrank a
 * stored choice; that is exactly what themeOnMount() encodes.
 */

describe("resolveThemePreference", () => {
  it("accepts the three vocabulary values and nothing else", () => {
    for (const value of ["system", "light", "dark"] satisfies ThemePreference[]) {
      expect(resolveThemePreference(value)).toBe(value);
      expect(isThemePreference(value)).toBe(true);
    }
    expect(resolveThemePreference("solarized")).toBe("system");
    expect(resolveThemePreference("")).toBe("system");
    expect(resolveThemePreference(undefined)).toBe("system");
    expect(resolveThemePreference(null)).toBe("system");
  });
});

describe("themeFromCookieString", () => {
  it("finds the preference among other cookies", () => {
    expect(themeFromCookieString(`a=1; ${THEME_COOKIE}=light; b=2`)).toBe("light");
    expect(themeFromCookieString(`${THEME_COOKIE}=dark`)).toBe("dark");
    expect(themeFromCookieString(` ${THEME_COOKIE} = system `)).toBe("system");
  });

  it("distinguishes 'not stored' from 'stored as system'", () => {
    expect(themeFromCookieString("")).toBeNull();
    expect(themeFromCookieString(null)).toBeNull();
    expect(themeFromCookieString("other=1")).toBeNull();
    expect(themeFromCookieString(`${THEME_COOKIE}=system`)).toBe("system");
  });

  it("does not match a lookalike cookie name or an invalid value", () => {
    expect(themeFromCookieString(`x${THEME_COOKIE}=dark`)).toBeNull();
    expect(themeFromCookieString(`${THEME_COOKIE}_old=dark`)).toBeNull();
    expect(themeFromCookieString(`${THEME_COOKIE}=neon`)).toBeNull();
  });
});

describe("themeOnMount", () => {
  it("never lets a control's default override an explicit stored choice", () => {
    // The bug, in one line: the toggle mounted with "system" while
    // "light" was stored, and re-applied "system".
    expect(themeOnMount(`${THEME_COOKIE}=light`, "system")).toBe("light");
    expect(themeOnMount(`${THEME_COOKIE}=dark`, "system")).toBe("dark");
    expect(themeOnMount(`${THEME_COOKIE}=light`, "dark")).toBe("light");
  });

  it("falls back to the server-resolved value when nothing is stored", () => {
    expect(themeOnMount(null, "system")).toBe("system");
    expect(themeOnMount("", "dark")).toBe("dark");
    expect(themeOnMount("unrelated=1", "light")).toBe("light");
  });

  it("is idempotent when the two agree — the normal render", () => {
    for (const value of ["system", "light", "dark"] satisfies ThemePreference[]) {
      expect(themeOnMount(`${THEME_COOKIE}=${value}`, value)).toBe(value);
    }
  });
});
