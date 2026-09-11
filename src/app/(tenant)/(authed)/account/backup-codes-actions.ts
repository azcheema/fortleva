"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { auth } from "@/auth";
import { onBackupCodesReissued } from "@/auth/audit-hooks";
import { runWithReissueIntent } from "@/auth/reissue-intent";
import { requireMemberSession } from "@/auth/session";
import { verifyStepUpWithHeaders } from "@/auth/step-up";
import { enrolUrl } from "@/authz/redirects";
import { allow } from "@/ratelimit";

/**
 * SIX DIGITS, i.e. a live TOTP — never a backup code, and the narrowness
 * is the point. `verifyStepUpWithHeaders` routes anything that is not
 * six digits to `verifyBackupCode`, which CONSUMES the code, and it runs
 * before `generateBackupCodes` ever checks the password. Accepting
 * backup codes here would mean every mistyped password permanently spent
 * one of the recovery codes the caller came to replace — the worst
 * possible failure mode for this particular form. A TOTP is time-based
 * and costs nothing to get wrong.
 *
 * Someone who has lost the authenticator AND the codes cannot use this
 * flow, and no flow can help them: that is the database recovery
 * documented in src/auth/factor-guard.ts.
 */
const schema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
  password: z.string().min(1),
});

export type ReissueState =
  | { ok: true; codes: string[] }
  | { ok: false; message: string }
  | null;

/**
 * Reissue the member's backup codes (SECURITY.md §3.5).
 *
 * WHY THIS EXISTS AT ALL: backup codes are shown once, during enrolment,
 * and nothing in this product could produce them again. Someone who
 * loses them keeps working — right up until they lose the authenticator
 * too, at which point they are locked out of every plane with no
 * recovery short of editing the database. That gap was found the way
 * gaps like it usually are: the founder had lost theirs.
 *
 * WHAT IT DEMANDS, and why it is stronger than the endpoint underneath:
 * Better Auth's `/two-factor/generate-backup-codes` is satisfied by a
 * session plus the account PASSWORD. Reissuing codes from a password
 * alone would hand a password thief a permanent set of second factors,
 * which is the whole control inverted. So this action requires BOTH:
 *
 *   1. a live code from the CURRENT authenticator (or an existing backup
 *      code) — verified here, in this request, by the same helper the
 *      step-up flow uses, which stamps `Session.mfaVerifiedAt`; and
 *   2. the account password, which the endpoint asks for itself.
 *
 * `guardFactorMutations` (src/auth/factor-guard.ts) then allows the call
 * only because of the stamp step 1 just wrote, inside a tight window.
 * Remove step 1 and the guard refuses — the two halves are meant to be
 * read together.
 *
 * The principal comes from the request cookie, never from the form.
 */
export async function reissueBackupCodesAction(
  _prev: ReissueState,
  formData: FormData,
): Promise<ReissueState> {
  const t = await getTranslations("account.backupCodes");
  const parsed = schema.safeParse({
    code: formData.get("code"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { ok: false, message: t("enterBoth") };

  const session = await requireMemberSession();

  // Same per-user budget as step-up: this verifies a second factor, so
  // it is a code-guessing surface like any other (SECURITY.md §3.7).
  if (!(await allow("auth.step_up", session.user.id))) {
    return { ok: false, message: t("tooManyAttempts") };
  }

  const requestHeaders = await headers();

  // 1. Prove possession of the CURRENT factor. This is what stamps the
  //    session and thereby unlocks the guard for the call below.
  const verified = await verifyStepUpWithHeaders(parsed.data.code, requestHeaders);
  if (!verified.ok) {
    if (verified.reason === "no_session") redirect("/login");
    if (verified.reason === "not_enrolled") redirect(enrolUrl("/account"));
    if (verified.reason === "rate_limited") return { ok: false, message: t("tooManyAttempts") };
    return { ok: false, message: t("mismatch") };
  }

  // 2. The endpoint asks for the password itself; a wrong one lands here
  //    as a thrown APIError rather than a rejected promise value.
  let codes: string[];
  try {
    // The marker is what lets guardFactorMutations tell this call apart
    // from a request to the same endpoint. It is opened HERE, after the
    // factor has been verified above, and closes with this call.
    const result = await runWithReissueIntent(() =>
      auth.api.generateBackupCodes({
        body: { password: parsed.data.password },
        headers: requestHeaders,
      }),
    );
    codes = (result as { backupCodes?: string[] }).backupCodes ?? [];
  } catch {
    // Deliberately one message for both "wrong password" and any other
    // refusal: this form has already proven a second factor, so telling
    // a caller which half they got wrong buys them nothing we want to
    // give. Never log the password or the codes.
    return { ok: false, message: t("failed") };
  }
  if (codes.length === 0) return { ok: false, message: t("failed") };

  // PAST THIS LINE THE NEW CODES EXIST AND THE OLD ONES ARE DEAD, so
  // nothing may stop them reaching the screen — they are shown once and
  // cannot be reissued without another live factor. The audit call used
  // to sit inside the try above, un-guarded, which meant a hiccup in the
  // membership fan-out returned "could not issue new codes" AFTER Better
  // Auth had already committed the new set: the caller would be left
  // holding neither. A missing audit row is a real cost; it is not worth
  // locking someone out of their own account to avoid.
  try {
    await onBackupCodesReissued(session.user.id);
  } catch (e) {
    console.error("[auth-audit] backup_codes_reissued failed", e);
  }
  return { ok: true, codes };
}
