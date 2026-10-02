/* eslint-disable no-restricted-imports -- sanctioned auth-layer consumer
   of the raw client (TENANCY.md §6.3): User and TwoFactor are AUTH-class
   rows, read after a failed replacement. */
import { APIError } from "better-auth/api";

import { runtimeClient } from "@/db/client";

import { mailFactorReplaced, signOutOtherDevices } from "./account-security";
import { onFactorReplaced } from "./audit-hooks";
import { auth } from "./index";
import { runWithReplaceIntent } from "./replace-intent";
import { verifyStepUpWithHeaders } from "./step-up";

export type ReplaceOutcome =
  | {
      readonly ok: true;
      readonly totpUri: string;
      readonly backupCodes: readonly string[];
      readonly method: "totp" | "backup_code";
      readonly sessionsEnded: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "no_session"
        | "not_enrolled"
        | "wrong_password"
        | "invalid_code"
        | "rate_limited"
        | "failed"
        /** Better Auth deleted the old factor and failed to write the new one. */
        | "factor_lost";
    };

/**
 * REPLACE THE CALLER'S OWN AUTHENTICATOR (slice 84, founder decision C50)
 * — "I lost my phone", or "I am moving to a new one". `/account`'s
 * replacement action is its one caller; this module is the replacement
 * marker's one opener (`./factor-intent.test.ts`).
 *
 * WHAT IT DEMANDS, IN THIS ORDER, and the order is the point:
 *
 *   1. **the password**, checked on its own first (`verifyPassword` —
 *      a wrong one spends nothing but the per-IP sign-in budget the
 *      endpoint is already on). The step-up below CONSUMES a backup code,
 *      so a password checked after it would burn one of the codes this
 *      member is down to on every typo — the trap
 *      `backup-codes-actions.ts` describes, which is why that form takes
 *      only live codes. Checked first, a typo costs nothing.
 *   2. **proof of the CURRENT factor** — a live code from the app, or an
 *      unused backup code when the phone is gone — through the one step-up
 *      helper (its budget, its audit of a wrong code, the stamp it writes).
 *   3. **the replacement**: Better Auth's `enable` inside the replacement
 *      marker (./replace-intent). The factor guard refuses `enable` over an
 *      enrolled factor to everything else, and lets this through only with
 *      the marker AND the stamp step 2 just wrote — so a password alone, or
 *      a session alone, opens nothing. `enable` checks the password again
 *      itself, which is why a refusal there is unexpected.
 *
 * WHAT HAPPENS: the old secret and backup codes are gone the moment
 * `enable` returns, and the new ones are live (Better Auth writes the row
 * verified, because the one it replaced was). So the new URI and codes go
 * back to the caller whatever else fails — shown once — and only then do
 * every OTHER session, trusted-device mark and sign-in waiting for a code
 * end (`signOutOtherDevices`), an audit row get written and the account's
 * address get mailed, each caught on its own. The calling session stays:
 * it is the one that just proved both factors, and its holder still has
 * to scan the new code.
 */
export async function replaceOwnFactor(input: {
  readonly headers: Headers;
  readonly code: string;
  readonly password: string;
}): Promise<ReplaceOutcome> {
  const session = await auth.api.getSession({ headers: input.headers });
  if (!session) return { ok: false, reason: "no_session" };

  // 1. The password, before anything can be spent.
  try {
    await auth.api.verifyPassword({ body: { password: input.password }, headers: input.headers });
  } catch (error) {
    if (error instanceof APIError && error.status === "TOO_MANY_REQUESTS") return { ok: false, reason: "rate_limited" };
    return { ok: false, reason: "wrong_password" };
  }

  // 2. Proof of the current factor (a backup code is spent here).
  const verified = await verifyStepUpWithHeaders(input.code, input.headers);
  if (!verified.ok) return { ok: false, reason: verified.reason };

  // 3. The replacement, inside the marker — opened here, after the proof.
  let totpUri: string;
  let backupCodes: string[];
  try {
    const result = await runWithReplaceIntent(() =>
      auth.api.enableTwoFactor({ body: { password: input.password }, headers: input.headers }),
    );
    totpUri = result.totpURI;
    backupCodes = result.backupCodes;
  } catch (error) {
    // A backup code given in step 2 is already spent, and the screen says
    // so. Not a rate limit: the limiter spares this call (./rate-limit-hook).
    // What is left is a password changed in between, which refuses before
    // writing — or a DATABASE failure, which may not: Better Auth deletes
    // the old row and creates the new one with no transaction around them,
    // and a failure between the two leaves the flag set with no factor —
    // the lockout ./factor-guard describes (the fix-pass review's low). So
    // look: if that is the state, say "ask an owner", whose reset is the
    // way out, rather than "try another code", which would only fail.
    const [user, factor] = [
      await runtimeClient.user.findUnique({ where: { id: session.user.id }, select: { twoFactorEnabled: true } }),
      await runtimeClient.twoFactor.findUnique({ where: { userId: session.user.id }, select: { id: true } }),
    ];
    if (user?.twoFactorEnabled && factor === null) {
      console.error(`[auth] factor replacement left user ${session.user.id} enrolled with no factor`, error);
      return { ok: false, reason: "factor_lost" };
    }
    return { ok: false, reason: "failed" };
  }

  // PAST THIS LINE THE NEW FACTOR IS LIVE AND THE OLD ONE IS DEAD, so
  // nothing may stop the URI and codes reaching the caller — the reissue
  // action's rule. Each step below is caught on its own, loudly: a session
  // left alive is a real cost; a member locked out of their own account is
  // a worse one.
  const userId = session.user.id;
  let sessionsEnded = 0;
  try {
    sessionsEnded = await signOutOtherDevices(userId, session.session.id);
  } catch (error) {
    console.error(`[auth] other sessions not ended after a factor replacement for user ${userId}`, error);
  }
  try {
    await onFactorReplaced(userId, verified.method, sessionsEnded, (session.user as { platformRole?: unknown }).platformRole);
  } catch (error) {
    console.error("[auth-audit] factor_replaced failed", error);
  }
  try {
    await mailFactorReplaced(session.user.email, new Date(), verified.method);
  } catch (error) {
    console.error(`[auth] factor-replaced mail not sent for user ${userId}`, error);
  }
  return { ok: true, totpUri, backupCodes, method: verified.method, sessionsEnded };
}
