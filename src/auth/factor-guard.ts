/* eslint-disable no-restricted-imports -- sanctioned auth-layer consumer
   of the raw client (TENANCY.md §6.3), same as src/auth/index.ts. */
import { APIError } from "better-auth/api";

import { sessionCookieName, type Plane } from "@/config";
import { runtimeClient } from "@/db/client";

/**
 * A PASSWORD MUST NEVER BE ABLE TO MUTATE A SUPERADMIN'S SECOND FACTOR.
 *
 * The platform gate (./platform-gate) is only as strong as the factor it
 * checks, and Better Auth's two-factor endpoints are guarded by a session
 * plus the account password — never by the EXISTING factor. (Some of them
 * do use `sensitiveSessionMiddleware`, e.g. /two-factor/disable; that
 * requires an authoritative session, not a fresh one, so it does not
 * change the argument — an earlier version of this comment said the
 * middleware was unused, which was wrong.) Four of them defeat the gate
 * outright for whoever holds the password:
 *
 *   /two-factor/disable               removes the factor entirely
 *   /two-factor/enable                on an account that ALREADY has a
 *                                     verified factor, deletes the secret
 *                                     and backup codes and recreates the
 *                                     row as verified — a silent swap for
 *                                     an authenticator the caller owns
 *   /two-factor/get-totp-uri          hands back the decrypted secret
 *   /two-factor/generate-backup-codes reissues the codes
 *
 * THE GUARD KEYS ON THE USER, NOT THE PLANE, and that is the whole
 * point. An earlier version of this lived only on the platform instance,
 * which achieved nothing: `TwoFactor.userId` is `@unique`, so a
 * SUPERADMIN has exactly ONE factor row and the member instance's
 * `/api/auth/two-factor/disable` deletes the very same row — the weak
 * plane (7-day rolling, sameSite=lax, no MFA requirement) mutating the
 * strong plane's credential. That is the same "both instances share one
 * row set" reasoning that removed `admin()`; it applies here too, so
 * this runs on BOTH instances.
 *
 * Ordinary members are untouched: their 2FA stays self-service. Only a
 * `platformRole === "SUPERADMIN"` row is frozen.
 *
 * WHAT THIS DELIBERATELY STILL ALLOWS: the FIRST enrolment, on an
 * account with no verified factor yet, is still bootstrapped from the
 * password — that window is real, it is why the ramp in ops/login
 * exists, and it closes permanently the moment a factor is verified.
 * SECURITY.md §3.5 records it as bounded rather than claiming it is
 * closed.
 *
 * ROTATION AND RECOVERY ARE THEREFORE NOT SELF-SERVICE. A lost
 * authenticator is recovered with a BACKUP CODE. Replacing the factor
 * outright is a database operation — and it is TWO statements, which is
 * worth stating exactly, because getting it wrong bricks the console:
 *
 *     DELETE FROM two_factor WHERE user_id = $1;
 *     UPDATE "user" SET two_factor_enabled = false WHERE id = $1;
 *
 * The second is not optional. Better Auth's sign-in hook decides whether
 * to demand a factor from `user.twoFactorEnabled`, NOT from the row's
 * existence. Delete the row alone and sign-in still deletes the fresh
 * session and demands a code, both verify endpoints answer
 * TOTP_NOT_ENABLED, no session is ever created, `mfaVerifiedAt` is never
 * stamped — and `/two-factor/enable` has no session to run under. The
 * account would be permanently locked out with no way back through any
 * request. Clear the flag and the account falls back into the
 * first-enrolment ramp, which is the intended recovery path.
 */
const GUARDED_PATHS = new Set([
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/generate-backup-codes",
]);

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
  if (!GUARDED_PATHS.has(ctx.path)) return;

  const token = sessionTokenFrom(ctx.headers, plane);
  const session = token
    ? await runtimeClient.session.findUnique({
        where: { token },
        select: { user: { select: { id: true, platformRole: true } } },
      })
    : null;
  // Fails CLOSED: without a readable session we cannot establish whose
  // factor this would touch, so it does not happen.
  if (!session) throw new APIError("UNAUTHORIZED", { message: "Sign in again." });

  // Ordinary members keep self-service 2FA. Only the platform principal
  // is frozen, because only its factor guards `app_platform`.
  if (session.user.platformRole !== "SUPERADMIN") return;

  if (ctx.path === "/two-factor/enable") {
    const existing = await runtimeClient.twoFactor.findUnique({
      where: { userId: session.user.id },
      select: { verified: true },
    });
    // First enrolment is the bounded window; replacement never is.
    if (!existing?.verified) return;
    throw new APIError("FORBIDDEN", {
      message: "A second factor is already enrolled and cannot be replaced from here.",
    });
  }

  throw new APIError("FORBIDDEN", {
    message: "This account's second factor cannot be changed from here.",
  });
}
