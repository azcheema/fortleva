"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { portalAuth, portalPasswordPolicy } from "@/auth/portal";
import { acceptContactInvite, previewContactInvite } from "@/clients/contact-invite-token";
import { DomainError } from "@/lib/domain-error";
import { field, type FormResult } from "@/lib/server-actions";
import { allowStrict, clientIp } from "@/ratelimit";

/**
 * THE ONE WRITE IN THIS PRODUCT THAT COMES FROM SOMEBODY WITH NO
 * SESSION. Everything else — every other action, every portal write —
 * sits behind a cookie. Here the token IS the credential, and the reader
 * of this file should keep that in mind for all of it.
 *
 * **IT MUST NOT USE `runAction` / `runForm`.** Those run
 * `handleAuthzRedirect`, which is the MEMBER plane's MFA step-up, and
 * they map a `DomainError` to its own code's message — which is exactly
 * the distinction this page exists not to make. It does not use
 * `runPortalForm` either, close as that is: that runner needs a portal
 * context to have been established, and the whole point of this path is
 * that there is not one yet.
 *
 * **ONE REFUSAL FOR EVERY BAD TOKEN** (founder decision, 2026-09-23).
 * Expired, already consumed, superseded by a newer invitation, never
 * existed, belonging to another tenant — the service already collapses
 * all five into one `INVALID_INPUT` and keeps the reason in the server
 * log, and this action must not undo that at the last inch by rendering
 * a different sentence for any of them. Nobody learns whether a link was
 * ever real.
 *
 * **PURE VALIDATION RUNS FIRST, AND THAT ORDER IS DELIBERATE.** The
 * length and confirm checks touch no database, write no audit row and
 * charge nothing, so they are free to be as helpful as they like — a
 * visitor who mistypes their confirmation is told exactly that. Only
 * once the input could plausibly be accepted does the request spend from
 * the guessing budget and reach `previewContactInvite`, whose every call
 * appends a `platform.system_job` row to an append-only table. Ordering
 * it the other way would have charged a real invitee's own typing
 * against the budget meant for somebody grinding tokens.
 */
export async function acceptPortalInviteAction(
  _prev: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const t = await getTranslations("auth.portalInvite");
  const token = field(formData, "token") ?? "";
  const password = formData.get("password");
  const confirm = formData.get("confirm");
  const typed = typeof password === "string" ? password : "";
  const repeated = typeof confirm === "string" ? confirm : "";

  // FREE, so it may be specific. See the header.
  //
  // TWO MESSAGES, because one of them was WRONG: a single
  // `passwordLength` sentence told somebody who had pasted a 200-character
  // passphrase to "use at least 12 characters", which is advice they had
  // already followed twenty times over. The maximum exists so that an
  // unauthenticated caller cannot hand scrypt a megabyte, and a visitor
  // who meets it deserves to be told which end they are at.
  const { min, max } = await portalPasswordPolicy();
  if (typed.length < min) return { ok: false, message: t("passwordShort", { min }) };
  if (typed.length > max) return { ok: false, message: t("passwordLong", { max }) };
  if (typed !== repeated) return { ok: false, message: t("mismatch") };

  const requestHeaders = await headers();
  if (!(await allowStrict("portal.invite_accept", clientIp(requestHeaders)))) {
    // THE SAME SENTENCE AS EVERY OTHER REFUSAL. "You have tried too many
    // times" would tell a token-grinder that they had found the wall and
    // exactly where it is; the page simply stops answering, which is
    // what the founder's decision says it should do.
    return { ok: false, message: t("refused") };
  }

  let email: string;
  try {
    // Read the address from the TOKEN, never from the form. The form is
    // filled in by whoever is holding the link, and this address is what
    // the session below is minted for.
    const preview = await previewContactInvite(token);
    if (!preview || preview.status !== "PENDING" || preview.expired) {
      // THE SAME SENTENCE TO THE VISITOR, A DISTINGUISHABLE ONE TO THE
      // LOG. The page must not say which of the four it was; an operator
      // asked "my link does not work" must be able to find out, and
      // `previewContactInvite` answering null covers an unknown token,
      // another tenant's, and — since this slice's review — an
      // invitation whose bound address no longer matches the contact's,
      // which is the one case worth noticing twice.
      console.warn(
        `[portal] invite acceptance refused: ${
          !preview ? "unresolvable" : preview.expired ? "expired" : `status=${preview.status}`
        }`,
      );
      return { ok: false, message: t("refused") };
    }
    email = preview.email;
    await acceptContactInvite({ token, password: typed });
  } catch (error) {
    if (error instanceof DomainError) {
      // Structured enough to grep and naming nobody — the same contract
      // as `runPortalAction`'s log line.
      console.warn(`[portal] invite acceptance refused: ${error.code}`);
      return { ok: false, message: t("refused") };
    }
    // A dead connection or a bug belongs on the error boundary. A page
    // that says "ask your agency for a new link" when the database is
    // down has sent somebody to complain about a link that is fine.
    throw error;
  }

  // **THE SESSION, WHICH `acceptContactInvite` DELIBERATELY DOES NOT
  // MINT.** It writes the credential and stops there, so this is the
  // only place the plaintext password still exists and the only moment
  // it can be spent. Three things make the call work here and nowhere
  // else: a direct `api` call carries no `ctx.request`, so Better Auth's
  // form-CSRF middleware no-ops; `nextCookies()` copies the set-cookie
  // through `next/headers`, which throws and is SWALLOWED in an RSC
  // render but succeeds in a Server Action; and the instance's
  // `session.create` hook admits only the literal ACTIVE, which the
  // acceptance above has just committed.
  //
  // The real request headers are passed on purpose: the instance's
  // `before` hook rate-limits on `portal:${clientIp(...)}`, and without
  // them every acceptance in the product would share one `portal:unknown`
  // bucket and the tenth in ten minutes would lock out a real contact.
  let signedIn = true;
  try {
    await portalAuth.api.signInEmail({
      body: { email, password: typed },
      headers: requestHeaders,
    });
  } catch (error) {
    // THE PASSWORD IS SET EITHER WAY — the acceptance committed before
    // this line — so a failure here is not a failed acceptance and must
    // not be reported as one. It sends them to the sign-in form with the
    // credential they have just chosen, which is the whole reason that
    // form had to exist before this page could ship.
    console.warn("[portal] invite accepted but auto sign-in failed", error);
    signedIn = false;
  }
  // OUTSIDE the try: `redirect()` works by throwing, and a catch that
  // swallowed it would turn a navigation into a silent success.
  redirect(signedIn ? "/portal" : "/portal/login");
}
