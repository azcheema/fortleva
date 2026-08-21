import { getTranslations } from "next-intl/server";

import { resolvePreferences, resolveTimeZone } from "@/i18n/resolve";
import { localDateString } from "@/lib/duration";
import { isIsoDate, weekContaining, type WeekRange } from "@/lib/week";
import type { TenantPreferences } from "@/preferences/service";

export type WeekContext = {
  prefs: TenantPreferences;
  /** The viewer's zone: Member.timezone → tenant `ui.timezone` (UI.md §8). */
  timezone: string;
  /** Today's local date in that zone. */
  today: string;
  /** The grid week (tenant `ui.weekStart`) containing `anchor`, or today. */
  week: WeekRange;
  /** "Week 34 · 2026-08-17 – 2026-08-23" — `time.weekLabel`, formatted once. */
  weekLabel: string;
};

/**
 * "The viewed week for this member" — timezone, today, the grid week and
 * its label — resolved ONCE for every page that shows a week (/time,
 * /time/team, /home), so the week-start rule, the "today" anchor and
 * the label format cannot drift between surfaces. `anchor` is the `?w=`
 * parameter when a page has one (validated here; anything else means
 * today). The preference and zone reads are the request-cached ones.
 */
export async function resolveWeekContext(anchor?: string | null): Promise<WeekContext> {
  const [prefs, timezone, t] = await Promise.all([resolvePreferences(), resolveTimeZone(), getTranslations("time")]);
  const today = localDateString(new Date(), timezone);
  const week = weekContaining(isIsoDate(anchor) ? anchor : today, prefs!.weekStart);
  return {
    prefs: prefs!,
    timezone,
    today,
    week,
    weekLabel: t("weekLabel", { week: week.isoWeek, from: week.from, to: week.to }),
  };
}
