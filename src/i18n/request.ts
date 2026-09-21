import { getRequestConfig } from "next-intl/server";

import { isLocale } from "./config";
import { resolveLocale, resolveTimeZone } from "./resolve";

/**
 * next-intl request config, "without i18n routing": no locale segment
 * in the URL — the locale is resolved per request from data
 * (User.locale → Tenant.defaultLocale → Accept-Language → en, UI.md §8),
 * and so is the time zone (Member.timezone → tenant `ui.timezone` →
 * Europe/Stockholm) so every formatted date/time is the viewer's.
 */
export default getRequestConfig(async ({ locale: requested }) => {
  // AN EXPLICIT LOCALE WINS, and honouring it is what makes
  // `getTranslations({ locale })` work at all (Phase 3 slice 5). Nothing
  // in the product passed one until View-as-Contact needed to render two
  // languages on one page: the portal surface in the CONTACT'S language,
  // because it is byte-compared to what that contact receives, and the
  // red banner and its exit button in the MEMBER'S, because they are the
  // only member-facing things on the route — the warning that says "you
  // are looking at somebody else's screen" and the control that gets you
  // out. A code review caught both rendering in the client's language.
  //
  // next-intl re-enters this function per distinct override and memoises
  // on it (`getConfig(localeOverride)`), so the two renders cost two
  // message imports and no extra resolution. With no override — every
  // other request in the product — this is exactly what it always was.
  const locale = isLocale(requested) ? requested : await resolveLocale();
  const timeZone = await resolveTimeZone();
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    timeZone,
  };
});
