import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/page-header";
import { isLocale } from "@/i18n/config";

import { ChangePasswordForm } from "./change-password-form";
import { LocaleForm } from "./locale-form";
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

  return (
    <Page>
      <PageHeader title={t("security")} description={session.user.email} />
      {notice === "mfa_required" && !twoFactorEnabled ? (
        <p
          role="alert"
          className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {t("mfaRequiredNotice")}
        </p>
      ) : null}

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("language.title")}</CardTitle>
            <CardDescription>{t("language.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <LocaleForm current={isLocale(userLocale) ? userLocale : ""} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("password.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>{t("totp.title")}</CardTitle>
            <CardDescription>
              {twoFactorEnabled ? t("totp.enabled") : t("totp.notEnrolled")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TotpEnrollment enabled={twoFactorEnabled} />
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}
