import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { Page, PageHeader, SectionCard } from "@/components/semantic";
import { withTenant } from "@/db";
import { requireTenantContext } from "@/members/tenant-context";
import { readOwnPreferences } from "@/notify/preferences";
import { readPreferences } from "@/preferences/service";

import { EmailLevelForm, SummaryForm, WeeklyReminderForm } from "./notification-forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("notifications") };
}

/**
 * `/settings/notifications` (UI.md §3.1 Settings): how Fortleva reaches
 * THIS member.
 *
 * NO PERMISSION GATE, unlike every other page under `/settings`. Those
 * administer the workspace and are hidden without `settings:view`;
 * this one administers one person's own mail, and there is no seat in
 * this product that decides on someone else's behalf whether they are
 * emailed. That is also why nothing here takes a member id: the row is
 * the actor's, by construction (`notify/preferences.ts`).
 *
 * The SUMMARY's hour is read in the member's own zone (`Member.timezone`,
 * set on /account), else the workspace's — the job's own fallbacks
 * (`src/jobs/digests.ts`), so the page never names a zone the job does not use.
 */
export default async function NotificationSettingsPage() {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("settings.notifications");
  const prefs = await readOwnPreferences({ tenantId: membership.tenantId, actor });
  const zone =
    membership.timezone ??
    (await withTenant(
      membership.tenantId,
      { type: "member", id: membership.memberId },
      async (tx) => (await readPreferences(tx, membership.tenantId)).timezone,
    ));

  return (
    <Page width="form">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="mt-6 flex flex-col gap-4">
        <SectionCard title={t("email.title")} description={t("email.description")}>
          <EmailLevelForm prefs={prefs} />
        </SectionCard>
        <SectionCard title={t("summary.title")} description={t("summary.description")}>
          <SummaryForm prefs={prefs} zone={zone} />
        </SectionCard>
        <SectionCard title={t("weekly.title")} description={t("weekly.description")}>
          <WeeklyReminderForm prefs={prefs} />
        </SectionCard>
      </div>
    </Page>
  );
}
