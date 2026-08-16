import { getRequestConfig } from "next-intl/server";

import { resolveLocale, resolveTimeZone } from "./resolve";

/**
 * next-intl request config, "without i18n routing": no locale segment
 * in the URL — the locale is resolved per request from data
 * (User.locale → Tenant.defaultLocale → Accept-Language → en, UI.md §8),
 * and so is the time zone (Member.timezone → tenant `ui.timezone` →
 * Europe/Stockholm) so every formatted date/time is the viewer's.
 */
export default getRequestConfig(async () => {
  const [locale, timeZone] = await Promise.all([resolveLocale(), resolveTimeZone()]);
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    timeZone,
  };
});
