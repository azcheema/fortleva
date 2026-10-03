import type { Metadata } from "next";
import { CalendarClockIcon, KeyRoundIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import { daysBetween } from "@/app/(tenant)/(authed)/clients/[id]/assets/asset-shape";
import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { Callout, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { resolveTimeZone } from "@/i18n/resolve";
import { localDateString } from "@/lib/duration";
import { requireTenantContext } from "@/members/tenant-context";
import { expirationsFeed, GLANCE_DAYS, type ExpirationsFeed } from "@/modules/vault";

import { ExpirationList } from "./expiration-list";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("expirations");
  return { title: t("title") };
}

/**
 * `/expirations` — RENEWALS (Phase 3V slice 88; UI.md §3.1's Vault row;
 * DATA_MODEL.md §6.17's expirations feed). Everything that renews, expires
 * or ends within 90 days, and everything already past its date, across the
 * clients the member reaches — assets (`asset:view`, the page's gate),
 * agreements (`service:view`), and LOGINS as a count per client only
 * (`credential:view`; founder decision C54: which ones stays behind the
 * vault's door, so this page never opens it).
 *
 * Three groups, soonest first: past their date, within 30 days, within 90.
 * Each row leads to where the thing is renewed. Without `asset:view` — or
 * with the vault module off — the page is a 404, as every gated page is
 * (UI.md §7.3).
 */
export default async function ExpirationsPage() {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const today = localDateString(new Date(), await resolveTimeZone());
  let feed: ExpirationsFeed;
  try {
    feed = await expirationsFeed(ctx, today);
  } catch (e) {
    handleAuthzRedirect(e, "/expirations");
    if (e instanceof AuthzError) notFound();
    throw e;
  }
  const t = await getTranslations("expirations");
  const tVault = await getTranslations("vault.tenant");
  const format = await getFormatter();
  const dayLabel = (day: string) => format.dateTime(new Date(`${day}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });

  const lapsed = feed.entries.filter((e) => daysBetween(today, e.date) < 0);
  const soon = feed.entries.filter((e) => {
    const d = daysBetween(today, e.date);
    return d >= 0 && d <= GLANCE_DAYS;
  });
  const later = feed.entries.filter((e) => daysBetween(today, e.date) > GLANCE_DAYS);
  const groups = [
    { key: "lapsed", title: t("groups.lapsed"), entries: lapsed },
    { key: "soon", title: t("groups.soon"), entries: soon },
    { key: "later", title: t("groups.later"), entries: later },
  ] as const;
  const logins = (feed.logins ?? []).filter((l) => l.count > 0);
  const untilLabel = dayLabel(feed.until);

  return (
    <Page>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="mt-6 flex flex-col gap-6">
        {feed.cutAt !== null ? (
          <Callout tone="caution" role="status">
            {t("truncated", { date: dayLabel(feed.cutAt) })}
          </Callout>
        ) : null}

        {/* "Nothing to renew" only when there is nothing at all — not above a
            card of expiring logins (the code review). */}
        {feed.entries.length === 0 && logins.length === 0 ? (
          <SectionCard>
            <EmptyState
              variant="empty"
              icon={CalendarClockIcon}
              title={t("empty")}
              body={t("emptyBody")}
              action={
                <Button asChild size="sm" variant="secondary">
                  <Link href="/clients">{t("emptyAction")}</Link>
                </Button>
              }
            />
          </SectionCard>
        ) : (
          groups
            .filter((g) => g.entries.length > 0)
            .map((g) => (
              <SectionCard key={g.key} id={`expirations-${g.key}`} title={g.title} contentClassName="p-0">
                <ExpirationList entries={g.entries} today={today} />
              </SectionCard>
            ))
        )}

        {logins.length > 0 ? (
          <SectionCard title={t("logins.title")} description={t("logins.description")} contentClassName="p-0">
            <ul data-testid="expirations-logins">
              {logins.map((l) => {
                const name = l.client?.name ?? tVault("agencyTitle");
                const href = l.client ? `/clients/${l.client.id}/vault` : "/vault?client=agency";
                return (
                  <li key={l.client?.id ?? "agency"} className="border-t border-border first:border-t-0">
                    <Link
                      href={href}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    >
                      <KeyRoundIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
                      <span className="shrink-0 text-sm text-muted-foreground">
                        {t("logins.row", { count: l.count, date: untilLabel })}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </SectionCard>
        ) : null}
      </div>
    </Page>
  );
}
