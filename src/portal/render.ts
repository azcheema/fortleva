import { AuthzError } from "@/authz/errors";

/**
 * THE PORTAL'S HTTP SURFACE RENDERS EVERY DENIAL IDENTICALLY, and this
 * is the one place that is true.
 *
 * `authorizePortal()` throws `AuthzError` with a precise reason —
 * NOT_FOUND, FORBIDDEN, NOT_ENTITLED, DISABLED_BY_TENANT,
 * FEATURE_DISABLED — and those reasons are for the audit row, the server
 * log and the test matrix. **They are internal.** A contact told
 * NOT_ENTITLED has been told that their agency's plan does not include a
 * module; a contact told DISABLED_BY_TENANT has been told that someone
 * at their agency switched something off; a contact told FORBIDDEN and a
 * contact told NOT_FOUND can, between them, map which projects exist.
 * None of that is the client's business and all of it is the agency's.
 * (PLAN §0, "what slice 3 inherits", item 1 — handed over by name.)
 *
 * So a portal page never branches on the reason. It calls this, gets
 * `null`, and renders exactly what it renders when the answer is
 * legitimately empty. The two cases are indistinguishable to the reader
 * BY CONSTRUCTION rather than by five branches that agree today.
 *
 * WHY THIS SWALLOWS RATHER THAN REDIRECTS. A redirect is itself a
 * signal, and two different answers to the same request are two facts.
 * An identical 200 with an identical body is one.
 *
 * WHAT THIS DOES NOT COVER, said plainly because the first draft used it
 * as the example and both fresh reviews caught that (2026-09-21):
 * **admission**. A SUSPENDED, REVOKED or unverified contact never
 * reaches a projection — `requirePortalContact()` redirects to
 * /portal/login before the page calls anything, on
 * `portalGateDecision`'s "not_active" / "unverified" / "incomplete".
 * That is deliberate and stays: a contact whose access was withdrawn
 * must lose the session, not keep one in front of a blank page. So the
 * guarantee is exactly "every AUTHORIZATION denial renders identically",
 * not "every refusal does" — and the distinction matters, because what
 * admission discloses is a fact about the READER (their own access is
 * off, which they need in order to ask for it back) while what this
 * function hides is a fact about the AGENCY (its plan, its settings, its
 * other clients). Do not "fix" the redirect to make the sentence
 * simpler.
 *
 * WHY IT ONLY SWALLOWS `AuthzError`. Anything else — a dead connection,
 * a bug in a projection — must still reach the error boundary. A page
 * that renders "nothing shared yet" when the database is down has told
 * the client something false about their agency.
 *
 * THE REASON IS NOT LOST, it is moved: it goes to the server log, where
 * the agency's operator can see it and the client cannot. Audit rows for
 * portal denials are still owed (PLAN §0, slice 1's open item) and land
 * with the path that can activate a contact.
 */
export async function portalReadOrNull<T>(label: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof AuthzError)) throw error;
    // Structured enough to grep, and it names no contact and no row —
    // a server log is not a place to put a client's identity either.
    console.warn(`[portal] ${label} denied: ${error.reason}${error.detail ? ` (${error.detail})` : ""}`);
    return null;
  }
}
