import { redirect } from "next/navigation";

import { AuthzError } from "./errors";

/**
 * MFA_REQUIRED is a *deferred* denial (AUTHZ.md §7.5): the principal is
 * authorised, only the factor is missing. Pages and server actions
 * translate it into navigation — the step-up page for a stale factor,
 * the account page (with a notice) for a missing enrolment — instead of
 * a generic error. Everything else stays with the caller.
 */

export const STEP_UP_PATH = "/account/step-up";
export const ENROL_PATH = "/account";

/** Only same-origin, absolute-path targets survive — never an open redirect. */
export const safeNextPath = (next: string | null | undefined, fallback = "/dashboard"): string => {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  return next;
};

export const stepUpUrl = (nextPath: string): string =>
  `${STEP_UP_PATH}?next=${encodeURIComponent(safeNextPath(nextPath))}`;

export const enrolUrl = (nextPath: string): string =>
  `${ENROL_PATH}?notice=mfa_required&next=${encodeURIComponent(safeNextPath(nextPath))}`;

/**
 * Pure part: the redirect target for an MFA_REQUIRED AuthzError, or
 * null when the error is not one we translate into navigation.
 */
export function mfaRedirectTarget(e: unknown, nextPath: string): string | null {
  if (!(e instanceof AuthzError) || e.reason !== "MFA_REQUIRED") return null;
  return e.mfaRemedy === "enrol" ? enrolUrl(nextPath) : stepUpUrl(nextPath);
}

/**
 * Call from a `catch` in a page or server action. Redirects (throws
 * NEXT_REDIRECT) for MFA_REQUIRED; returns normally for any other
 * error so the caller can render/return its own denial. Never swallows.
 */
export function handleAuthzRedirect(e: unknown, nextPath: string): void {
  const target = mfaRedirectTarget(e, nextPath);
  if (target) redirect(target);
}
