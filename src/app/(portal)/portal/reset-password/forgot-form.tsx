"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { AUTH_CONTROL, AuthShell, authLinkClass } from "@/app/(tenant)/login/auth-shell";
import { contactAuthClient } from "@/auth/client";
import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFocusHeadingOnChange } from "@/components/use-focus-heading";

/**
 * The request half of the portal's password reset. `page.tsx` beside it
 * holds why the surface exists; this file holds how it behaves.
 *
 * **THE CONFIRMATION IS THE SAME SENTENCE FOR EVERY ADDRESS.** The endpoint
 * answers identically whether the address is an active contact, a paused
 * one, an invited one or nobody at all, and whether a mail actually went —
 * so this form has exactly one success state and it is conditional in its
 * WORDING ("if … can sign in"), never in whether it appears. On this plane
 * a difference is a fact about an agency's client list.
 *
 * **IT DOES NOT PRETEND A FAILURE WAS A SUCCESS, EITHER.** The one thing it
 * does distinguish is whether the REQUEST went through: a refusal by the
 * rate limiter or a network failure says so, because showing "check your
 * email" over a request that never reached the server would send somebody
 * to wait for a mail that is not coming. Neither refusal depends on the
 * address, so neither says anything about it — and neither claims to know
 * more than it does: a request whose answer never came back may still have
 * reached the server, so the copy says the connection failed "before we
 * heard back", not that nothing was sent. (A network failure THROWS
 * out of the auth client rather than returning `{ error }` — the client is
 * built without `catchAllError` — so the call is wrapped; the first cut was
 * not, and a dropped request left the button disabled on "Sending…" for
 * good. A review caught it.)
 *
 * **AND IT SAYS HOW MANY MAILS THERE CAN BE**, because the instance sends at
 * most `cap` an hour to one person: a fourth request in the hour gets the
 * same confirmation and no mail, and a sentence promising "a link is on its
 * way" over that would be the one untrue thing this form says.
 *
 * **NO `redirectTo` IS SENT.** The instance builds the mailed link itself
 * (`portalResetUrl`), so nothing this form — or a hand-written request —
 * puts in the body can change where the mail points.
 *
 * The confirmation is ANNOUNCED through a live region that exists before
 * it fills, rather than by mounting a status element: a region inserted
 * with its text already in it is not reliably read out, and the form the
 * person was focused on has just disappeared from under them.
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
      ({ error: err } = await contactAuthClient.requestPasswordReset({ email }));
    } catch {
      setBusy(false);
      setError(t("portal.unreachable"));
      return;
    }
    setBusy(false);
    if (err) {
      setError(err.status === 429 ? t("portalReset.tooMany") : t("portalReset.failed"));
      return;
    }
    setSentTo(email);
  }

  const signInLink = (
    <>
      {t("portalReset.remembered")}{" "}
      <Link className={authLinkClass} href="/portal/login">
        {t("portalReset.signIn")}
      </Link>
    </>
  );

  const sentMessage = sentTo === null ? "" : t("portalReset.sent", { email: sentTo, minutes, cap });
  useFocusHeadingOnChange(sentTo === null ? "form" : "sent");

  return (
    <>
      {sentTo === null ? (
        <AuthShell
          plane="portal"
          eyebrow={t("portalReset.eyebrow")}
          title={t("portalReset.title")}
          description={t("portalReset.subtitle")}
          footer={signInLink}
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
              {busy ? t("portalReset.submitting") : t("portalReset.submit")}
            </Button>
          </form>
          {error ? <FormMessage state={{ ok: false, message: error }} /> : null}
        </AuthShell>
      ) : (
        <AuthShell
          plane="portal"
          eyebrow={t("portalReset.eyebrow")}
          title={t("portalReset.sentTitle")}
          description={sentMessage}
        >
          <p className="text-sm text-muted-foreground">{t("portalReset.sentInvited")}</p>
          {/* The form is gone, so the page's one primary element is the way
              back — a page that has just told somebody to go and read their
              mail must still offer the door they came in by. */}
          <Button asChild size="lg" className="w-full">
            <Link href="/portal/login">{t("portalReset.signIn")}</Link>
          </Button>
        </AuthShell>
      )}
      <p role="status" className="sr-only">
        {sentMessage}
      </p>
    </>
  );
}
