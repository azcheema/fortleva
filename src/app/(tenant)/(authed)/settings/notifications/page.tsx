import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";

import { Page, PageHeader, SectionCard } from "@/components/semantic";
import { withTenant } from "@/db";
import { requireTenantContext } from "@/members/tenant-context";
import { readOwnPreferences } from "@/notify/preferences";
import { readPreferences } from "@/preferences/service";
import { listOwnPushDevices, UNKNOWN_DEVICE_LABEL } from "@/push/devices";
import { serverVapidPublicKey } from "@/push/keys";

import { EmailLevelForm, PushLevelForm, QuietHoursForm, SummaryForm, WeeklyReminderForm } from "./notification-forms";
import { PushDevices, type PushDeviceView } from "./push-devices";

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
 * PHONE AND BROWSER (Phase 5 slice 106, founder decision C74 (f)): the phone's
 * own level and this member's devices — the only place one is turned on.
 *
 * The SUMMARY's hour and the QUIET HOURS are read in the member's own zone
 * (`Member.timezone`, set on /account), else the workspace's — the jobs' own
 * fallbacks (`src/notify/zone.ts`), so the page never names a zone the job
 * does not use.
 */
export default async function NotificationSettingsPage() {
  const { membership, actor, userId } = await requireTenantContext();
  const t = await getTranslations("settings.notifications");
  const format = await getFormatter();
  const prefs = await readOwnPreferences({ tenantId: membership.tenantId, actor });
  // The member's own devices for phone notifications (slice 106): dates
  // formatted here, in the request's zone — never in the island.
  const devices: PushDeviceView[] = (await listOwnPushDevices({ tenantId: membership.tenantId, actor, userId })).map((d) => ({
    id: d.id,
    label: d.label === UNKNOWN_DEVICE_LABEL ? t("push.unknownDevice") : d.label,
    added: t("push.added", { date: format.dateTime(d.createdAt, { dateStyle: "medium" }) }),
    signedIn: d.signedIn,
    endpointHash: d.endpointHash,
  }));
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
        <SectionCard title={t("push.title")} description={t("push.description")}>
          <PushLevelForm prefs={prefs} />
          <PushDevices devices={devices} vapidPublicKey={serverVapidPublicKey()} />
        </SectionCard>
        <SectionCard title={t("quiet.title")} description={t("quiet.description")}>
          <QuietHoursForm prefs={prefs} zone={zone} />
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
