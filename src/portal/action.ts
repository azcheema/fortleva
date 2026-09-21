import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { DomainError, type DomainErrorCode } from "@/lib/domain-error";
import type { FormResult } from "@/lib/server-actions";

/**
 * THE PORTAL'S SERVER-ACTION RUNNER — `runAction()`'s opposite number,
 * and the difference between them is the whole reason this file exists.
 *
 * `src/lib/server-actions.ts` maps an `AuthzError` to one of three
 * distinct messages (NOT_FOUND / FORBIDDEN / NOT_ENTITLED) and a
 * `DomainError` to its own code's message, because on the member plane
 * every one of those is a fact about the reader's OWN agency and the
 * reader is entitled to it. On the contact plane none of that holds.
 * `src/portal/render.ts` already says it for READS: a contact told
 * NOT_ENTITLED has been told their agency's plan is missing a module, a
 * contact told DISABLED_BY_TENANT has been told somebody at the agency
 * switched something off, and a contact who can tell FORBIDDEN from
 * NOT_FOUND can map which projects exist. A write is not different in
 * kind — it is the same disclosure with a submit button in front of it
 * — and until this file existed there was nothing stopping the first
 * portal action from reaching for `runAction` because it was the shape
 * already on the clipboard.
 *
 * SO: **every `AuthzError` is one message**, and the reason goes to the
 * server log where the agency's operator can read it and the client
 * cannot. That is `portalReadOrNull`'s bargain, applied to writes.
 *
 * **A `DomainError` IS ALLOW-LISTED, NOT PASSED THROUGH**, which is the
 * half a reader might expect to be automatic and must not be. The code
 * union is shared with the whole product, so a service that grows a new
 * refusal tomorrow would start explaining the agency's internals to a
 * client with no diff on this file. `PORTAL_DISCLOSABLE` is therefore a
 * closed set of codes that are facts about the READER — what they typed,
 * what they have already done — and everything else collapses into the
 * same generic message as an authorization denial.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is redirect. `runAction` sends
 * `MFA_REQUIRED` to a step-up page; there is no second factor on the
 * contact plane (contact MFA is v2, plan §3), `authorizePortal()` never
 * raises it, and a redirect is itself a signal — two different answers
 * to one request are two facts, and an identical failed form is one.
 */

/**
 * The refusals a contact may be told the real reason for: each is
 * something the reader themself did, and each is actionable by them
 * alone. Adding a code here is a disclosure decision, which is why it is
 * a list a reviewer meets rather than a default.
 */
const PORTAL_DISCLOSABLE: ReadonlySet<DomainErrorCode> = new Set<DomainErrorCode>([
  // "You have sent too many requests." — a fact about the reader's own
  // behaviour, and useless to hide: the wait is observable anyway.
  "REQUEST_RATE_LIMITED",
  // "Check what you typed." — their own input, echoed back at them.
  "INVALID_INPUT",
]);

/**
 * The disclosure decision, as a PURE function — so that the rule can be
 * tested over every code the product has without a request context, a
 * translation catalogue or a running Next. `action.test.ts` enumerates
 * them and asserts that exactly two get through; a test that could only
 * reach this rule through `getTranslations` would have covered the
 * translation lookup and not the thing that matters.
 */
export const portalDisclosableCode = (error: unknown): DomainErrorCode | null =>
  error instanceof DomainError && PORTAL_DISCLOSABLE.has(error.code) ? error.code : null;

/**
 * Run a portal server action and turn every failure into a message the
 * contact may see. The success value is the caller's own; a failure is
 * never distinguishable by reason.
 *
 * `label` names the action in the server log and is never rendered —
 * same contract as `portalReadOrNull`, so the two halves of the plane
 * log the same way.
 */
export async function runPortalAction<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const t = await getTranslations("portal.errors");
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    const disclosable = portalDisclosableCode(error);
    if (disclosable) {
      const tDomain = await getTranslations("domainErrors");
      return { ok: false, message: tDomain(disclosable) };
    }
    if (error instanceof AuthzError || error instanceof DomainError) {
      // Structured enough to grep, naming no contact and no row: a
      // server log is not a place to put a client's identity either.
      console.warn(
        `[portal] ${label} refused: ${
          error instanceof AuthzError ? error.reason : error.code
        }${error instanceof AuthzError && error.detail ? ` (${error.detail})` : ""}`,
      );
      return { ok: false, message: t("generic") };
    }
    // A dead connection or a bug still reaches the error boundary: a
    // form that says "something went wrong with your request" when the
    // database is down has told the client something false about their
    // agency.
    throw error;
  }
}

/** The same, for a form whose success is a message. */
export async function runPortalForm(label: string, fn: () => Promise<string>): Promise<FormResult> {
  const r = await runPortalAction(label, fn);
  return r.ok ? { ok: true, message: r.value } : r;
}
