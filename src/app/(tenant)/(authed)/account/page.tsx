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
 *
 * Order is not fixed. A member sent here mid-action ("this needs
 * two-factor") arrives to do exactly one thing, so the two-factor card
 * comes first and the reason is a caution INSIDE it — the banner used
 * to say "enrol below" above a Change-password card, with the card it
 * meant 350px further down and nothing linking to it.
 *
 * Language and time zone are one "Regional" card: each was a card whose
 * only control repeated its own heading.
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
  const steppedUp = notice === "mfa_required" && !twoFactorEnabled;
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

  const totpCard = (
    <SectionCard
      title={t("totp.title")}
      description={twoFactorEnabled ? t("totp.enabled") : undefined}
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
      contentClassName="flex flex-col gap-4"
    >
      {/* The page's most consequential fact was its quietest: third-tier
          grey under the heading. It is a caution, and it belongs beside
          the control that resolves it. */}
      {!twoFactorEnabled ? (
        <Callout tone="caution" role={steppedUp ? "alert" : undefined}>
          {steppedUp ? t("mfaRequiredNotice") : t("totp.notEnrolled")}
        </Callout>
      ) : null}
      <TotpEnrollment enabled={twoFactorEnabled} />
    </SectionCard>
  );

  return (
    <Page width="form">
      <PageHeader title={t("security")} description={session.user.email} />

      <div className="mt-6 flex flex-col gap-4">
        {steppedUp ? totpCard : null}

        <SectionCard title={t("password.title")} description={t("password.description")}>
          <ChangePasswordForm />
        </SectionCard>

        {steppedUp ? null : totpCard}

        <SectionCard title={t("regional.title")} description={t("regional.description")}>
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
            <LocaleForm current={isLocale(userLocale) ? userLocale : ""} />
            {membership && workspaceTimezone ? (
              <TimezoneForm current={membership.timezone} workspaceDefault={workspaceTimezone} />
            ) : null}
          </div>
        </SectionCard>
      </div>
    </Page>
  );
}
