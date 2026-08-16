/* eslint-disable no-restricted-imports -- sanctioned auth-layer consumer
   of the raw client (TENANCY.md §6.3): Session is an AUTH-class row. */
import { APIError } from "better-auth/api";

import { runtimeClient } from "@/db/client";

import { auth } from "./index";

/**
 * Step-up ("sudo") verification (SECURITY.md §3.5/§3.6, AUTHZ.md §7.5):
 * re-verify the CURRENT signed-in member's second factor and stamp
 * Session.mfaVerifiedAt = now. Delegates the actual check to the
 * twoFactor plugin's own endpoints called server-side with the request
 * headers — the plugin resolves the signed-in session from the cookie,
 * decrypts the stored secret and verifies (TOTP) or consumes (backup
 * code) exactly as at sign-in, so we never re-implement crypto here.
 * A 6-digit code is tried as TOTP; anything else as a backup code.
 */

export type StepUpResult =
  | { ok: true; verifiedAt: Date; method: "totp" | "backup_code" }
  | { ok: false; reason: "no_session" | "not_enrolled" | "invalid_code" };

const isTotpShape = (code: string): boolean => /^\d{6}$/.test(code);

export async function verifyStepUpWithHeaders(
  code: string,
  headers: Headers,
): Promise<StepUpResult> {
  const session = await auth.api.getSession({ headers });
  if (!session) return { ok: false, reason: "no_session" };
  const enrolled = (session.user as { twoFactorEnabled?: boolean }).twoFactorEnabled === true;
  if (!enrolled) return { ok: false, reason: "not_enrolled" };

  const trimmed = code.replace(/\s+/g, "");
  const method = isTotpShape(trimmed) ? "totp" : "backup_code";
  try {
    if (method === "totp") {
      await auth.api.verifyTOTP({ body: { code: trimmed }, headers });
    } else {
      await auth.api.verifyBackupCode({ body: { code: trimmed }, headers });
    }
  } catch (e) {
    if (e instanceof APIError) return { ok: false, reason: "invalid_code" };
    throw e;
  }

  const verifiedAt = new Date();
  await runtimeClient.session.update({
    where: { id: session.session.id },
    data: { mfaVerifiedAt: verifiedAt },
  });
  return { ok: true, verifiedAt, method };
}
