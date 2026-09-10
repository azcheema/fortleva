/* eslint-disable no-restricted-imports -- sanctioned auth-layer consumer
   of the raw client (TENANCY.md §6.3), same as src/auth/index.ts. */
import { APIError } from "better-auth/api";

import { sessionCookieName, type Plane } from "@/config";
import { runtimeClient } from "@/db/client";

import { GUARDED_FACTOR_PATHS, factorMutationVerdict } from "./factor-policy";
import { hasReissueIntent } from "./reissue-intent";

/**
 * A PASSWORD MUST NEVER BE ABLE TO TAKE OVER A SUPERADMIN'S SECOND FACTOR.
 *
 * This module is the IO half; ./factor-policy holds the rule, its
 * reasoning, and its tests.
 *
 * The platform gate (./platform-gate) is only as strong as the factor it
 * checks, and Better Auth's two-factor endpoints are guarded by a session
 * plus the account password — never by the EXISTING factor. Four of them
 * defeat the gate for whoever holds the password: `disable` removes it,
 * `enable` on an enrolled account silently swaps it, `get-totp-uri`
 * returns the secret, `generate-backup-codes` reissues the codes.
 *
 * THE GUARD KEYS ON THE USER, NOT THE PLANE, and that is the whole point.
 * An earlier version lived only on the platform instance, which achieved
 * nothing: `TwoFactor.userId` is `@unique`, so a SUPERADMIN has exactly
 * ONE factor row and the member instance's `/api/auth/two-factor/disable`
 * deletes the very same row — the weak plane (7-day rolling,
 * sameSite=lax, no MFA requirement) mutating the strong plane's
 * credential. That is the same "both instances share one row set"
 * reasoning that removed `admin()`; it applies here too, so this runs on
 * BOTH instances.
 *
 * ROTATION AND RECOVERY. A lost authenticator is recovered with a backup
 * code, and backup codes can be reissued from `/account` on proof of the
 * current factor. Replacing the factor OUTRIGHT is a database operation —
 * and it is TWO statements, which is worth stating exactly, because
 * getting it wrong bricks the account:
 *
 *     DELETE FROM two_factor WHERE user_id = $1;
 *     UPDATE "user" SET two_factor_enabled = false WHERE id = $1;
 *
 * The second is not optional. Better Auth decides whether to demand a
 * factor from `user.twoFactorEnabled`, NOT from the row's existence.
 * Delete the row alone and sign-in still demands a code, both verify
 * endpoints answer TOTP_NOT_ENABLED, no session is ever created, and
 * `/two-factor/enable` has no session to run under — a permanent lockout
 * with no way back through any request. Clearing the flag returns the
 * account to the first-enrolment ramp.
 */

/**
 * The session token as the `session` row stores it. Better Auth puts
 * `<token>.<signature>` in the cookie and looks the row up by the part
 * before the dot. Nothing is verified here — the row lookup IS the
 * check, and a forged value simply finds no row.
 */
const sessionTokenFrom = (headers: Headers | undefined, plane: Plane): string | null => {
  const raw = headers?.get("cookie");
  if (!raw) return null;
  const name = sessionCookieName(plane);
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    // A malformed percent-escape must fail CLOSED, not throw out of the
    // middleware as a 500: `Cookie: __Host-flv.platform=%` is a request
    // anyone can send.
    try {
      return decodeURIComponent(value).split(".")[0] || null;
    } catch {
      return null;
    }
  }
  return null;
};

export async function guardFactorMutations(
  ctx: { readonly path: string; readonly headers?: Headers | undefined },
  plane: Plane,
): Promise<void> {
  if (!GUARDED_FACTOR_PATHS.has(ctx.path)) return;

  const token = sessionTokenFrom(ctx.headers, plane);
  const session = token
    ? await runtimeClient.session.findUnique({
        where: { token },
        select: {
          mfaVerifiedAt: true,
          user: { select: { id: true, platformRole: true } },
        },
      })
    : null;

  const isPlatformPrincipal = session?.user.platformRole === "SUPERADMIN";
  // Looked up only when the answer can matter — the reissue and freeze
  // branches never consult it, so ordinary traffic pays one query, not two.
  const hasVerifiedFactor =
    session && isPlatformPrincipal && ctx.path === "/two-factor/enable"
      ? ((
          await runtimeClient.twoFactor.findUnique({
            where: { userId: session.user.id },
            select: { verified: true },
          })
        )?.verified ?? false)
      : false;

  const verdict = factorMutationVerdict({
    path: ctx.path,
    hasSession: Boolean(session),
    isPlatformPrincipal,
    hasVerifiedFactor,
    mfaVerifiedAt: session?.mfaVerifiedAt ?? null,
    hasReissueIntent: hasReissueIntent(),
    now: Date.now(),
  });

  switch (verdict) {
    case "allow":
      return;
    case "no_session":
      throw new APIError("UNAUTHORIZED", { message: "Sign in again." });
    case "needs_recent_factor":
      throw new APIError("FORBIDDEN", {
        message: "Verify your current authenticator code first.",
      });
    case "already_enrolled":
      throw new APIError("FORBIDDEN", {
        message: "A second factor is already enrolled and cannot be replaced from here.",
      });
    case "frozen":
      throw new APIError("FORBIDDEN", {
        message: "This account's second factor cannot be changed from here.",
      });
  }
}
