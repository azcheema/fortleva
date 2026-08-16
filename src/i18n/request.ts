import { getRequestConfig } from "next-intl/server";

import { resolveLocale } from "./resolve";

/**
 * next-intl request config, "without i18n routing": no locale segment
 * in the URL — the locale is resolved per request from data
 * (User.locale → Tenant.defaultLocale → Accept-Language → en, UI.md §8).
 */
export default getRequestConfig(async () => {
  const locale = await resolveLocale();
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    timeZone: "Europe/Stockholm",
  };
});
