import { redirect } from "next/navigation";

import { requireMemberSession } from "@/auth/session";
import { enrolUrl, safeNextPath } from "@/authz/redirects";

import { StepUpForm } from "./step-up-form";

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

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold">Confirm it&apos;s you</h1>
        <p className="mt-1 text-sm text-neutral-600">
          This action is sensitive. Enter a fresh code from your authenticator app to
          continue.
        </p>
      </div>
      <StepUpForm next={next} />
    </main>
  );
}
