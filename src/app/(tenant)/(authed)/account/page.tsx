import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import { Callout, Page, PageHeader, SectionCard } from "@/components/semantic";
import { withTenant } from "@/db";
import { isLocale } from "@/i18n/config";
import { getActiveMembership } from "@/members/tenant-context";
import { readPreferences } from "@/preferences/service";

import { ChangePasswordForm } from "./change-password-form";
import { LocaleForm } from "./locale-form";
import { TimezoneForm } from "./timezone-form";
import { TotpEnrollment } from "./totp-enrollment";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("account");
  return { title: t("title") };
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const session = await requireMemberSession();
  const t = await getTranslations("account");
  const twoFactorEnabled =
    (session.user as { twoFactorEnabled?: boolean }).twoFactorEnabled ?? false;
  const userLocale = (session.user as { locale?: string | null }).locale;
  const notice = (await searchParams).notice;
  // Personal time zone lives on the active membership (Member.timezone);
  // the workspace default is the tenant's `ui.timezone` preference.
  const membership = await getActiveMembership(session);
  const workspaceTimezone = membership
    ? await withTenant(
        membership.tenantId,
        { type: "member", id: membership.memberId },
        async (tx) => (await readPreferences(tx, membership.tenantId)).timezone,
      )
    : null;

  return (
    <Page width="form">
      <PageHeader title={t("security")} description={session.user.email} />
      {notice === "mfa_required" && !twoFactorEnabled ? (
        <Callout tone="caution" role="alert" className="mt-4">
          {t("mfaRequiredNotice")}
        </Callout>
      ) : null}

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <SectionCard title={t("language.title")} description={t("language.description")}>
          <LocaleForm current={isLocale(userLocale) ? userLocale : ""} />
        </SectionCard>

        {membership && workspaceTimezone ? (
          <SectionCard title={t("timezone.title")} description={t("timezone.description")}>
            <TimezoneForm current={membership.timezone} workspaceDefault={workspaceTimezone} />
          </SectionCard>
        ) : null}

        <SectionCard title={t("password.title")}>
          <ChangePasswordForm />
        </SectionCard>

        <SectionCard
          title={t("totp.title")}
          description={twoFactorEnabled ? t("totp.enabled") : t("totp.notEnrolled")}
          className="md:col-span-2"
        >
          <TotpEnrollment enabled={twoFactorEnabled} />
        </SectionCard>
      </div>
    </Page>
  );
}
