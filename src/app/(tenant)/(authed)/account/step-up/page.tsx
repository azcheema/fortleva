import type { Metadata } from "next";
import { ShieldCheckIcon } from "lucide-react";
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
 *
 * Single purpose, and it looks it: one centred column, one glyph, one
 * field, one button. Nothing else is on the page to click, because
 * anything else would be a way to lose the thread of what the member
 * was doing. The closing line is anti-phishing, not decoration —
 * someone who arrives here from a link they did not expect should read
 * that Fortleva never asks for this code anywhere else.
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
      <div className="mx-auto flex max-w-sm flex-col gap-4 py-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="inline-flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <ShieldCheckIcon aria-hidden="true" className="size-5" />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
          </div>
        </div>
        <SectionCard>
          <StepUpForm next={next} />
        </SectionCard>
        <p className="text-center text-xs text-muted-foreground">{t("reassurance")}</p>
      </div>
    </Page>
  );
}
