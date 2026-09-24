"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { AUTH_CONTROL, AuthShell, authLinkClass } from "@/app/(tenant)/login/auth-shell";
import { authClient } from "@/auth/client";
import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFocusHeadingOnChange } from "@/components/use-focus-heading";

/**
 * The request half of the member plane's password reset. `page.tsx` beside
 * it holds why the surface exists; this file holds how it behaves. It is
 * the portal's `forgot-form.tsx` on the member plane, and every rule below
 * is that form's, for that form's reasons.
 *
 * **THE CONFIRMATION IS THE SAME SENTENCE FOR EVERY ADDRESS.** The endpoint
 * answers identically whether the address is a member, a console
 * principal (declined on the instance), an account nobody has confirmed,
 * or nobody at all, and whether a mail actually went — so this form has
 * exactly one success state, conditional in its WORDING ("if … has a
 * Fortleva account"), never in whether it appears.
 *
 * **IT DOES NOT PRETEND A FAILURE WAS A SUCCESS, EITHER.** It distinguishes
 * only whether the REQUEST went through: the rate limiter's refusal and a
 * network failure each say so, because "check your email" over a request
 * that never reached the server sends somebody to wait for a mail that is
 * not coming. Neither depends on the address. A network failure THROWS out
 * of the auth client (no `catchAllError`), so the call is wrapped, and the
 * copy says the connection failed "before we heard back" rather than that
 * nothing was sent.
 *
 * **AND IT SAYS HOW MANY MAILS THERE CAN BE**, because the instance sends at
 * most `cap` an hour to one person (`src/auth/mail-budget.ts`): a fourth
 * request in the hour gets the same confirmation and no mail.
 *
 * **NO `redirectTo` IS SENT.** The instance builds the mailed link itself
 * (`memberResetUrl`), so nothing this form — or a hand-written request —
 * puts in the body can change where the mail points.
 *
 * No eyebrow, like `/login` and `/signup`: on the portal's reset screens it
 * names the plane, and the member plane is the one the bare lockup already
 * is. The confirmation is ANNOUNCED through a live region that exists
 * before it fills, and focus moves to the new heading
 * (`useFocusHeadingOnChange`), because the form the person was using has
 * just disappeared from under them.
 */
export function ForgotPasswordForm({ minutes, cap }: { minutes: number; cap: number }) {
  const t = useTranslations("auth");
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    let err: { status: number } | null;
    try {
      ({ error: err } = await authClient.requestPasswordReset({ email }));
    } catch {
      setBusy(false);
      setError(t("login.unreachable"));
      return;
    }
    setBusy(false);
    if (err) {
      setError(err.status === 429 ? t("memberReset.tooMany") : t("memberReset.failed"));
      return;
    }
    setSentTo(email);
  }

  const sentMessage = sentTo === null ? "" : t("memberReset.sent", { email: sentTo, minutes, cap });
  useFocusHeadingOnChange(sentTo === null ? "form" : "sent");

  return (
    <>
      {sentTo === null ? (
        <AuthShell
          title={t("memberReset.title")}
          description={t("memberReset.subtitle")}
          footer={
            <>
              {t("memberReset.remembered")}{" "}
              <Link className={authLinkClass} href="/login">
                {t("memberReset.signIn")}
              </Link>
            </>
          }
        >
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field label={t("email")} htmlFor="reset-email">
              <Input
                id="reset-email"
                type="email"
                required
                autoComplete="email"
                className={AUTH_CONTROL}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Button type="submit" size="lg" className="mt-2 w-full" disabled={busy}>
              {busy ? t("memberReset.submitting") : t("memberReset.submit")}
            </Button>
          </form>
          {error ? <FormMessage state={{ ok: false, message: error }} /> : null}
        </AuthShell>
      ) : (
        <AuthShell title={t("memberReset.sentTitle")} description={sentMessage}>
          {/* The form is gone, so the page's one primary element is the way
              back — a page that has just told somebody to go and read their
              mail must still offer the door they came in by. */}
          <Button asChild size="lg" className="w-full">
            <Link href="/login">{t("memberReset.signIn")}</Link>
          </Button>
        </AuthShell>
      )}
      <p role="status" className="sr-only">
        {sentMessage}
      </p>
    </>
  );
}
