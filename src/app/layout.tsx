import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return {
    title: { default: t("appName"), template: `%s · ${t("appName")}` },
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Locale is data (ARC-14): resolved per request in src/i18n/request.ts.
  const locale = await getLocale();

  return (
    <html lang={locale}>
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
