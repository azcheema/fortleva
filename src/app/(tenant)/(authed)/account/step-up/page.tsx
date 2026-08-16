import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import { enrolUrl, safeNextPath } from "@/authz/redirects";
import { Page, SectionCard } from "@/components/semantic";

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
    <Page width="form">
      <SectionCard title={t("title")} description={t("description")} className="max-w-sm">
        <StepUpForm next={next} />
      </SectionCard>
    </Page>
  );
}
