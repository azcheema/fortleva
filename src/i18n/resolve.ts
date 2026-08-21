import { headers } from "next/headers";
import { cache } from "react";

import { getMemberSession } from "@/auth/session";
import { withTenant } from "@/db";
import { getActiveMembership } from "@/members/tenant-context";
import { isTimezone, readPreferences, type TenantPreferences } from "@/preferences/service";

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

/**
 * Tenant preferences for the active membership, read ONCE per request
 * (React cache) — the time-zone fallback below, and every page that
 * used to open its own `withTenant(readPreferences)` transaction, share
 * this read. null outside a member session. Service-layer code keeps
 * reading preferences inside its own transaction: this is the page /
 * layout convenience only.
 */
export const resolvePreferences = cache(async (): Promise<TenantPreferences | null> => {
  const session = await getMemberSession();
  if (!session) return null;
  const membership = await getActiveMembership(session);
  if (!membership) return null;
  return withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
    readPreferences(tx, membership.tenantId),
  );
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
