import type { Metadata } from "next";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { withTenant } from "@/db";
import { resolveLocale, resolveTimeZone } from "@/i18n/resolve";
import { localDateString } from "@/lib/duration";
import { dateFormat } from "@/lib/format";
import { addDays, isIsoDate, weekContaining } from "@/lib/week";
import { requireTenantContext } from "@/members/tenant-context";
import { listTeamShiftTotals, teamRollup } from "@/modules/time";
import { readPreferences } from "@/preferences/service";

import { TeamTable } from "./team-table";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("time.team");
  return { title: t("title") };
}

/**
 * /time/team (time:view_team; UI.md §3.1, rule 14; SECURITY.md §9.7.3):
 * per-member totals by project for a week, and per-member day totals of
 * CLOSED shifts with Δ vs hoursPerDay — aggregate views with a declared
 * purpose, never a live clock, never presence. Bill amounts only with
 * rate:view_bill; cost never here.
 */
export default async function TimeTeamPage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("time.team");
  const tCommon = await getTranslations("common");
  const timezone = await resolveTimeZone();
  const locale = await resolveLocale();
  const sp = await searchParams;
  const prefs = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
    readPreferences(tx, membership.tenantId),
  );
  const today = localDateString(new Date(), timezone);
  const week = weekContaining(isIsoDate(sp.w) ? sp.w : today, prefs.weekStart);

  let data: { lines: Awaited<ReturnType<typeof teamRollup>>; shifts: Awaited<ReturnType<typeof listTeamShiftTotals>> } | null = null;
  try {
    const [lines, shifts] = await Promise.all([
      teamRollup(ctx, { from: week.from, to: week.to }),
      listTeamShiftTotals(ctx, { from: week.from, to: week.to }),
    ]);
    data = { lines, shifts };
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }

  if (!data) {
    return (
      <Page>
        <PageHeader title={t("title")} />
        <div className="mt-6">
          <SectionCard>
            <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("noPermission")} />
          </SectionCard>
        </div>
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        title={t("title")}
        description={t("weekLabel", { week: week.isoWeek, from: week.from, to: week.to })}
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="icon-sm" aria-label={t("prevWeek")}>
              <Link href={`/time/team?w=${addDays(week.from, -7)}`}>
                <ChevronLeftIcon aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/time/team">{t("thisWeek")}</Link>
            </Button>
            <Button asChild variant="outline" size="icon-sm" aria-label={t("nextWeek")}>
              <Link href={`/time/team?w=${addDays(week.from, 7)}`}>
                <ChevronRightIcon aria-hidden="true" />
              </Link>
            </Button>
          </div>
        }
      />
      <div className="mt-6 flex flex-col gap-4">
        <TeamTable
          lines={data.lines.map((l) => ({ ...l }))}
          shifts={data.shifts.map((s) => ({ ...s, localDate: s.localDate.toISOString().slice(0, 10) }))}
          durationStyle={prefs.durationStyle}
          days={week.days}
          dayLabels={Object.fromEntries(
            week.days.map((d) => [d, dateFormat(locale, { weekday: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`))]),
          )}
        />
      </div>
    </Page>
  );
}
