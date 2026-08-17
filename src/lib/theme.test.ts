import { describe, expect, it } from "vitest";

import {
  THEME_COOKIE,
  isThemePreference,
  resolveThemePreference,
  themeFromCookieString,
  clientTheme,
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

describe("clientTheme", () => {
  it("reads an explicit stored choice out of the cookie string", () => {
    expect(clientTheme(`${THEME_COOKIE}=light`)).toBe("light");
    expect(clientTheme(`${THEME_COOKIE}=dark`)).toBe("dark");
    expect(clientTheme(`a=1; ${THEME_COOKIE}=light; b=2`)).toBe("light");
  });

  it("treats 'nothing stored' as system — never a server-rendered value", () => {
    // The removed fallback took a preference resolved on the server. That
    // value is stale the moment the user chooses (a layout is not
    // re-rendered on a cookie write or a client navigation), so a control
    // remounting later re-applied the page-load theme. "system" is the
    // only correct answer when the cookie is absent.
    expect(clientTheme(null)).toBe("system");
    expect(clientTheme("")).toBe("system");
    expect(clientTheme("unrelated=1")).toBe("system");
  });

  it("does not mistake an already-parsed preference for a cookie string", () => {
    // The exact regression: readStoredTheme() returns "light", which was
    // then handed to a parser looking for `fl_theme=…`, matched nothing,
    // and fell through to the stale server value. The parameter is branded
    // so this no longer type-checks; the behaviour is pinned here too.
    expect(clientTheme("light")).toBe("system");
  });
});
