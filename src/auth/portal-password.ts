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
 * Any other failure — a wrong password, an ended session, the library's
 * own refusal — is `wrong`: the door stays shut, and the page says one
 * thing for all of them.
 */
export async function checkContactPassword(headers: Headers, password: string): Promise<"ok" | "wrong" | "limited"> {
  if (typeof password !== "string" || password.length === 0 || password.length > 1024) return "wrong";
  try {
    await portalAuth.api.verifyPassword({ body: { password }, headers });
    return "ok";
  } catch (error) {
    if (error instanceof APIError && error.status === "TOO_MANY_REQUESTS") return "limited";
    return "wrong";
  }
}
