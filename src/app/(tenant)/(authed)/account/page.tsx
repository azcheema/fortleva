import type { Metadata } from "next";
import { ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import { Callout, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
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

/**
 * /account: one column at form width (720px), security first.
 *
 * Two-factor carries its state as a badge in the card header — enabled
 * is a tick in the success tone, not enrolled is a triangle in the
 * caution tone — because "am I protected?" should be answerable from
 * the top of the card without reading a paragraph. Both states always
 * render; absence would be indistinguishable from a bug.
 */
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

      <div className="mt-6 flex flex-col gap-4">
        <SectionCard title={t("password.title")} description={t("password.description")}>
          <ChangePasswordForm />
        </SectionCard>

        <SectionCard
          title={t("totp.title")}
          description={twoFactorEnabled ? t("totp.enabled") : t("totp.notEnrolled")}
          actions={
            twoFactorEnabled ? (
              <Badge variant="success">
                <ShieldCheckIcon aria-hidden="true" />
                {t("totp.badgeOn")}
              </Badge>
            ) : (
              <Badge variant="caution">
                <ShieldAlertIcon aria-hidden="true" />
                {t("totp.badgeOff")}
              </Badge>
            )
          }
        >
          <TotpEnrollment enabled={twoFactorEnabled} />
        </SectionCard>

        <SectionCard title={t("language.title")} description={t("language.description")}>
          <LocaleForm current={isLocale(userLocale) ? userLocale : ""} />
        </SectionCard>

        {membership && workspaceTimezone ? (
          <SectionCard title={t("timezone.title")} description={t("timezone.description")}>
            <TimezoneForm current={membership.timezone} workspaceDefault={workspaceTimezone} />
          </SectionCard>
        ) : null}
      </div>
    </Page>
  );
}
