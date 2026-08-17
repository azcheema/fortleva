import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SYSTEM_THEME_SCRIPT, THEME_COLOR_DARK, THEME_COLOR_LIGHT } from "@/lib/theme";
import { getThemePreference } from "@/lib/theme-server";

import { geistMonoVariable, interVariable } from "./fonts/fonts";

import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return {
    title: { default: t("appName"), template: `%s · ${t("appName")}` },
  };
}

/**
 * Browser chrome follows the theme: surface-l1 in light, surface-d1 in
 * dark. The two literals live in src/lib/theme.ts, where the contrast
 * gate asserts them equal to --background so they cannot drift.
 *
 * Keyed on prefers-color-scheme rather than the cookie on purpose:
 * reading cookies here would make viewport request-time and, per the
 * Next 16 docs, block the document shell until it resolves. An explicit
 * theme that contradicts the OS gets browser chrome one step off — the
 * page itself is still correct.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR_LIGHT },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR_DARK },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Locale is data (ARC-14): resolved per request in src/i18n/request.ts.
  const locale = await getLocale();
  // Theme is data too: an explicit choice is server-rendered onto <html>
  // (no script, no flash); "system" resolves pre-paint in <head>.
  const theme = await getThemePreference();

  return (
    <html
      lang={locale}
      className={[theme === "dark" ? "dark" : "", interVariable.variable, geistMonoVariable.variable]
        .filter(Boolean)
        .join(" ")}
      style={{ colorScheme: theme === "system" ? "light dark" : theme }}
      suppressHydrationWarning
    >
      <head>
        {theme === "system" ? (
          <script dangerouslySetInnerHTML={{ __html: SYSTEM_THEME_SCRIPT }} />
        ) : null}
      </head>
      <body>
        {/* Messages/locale are inherited from the request config (RSC). */}
        <NextIntlClientProvider>
          <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
          <Toaster position="bottom-right" />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
