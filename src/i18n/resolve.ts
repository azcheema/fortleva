import { headers } from "next/headers";
import { cache } from "react";

import { getMemberSession, getPortalSession } from "@/auth/session";
import { isViewAsRequest, resolveViewAsTarget } from "@/clients/view-as-context";
import { withTenant } from "@/db";
import { getActiveMembership } from "@/members/tenant-context";
import { isTimezone, readPreferences, type TenantPreferences } from "@/preferences/service";

import { DEFAULT_LOCALE, DEFAULT_TIMEZONE, isLocale, negotiateLocale, type AppLocale } from "./config";

/**
 * Locale resolution (UI.md §8, ARC-14): signed-in User.locale → the
 * active Tenant.defaultLocale → Accept-Language → "en". Cached per
 * request. Falls back to the default outside a request scope (build).
 *
 * THE CONTACT ARM (Phase 3, 2026-09-21) sits between the member and the
 * header, and its POSITION is the whole design. It is asked only when
 * there is no member session, so a member page pays nothing for it, and
 * a member who is ALSO a contact keeps their own setting on both planes
 * — which is what a person means by "my language". On an anonymous page
 * it costs a cookie check and no query: Better Auth returns null without
 * touching the database when the portal cookie is absent.
 *
 * `Contact.locale` and not the tenant's default: the tenant's default is
 * the AGENCY's language, and a Swedish agency with a German client would
 * otherwise serve that client Swedish forever. There is no tenant
 * fallback on this arm at all, deliberately — `tenant` carries
 * `portal_deny`, so reading one would need the system-principal seam
 * `module-gates.ts` had to earn, and Accept-Language is a better guess
 * than the agency's own language anyway.
 *
 * THE VIEW-AS ARM (Phase 3 slice 5) sits ABOVE all of it, and its
 * position is as deliberate as the contact arm's is. Everywhere else in
 * the product a member's own setting wins — that is what a person means
 * by "my language". On `/view-as` it must lose, because the surface's
 * entire claim is that it is byte-identical to what the contact gets,
 * and a page rendered in the member's Swedish against the contact's
 * English is a different page. Measured: with this arm removed the
 * e2e byte comparison fails on every string in the portal chrome.
 * It is asked first and answers null for every request but that one, at
 * the cost of a header read (`src/clients/view-as-context.ts`).
 */
export const resolveLocale = cache(async (): Promise<AppLocale> => {
  try {
    // VIEW-AS FIRST, AND ONLY ON ITS OWN ROUTE (Phase 3 slice 5). The
    // one place the ordering below is deliberately inverted: the member
    // session exists and is ignored, because the whole claim of that
    // surface is that it renders what the CONTACT would get.
    // `isViewAsRequest()` is asked FIRST and is a header read with no
    // database in it, so no other request in the product opens a
    // transaction on account of this arm.
    const viewAs = (await isViewAsRequest()) ? await resolveViewAsTarget() : null;
    if (viewAs) {
      if (isLocale(viewAs.locale)) return viewAs.locale;
      // `Contact.locale` is null — which for a REAL contact means their
      // Accept-Language decides, and that is their browser's header on
      // their own request, not something any server-side preview can
      // know. So the default, and the honest statement of the limit:
      // View-as is byte-identical to a contact whose language has been
      // recorded, and to one whose browser asks for the default. The
      // member's own locale is NOT the fallback; it is the one answer
      // guaranteed to be wrong whenever the two differ.
      return DEFAULT_LOCALE;
    }
    const session = await getMemberSession();
    if (session) {
      // The member arm lives in its own function because View-as needs to
      // ask for it EXPLICITLY: on `/view-as` the arm above has already
      // won, and the red banner still has to be in the member's own
      // language (`resolveMemberLocale`, below).
      return await resolveMemberLocale();
    } else {
      // `locale` is declared in CONTACT_ADDITIONAL_FIELDS, so it really
      // arrives; an undeclared column would read `undefined` however
      // full the row is (src/auth/portal.ts).
      const portal = await getPortalSession();
      const contactLocale = (portal?.user as { locale?: string | null } | undefined)?.locale;
      if (isLocale(contactLocale)) return contactLocale;
    }
    const negotiated = negotiateLocale((await headers()).get("accept-language"));
    return negotiated ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
});

/**
 * THE MEMBER'S OWN LANGUAGE, ignoring View-as — `User.locale` → the
 * active `Tenant.defaultLocale` → Accept-Language → "en".
 *
 * `resolveLocale` delegates its member arm to this, so on every ordinary
 * page the two are the same answer and the memo is shared. It exists
 * separately for exactly one surface: `/view-as` renders the portal in
 * the CONTACT'S language, because that page is byte-compared to what
 * the contact receives — but the red banner across the top, and the
 * button that leaves the mode, are the only member-facing things on
 * that route and must not be in a language chosen for the client (code
 * review, 2026-09-21). Those two strings are rendered with
 * `getTranslations({ locale })` against this.
 *
 * Nothing else should call it. A page that wants "the viewer's
 * language" wants `resolveLocale`.
 */
export const resolveMemberLocale = cache(async (): Promise<AppLocale> => {
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

export { DEFAULT_TIMEZONE };

/**
 * Time-zone resolution (UI.md §8): Member.timezone → the tenant's
 * `ui.timezone` preference → Europe/Stockholm. Cached per request; the
 * default outside a request scope / for a session without a membership.
 */
export const resolveTimeZone = cache(async (): Promise<string> => {
  try {
    // The same inversion as the locale, and it is owed for the same
    // reason even though PLAN §0's note named only the language: a
    // contact request has no member session, so the very next line
    // already returns the default for one — a `Contact` has no timezone
    // column and `tenant` carries `portal_deny`, so there is nothing
    // else it could read. `completedAt` is a real instant rendered
    // through next-intl's zone, so a member in Europe/Helsinki would
    // format the contact's page an hour out with everything else on it
    // identical.
    if ((await isViewAsRequest()) && (await resolveViewAsTarget())) return DEFAULT_TIMEZONE;
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
