import { cookies } from "next/headers";

import { THEME_COOKIE, resolveThemePreference, type ThemePreference } from "./theme";

/**
 * The request's theme preference, resolved once per render site that
 * needs it (the root layout, which writes it onto <html>, and every
 * layout that renders a ThemeToggle, which must show the same value the
 * document was rendered with).
 *
 * Kept out of src/lib/theme.ts on purpose: that module is pure and is
 * imported by client components, and next/headers is server-only.
 */
export const getThemePreference = async (): Promise<ThemePreference> =>
  resolveThemePreference((await cookies()).get(THEME_COOKIE)?.value);
