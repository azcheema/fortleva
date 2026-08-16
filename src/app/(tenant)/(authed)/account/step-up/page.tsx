import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import { enrolUrl, safeNextPath } from "@/authz/redirects";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { StepUpForm } from "./step-up-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("account.stepUp");
  return { title: t("title") };
}

/**
 * Step-up page (SECURITY.md §3.5): reached when authorize() denied a ✦
 * code with MFA_REQUIRED/step_up. A member without an enrolled factor
 * cannot step up — they are sent to enrol instead.
 */
export default async function StepUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await requireMemberSession();
  const next = safeNextPath((await searchParams).next);
  const enrolled = (session.user as { twoFactorEnabled?: boolean }).twoFactorEnabled === true;
  if (!enrolled) redirect(enrolUrl(next));
  const t = await getTranslations("account.stepUp");

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <StepUpForm next={next} />
        </CardContent>
      </Card>
    </div>
  );
}
