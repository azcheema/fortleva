"use server";

import { headers } from "next/headers";

import { auth } from "@/auth";
import { confirmMemberEmail } from "@/auth/member-screens";
import { allowStrict, clientIp } from "@/ratelimit";

export type ConfirmEmailResult =
  | { readonly ok: true; readonly signedIn: boolean }
  | { readonly ok: false; readonly reason: "dead" | "already" | "password" | "tooMany" };

/**
 * **THE MEMBER PLANE'S ONLY WAY TO CONFIRM AN ADDRESS** (C30): the link AND the
 * account's password, then a session. `confirmMemberEmail`
 * (src/auth/member-screens.ts) holds why both are demanded — the pre-account
 * takeover — and Better Auth's own link-only `/verify-email` is refused on
 * this plane.
 *
 * **THIS ACTION IS PUBLIC**, like the page it belongs to: nobody holds a
 * session before confirming, so `CONFIRM_EMAIL_PREFIX` (src/proxy.ts) opens
 * the page's POST as well as its render. So it trusts nothing the call
 * carries: the token is verified again (signature, expiry, algorithm, a plain
 * sign-up link), the password is checked against the account's own
 * credential, and attempts are limited per network — a budget the size of
 * sign-in's (`auth.sign_in`), through `allowStrict`, whose in-process floor
 * holds even while the shared limiter is unprovisioned and `/login`'s own
 * fails open. This is a password check, and it must not be a cheaper one than
 * sign-in; `src/auth/confirm-action-guard.test.ts` pins the order.
 *
 * **THEN IT SIGNS THE PERSON IN**, which Better Auth's confirmation no longer
 * does on this plane: they have just proved the password, and signing in is
 * the next thing they came to do. It goes through the instance's own
 * `signInEmail`, so the session is minted, stamped and audited exactly as a
 * sign-in at `/login` is. If that fails (a limiter, a factor — an unconfirmed
 * account cannot have enrolled one), the address is still confirmed, and the
 * answer says so rather than reporting a failure that did not happen.
 */
export async function confirmEmailAction(token: unknown, password: unknown): Promise<ConfirmEmailResult> {
  if (typeof token !== "string" || typeof password !== "string") return { ok: false, reason: "dead" };
  const requestHeaders = await headers();
  if (!(await allowStrict("auth.sign_in", clientIp(requestHeaders)))) return { ok: false, reason: "tooMany" };

  const outcome = await confirmMemberEmail(token, password);
  if (outcome.kind !== "confirmed") return { ok: false, reason: outcome.kind };

  try {
    const signedIn = await auth.api.signInEmail({
      body: { email: outcome.email, password },
      headers: requestHeaders,
    });
    return { ok: true, signedIn: !("twoFactorRedirect" in signedIn) };
  } catch (error) {
    // No address and no password in the line: it reaches logs.
    console.warn("[auth] address confirmed but the sign-in after it failed", error);
    return { ok: true, signedIn: false };
  }
}
