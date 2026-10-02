"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { replaceOwnFactor } from "@/auth/factor-replace";
import { requireMemberSession } from "@/auth/session";
import { verifyStepUpWithHeaders } from "@/auth/step-up";
import { enrolUrl } from "@/authz/redirects";

/**
 * Either proof of the current factor: six digits from the app (a member
 * moving to a new phone), or an unused backup code (a member whose phone is
 * gone — they signed in with one, and this asks for ANOTHER). Bounded,
 * because it is the caller's string.
 */
const schema = z.object({
  code: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

export type ReplaceState =
  | { ok: true; totpUri: string; backupCodes: readonly string[] }
  | { ok: false; message: string }
  | null;

/**
 * Replace the member's own authenticator (slice 84, founder decision C50).
 * The door, its order — the password before the code, so a typo never
 * spends a backup code — and its after-effects are `replaceOwnFactor`'s
 * (`@/auth/factor-replace`); this turns the outcome into words. The
 * principal comes from the request cookie, never from the form.
 */
export async function replaceFactorAction(_prev: ReplaceState, formData: FormData): Promise<ReplaceState> {
  const t = await getTranslations("account.replace");
  const parsed = schema.safeParse({ code: formData.get("code"), password: formData.get("password") });
  if (!parsed.success) return { ok: false, message: t("enterBoth") };
  await requireMemberSession();

  const outcome = await replaceOwnFactor({ headers: await headers(), ...parsed.data });
  if (outcome.ok) return { ok: true, totpUri: outcome.totpUri, backupCodes: outcome.backupCodes };
  switch (outcome.reason) {
    case "no_session":
      redirect("/login");
    case "not_enrolled":
      redirect(enrolUrl("/account"));
    case "wrong_password":
      // Saying WHICH half was wrong gives nothing away: `/verify-password`
      // answers exactly this to any session already.
      return { ok: false, message: t("wrongPassword") };
    case "rate_limited":
      return { ok: false, message: t("tooManyAttempts") };
    case "invalid_code":
      return { ok: false, message: t("mismatch") };
    case "failed":
      return { ok: false, message: t("failed") };
    case "factor_lost":
      return { ok: false, message: t("factorLost") };
  }
}

export type ConfirmState = { ok: boolean; message: string } | null;

const confirmSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/) });

/**
 * "The new app works": a code from the NEW authenticator, through the
 * step-up. Nothing is changed by it — the replacement already happened —
 * so it only tells the member their scan took. SIX DIGITS ONLY: a backup
 * code here would be spent for nothing.
 */
export async function confirmNewFactorAction(_prev: ConfirmState, formData: FormData): Promise<ConfirmState> {
  const t = await getTranslations("account.replace");
  const parsed = confirmSchema.safeParse({ code: formData.get("code") });
  if (!parsed.success) return { ok: false, message: t("enterNewCode") };
  await requireMemberSession();
  const verified = await verifyStepUpWithHeaders(parsed.data.code, await headers());
  if (verified.ok) return { ok: true, message: t("done") };
  if (verified.reason === "no_session") redirect("/login");
  if (verified.reason === "rate_limited") return { ok: false, message: t("tooManyAttempts") };
  return { ok: false, message: t("newMismatch") };
}
