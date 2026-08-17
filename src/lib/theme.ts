/**
 * Theme preference vocabulary. Deliberately NOT next-themes: the app
 * already resolves per-request preferences server-side, and a second
 * client-only source of truth would drift from it and force a client
 * boundary at the root layout.
 *
 * The value lives in a plain cookie so the unauthenticated pages
 * (login, signup, invite) get the same theme as the app. When a member
 * preference row is added (Stage 3 / src/preferences), the cookie
 * becomes its mirror, not a competing store — the resolution order is
 * member preference, then cookie, then "system".
 *
 * Pure module: no next/headers, no DOM. Safe from both planes and from
 * client components.
 */

/**
 * Browser-chrome colours for <meta name="theme-color">, which cannot
 * read a CSS custom property. These are the only place a colour from
 * globals.css is written a second time, so src/lib/contrast.test.ts
 * asserts them equal to --background in each theme.
 */
export const THEME_COLOR_LIGHT = "#f9fafb"; // oklch(0.985 0.002 268) = --color-surface-l1
export const THEME_COLOR_DARK = "#0a0c11"; //  oklch(0.155 0.010 268) = --color-surface-d1

export const THEME_COOKIE = "fl_theme";
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const THEMES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEMES)[number];

export const isThemePreference = (v: unknown): v is ThemePreference =>
  typeof v === "string" && (THEMES as readonly string[]).includes(v);

export const resolveThemePreference = (raw: string | undefined | null): ThemePreference =>
  isThemePreference(raw) ? raw : "system";

/**
 * The stored preference inside a cookie string — `document.cookie` in
 * the browser, a Cookie header on the server. Returns null when there
 * is no stored preference at all, which is NOT the same as "system":
 * "system" can be chosen explicitly, and absence must not overwrite it.
 */
export const themeFromCookieString = (raw: string | undefined | null): ThemePreference | null => {
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== THEME_COOKIE) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    if (isThemePreference(value)) return value;
  }
  return null;
};

/**
 * What a freshly mounted theme control must adopt (INV: a control's own
 * default NEVER overrides an explicit stored choice). The cookie is the
 * authority — it is the same value the server rendered <html> from —
 * and the server-resolved preference is the fallback for the first
 * visit, when nothing is stored yet.
 *
 * This is the whole of the theme-persistence rule, written once and
 * pinned by src/lib/theme.test.ts, so no render site can re-invent it.
 */
export const themeOnMount = (
  cookieString: string | undefined | null,
  serverResolved: ThemePreference,
): ThemePreference => themeFromCookieString(cookieString) ?? serverResolved;

/**
 * Runs synchronously in <head> before first paint, and only when the
 * preference is "system" — an explicit choice is server-rendered onto
 * <html> and ships no script at all.
 */
export const SYSTEM_THEME_SCRIPT =
  '(function(){try{if(matchMedia("(prefers-color-scheme: dark)").matches){' +
  'document.documentElement.classList.add("dark");' +
  'document.documentElement.style.colorScheme="dark"}}catch(e){}})()';

/** Apply a preference to <html> immediately (client-side, pre-paint). */
export function applyTheme(pref: ThemePreference): void {
  if (typeof document === "undefined") return;
  const dark =
    pref === "dark" ||
    (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = pref === "system" ? "light dark" : pref;
}

/** The stored preference as the browser sees it (client-side). */
export function readStoredTheme(): ThemePreference | null {
  if (typeof document === "undefined") return null;
  return themeFromCookieString(document.cookie);
}

/**
 * Cookie writes are invisible to the DOM, so the one store every mounted
 * control reads from needs a change signal of its own. Controls
 * subscribe with subscribeStoredTheme(); writeThemeCookie() emits.
 */
const THEME_EVENT = "flv:theme";

/** Persist the preference in the mirror cookie (client-side) and announce it. */
export function writeThemeCookie(pref: ThemePreference): void {
  if (typeof document === "undefined") return;
  document.cookie = `${THEME_COOKIE}=${pref}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** Subscribe to preference changes made anywhere in this document. */
export function subscribeStoredTheme(onChange: () => void): () => void {
  window.addEventListener(THEME_EVENT, onChange);
  return () => window.removeEventListener(THEME_EVENT, onChange);
}
