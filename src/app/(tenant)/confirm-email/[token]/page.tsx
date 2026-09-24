import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { confirmEmailHolder } from "@/auth/member-screens";
import { EMAIL_CONFIRMATION_TTL_SECONDS } from "@/auth/recovery-policy";
import { safeNext } from "@/lib/safe-next";

import { ConfirmForm } from "./confirm-form";
import { ConfirmedState } from "./confirmed-state";
import { ConfirmUnavailable } from "./confirm-unavailable";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.confirmEmail");
  return { title: t("metaTitle") };
}

/**
 * `/confirm-email/[token]` — where the member plane's confirmation mail
 * lands (`confirmEmailUrl`, src/auth/member-recovery.ts), and the ONLY place
 * a member's address is confirmed: Better Auth's own `/verify-email` is
 * refused on this plane (src/auth/closed-endpoints.ts).
 *
 * **WHY A PAGE, AND WHY IT ASKS FOR THE PASSWORD.** The library's endpoint
 * confirmed on the link alone, and on a bare GET — which is what a mail
 * scanner does to every link in a business inbox. Worse, the link alone is
 * exactly what the OWNER of an address holds when a STRANGER signed it up
 * first with a password of their own: confirming it turned the stranger's
 * password on. So this page changes NOTHING on GET — `confirmEmailHolder`
 * verifies the link and reads whose address it is, and a confirmation link is
 * a stateless JWT, so the read consumes nothing — and the form confirms only
 * with the account's password as well (`confirmMemberEmail`), then signs the
 * person in. The stranger lacks the mailbox and the owner lacks the stranger's
 * password, so neither can confirm such an account; the owner's way in is
 * "Forgot your password?", which replaces the stranger's.
 *
 * THREE STATES, drawn before any button, so nobody is offered a press the
 * action is certain to refuse:
 *  - the link cannot be used → `ConfirmUnavailable`, whose way forward is
 *    signing in (which is how a new link is sent — C30 (b));
 *  - the address is confirmed already → `ConfirmedState`, and sign-in;
 *  - otherwise → the address, a password field, and the button.
 *
 * **PUBLIC BY A PREFIX EXEMPTION** (`CONFIRM_EMAIL_PREFIX`, src/proxy.ts): the
 * person has no session — nobody can have one before confirming. The page HAS
 * a Server Action, so the exemption opens that POST as well as the render;
 * the action verifies the link again, checks the password and is limited per
 * network like sign-in (`./actions.ts`). The render itself is not metered: it
 * writes nothing, and it reaches the database only for a link whose signature
 * has verified — one somebody was mailed.
 */
export default async function ConfirmEmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { token } = await params;
  const { next: requested } = await searchParams;
  const next = safeNext(typeof requested === "string" ? requested : null, "/home");
  const minutes = Math.round(EMAIL_CONFIRMATION_TTL_SECONDS / 60);

  const holder = await confirmEmailHolder(token);
  if (!holder) return <ConfirmUnavailable minutes={minutes} next={next} />;

  if (holder.confirmed) {
    const t = await getTranslations("auth.confirmEmail");
    return (
      <ConfirmedState
        title={t("alreadyTitle")}
        description={t.rich("already", {
          email: holder.email,
          strong: (chunks) => <strong className="font-medium text-foreground">{chunks}</strong>,
        })}
        next={next}
      />
    );
  }

  return <ConfirmForm token={token} email={holder.email} next={next} minutes={minutes} />;
}
