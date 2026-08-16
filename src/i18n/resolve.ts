import { headers } from "next/headers";
import { cache } from "react";

import { getMemberSession } from "@/auth/session";
import { withTenant } from "@/db";
import { getActiveMembership } from "@/members/tenant-context";
import { isTimezone, readPreferences } from "@/preferences/service";

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

export const DEFAULT_TIMEZONE = "Europe/Stockholm";

/**
 * Time-zone resolution (UI.md §8): Member.timezone → the tenant's
 * `ui.timezone` preference → Europe/Stockholm. Cached per request; the
 * default outside a request scope / for a session without a membership.
 */
export const resolveTimeZone = cache(async (): Promise<string> => {
  try {
    const session = await getMemberSession();
    if (!session) return DEFAULT_TIMEZONE;
    const membership = await getActiveMembership(session);
    if (!membership) return DEFAULT_TIMEZONE;
    if (isTimezone(membership.timezone)) return membership.timezone;
    return await withTenant(
      membership.tenantId,
      { type: "member", id: membership.memberId },
      async (tx) => (await readPreferences(tx, membership.tenantId)).timezone,
    );
  } catch {
    return DEFAULT_TIMEZONE;
  }
});
