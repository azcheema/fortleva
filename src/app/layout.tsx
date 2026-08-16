import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SYSTEM_THEME_SCRIPT, THEME_COOKIE, resolveThemePreference } from "@/lib/theme";

import { geistMonoVariable, interVariable } from "./fonts/fonts";

import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return {
    title: { default: t("appName"), template: `%s · ${t("appName")}` },
  };
}

/** Browser chrome follows the theme: surface-l1 in light, surface-d1 in dark. */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9fafb" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1d23" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Locale is data (ARC-14): resolved per request in src/i18n/request.ts.
  const locale = await getLocale();
  // Theme is data too: an explicit choice is server-rendered onto <html>
  // (no script, no flash); "system" resolves pre-paint in <head>.
  const theme = resolveThemePreference((await cookies()).get(THEME_COOKIE)?.value);

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
