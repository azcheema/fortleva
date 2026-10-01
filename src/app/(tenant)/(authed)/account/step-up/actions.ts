"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { requireMemberSession } from "@/auth/session";
import { verifyStepUpWithHeaders } from "@/auth/step-up";
import { enrolUrl, safeNextPath } from "@/authz/redirects";

const schema = z.object({
  code: z.string().trim().min(6).max(32),
  next: z.string().optional(),
});

export type StepUpFormState = { ok: false; message: string } | null;

/**
 * Step-up server action (SECURITY.md §3.5): verify the current member's
 * second factor and stamp the session, then continue to `next`. The
 * user/session are taken from the request cookie — never from the form.
 */
export async function verifyStepUpAction(
  _prev: StepUpFormState,
  formData: FormData,
): Promise<StepUpFormState> {
  const t = await getTranslations("account.stepUp");
  const parsed = schema.safeParse({
    code: formData.get("code"),
    next: formData.get("next") ?? undefined,
  });
  if (!parsed.success) return { ok: false, message: t("enterCode") };
  const next = safeNextPath(parsed.data.next);

  // The per-user attempt budget is spent inside `verifyStepUpWithHeaders`
  // (slice 83), which answers `rate_limited` when it is gone.
  await requireMemberSession();

  const result = await verifyStepUpWithHeaders(parsed.data.code, await headers());
  if (!result.ok) {
    if (result.reason === "no_session") redirect("/login");
    if (result.reason === "not_enrolled") redirect(enrolUrl(next));
    // A 429 from the per-IP limiter is not a wrong code. Reporting it as
    // one tells a member on a shared egress IP that a CORRECT code was
    // wrong, so they retry and burn the per-user budget too — turning a
    // shared-IP inconvenience into their own lockout.
    if (result.reason === "rate_limited") return { ok: false, message: t("tooManyAttempts") };
    return { ok: false, message: t("mismatch") };
  }
  redirect(next);
}
