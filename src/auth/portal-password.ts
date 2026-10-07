import { APIError } from "better-auth/api";

import { portalAuth } from "./portal";

/**
 * IS THIS THE SIGNED-IN CONTACT'S PORTAL PASSWORD? (Phase 3V slice 91 —
 * the first half of a client's door to the logins their agency shows them,
 * founder decision C52 (k): their password AND a code mailed each time.)
 *
 * Asked of the portal's OWN instance, against the session the request
 * carries — Better Auth's `/verify-password`, which reads the account of
 * that session and nothing a caller names — so a password is only ever
 * checked for the contact who is signed in. The instance's `before` hook
 * spends the plane's per-IP sign-in budget on it (`/verify-password` is on
 * `RATE_LIMITED_PATHS`, `./rate-limit-hook.ts`), and a refusal there is
 * `limited`, not a wrong password. The per-CONTACT count is the caller's
 * (the vault's portal broker, which counts the check before it is made).
 *
 * `wrong` is ONLY the library's own "invalid password" answer (or nothing
 * typed). Since slice 99 a wrong password is something people are TOLD
 * about — five in a day raise the door's alarm, to the owners and the
 * contact (founder decision C67 (b)) — so a failure that says nothing about
 * the password (a database hiccup, a session ended mid-request) is
 * `unavailable`: the broker records no refusal for it and answers "try
 * again" (the code and the security reviews' low). The check was still
 * counted before it was made, so no bound is loosened.
 */
export async function checkContactPassword(
  headers: Headers,
  password: string,
): Promise<"ok" | "wrong" | "limited" | "unavailable"> {
  if (typeof password !== "string" || password.length === 0 || password.length > 1024) return "wrong";
  try {
    await portalAuth.api.verifyPassword({ body: { password }, headers });
    return "ok";
  } catch (error) {
    if (error instanceof APIError && error.status === "TOO_MANY_REQUESTS") return "limited";
    if (error instanceof APIError && error.body?.code === "INVALID_PASSWORD") return "wrong";
    return "unavailable";
  }
}
