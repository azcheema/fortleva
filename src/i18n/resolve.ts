import { headers } from "next/headers";
import { cache } from "react";

import { getMemberSession } from "@/auth/session";
import { getActiveMembership } from "@/members/tenant-context";

import { DEFAULT_LOCALE, isLocale, negotiateLocale, type AppLocale } from "./config";

/**
 * Locale resolution (UI.md §8, ARC-14): signed-in User.locale → the
 * active Tenant.defaultLocale → Accept-Language → "en". Cached per
 * request. Falls back to the default outside a request scope (build).
 */
export const resolveLocale = cache(async (): Promise<AppLocale> => {
  try {
    const session = await getMemberSession();
    if (session) {
      const userLocale = (session.user as { locale?: string | null }).locale;
      if (isLocale(userLocale)) return userLocale;
      const membership = await getActiveMembership(session);
      if (membership && isLocale(membership.defaultLocale)) return membership.defaultLocale;
    }
    const negotiated = negotiateLocale((await headers()).get("accept-language"));
    return negotiated ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
});
