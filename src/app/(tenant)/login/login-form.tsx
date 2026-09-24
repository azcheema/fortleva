"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { authClient } from "@/auth/client";
import { Callout, Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { safeNext } from "@/lib/safe-next";

import { AUTH_CONTROL, AuthShell, authLinkClass } from "./auth-shell";

/**
 * The member plane's sign-in form. `page.tsx` beside it holds why the
 * numbers it quotes come from where they do; this file holds how it
 * behaves.
 *
 * **ITS STATES**, each one the answer to one thing the endpoint can say:
 *
 *  - **wrong address or password** (401) — ONE sentence for both, the
 *    form's own (`login.invalid`), because which of the two was wrong is a
 *    fact about who has an account. Every failure not named below reads the
 *    same way.
 *  - **the right password to an address that is not confirmed yet** (403
 *    `EMAIL_NOT_VERIFIED`) — an info callout, not an error, saying a new
 *    confirmation link is on its way, how many there can be in an hour and
 *    how long each works; the form stays, in case they would rather come
 *    back here — though the link's page itself confirms AND signs in, with
 *    the same password. The instance
 *    mails the link on exactly this answer (`sendOnSignIn`, C30 (b)) — the
 *    end of the dead end in which a member whose one link had expired
 *    could get no other. The link's page asks for the password again and
 *    confirms and signs in in one step (`/confirm-email/[token]`); where the
 *    person was going rides along, taken from this page's `next` by the
 *    instance (`nextOf`, src/auth/member-recovery.ts).
 *    **The 403 is DELIBERATELY distinguishable from the 401**, and that is
 *    a decision recorded rather than a leak overlooked: it only arises
 *    with the account's right password, so it tells nobody anything they
 *    did not already know, and without it this screen could not say that
 *    a link is on its way — `src/auth/sign-up-answer.ts`, WHAT IS LEFT,
 *    states the one residue (a stranger who signed an address up with a
 *    password of their own can tell a new address from a registered one),
 *    and states why closing it would mean lying to every member who has
 *    not yet clicked their link.
 *  - **the rate limiter** (429) says so, for the network, never for an
 *    address.
 *  - **a network failure THROWS** out of the auth client — it is built
 *    without `catchAllError` — so both calls are wrapped; unwrapped, a
 *    dropped request left the button disabled on "Signing in…" for good
 *    (the portal's sign-in says the same, having been caught the same way).
 *  - **a second factor** swaps in the code stage, as before.
 *
 * **IT NEVER SHOWS `err.message`.** That is the library's English, on a
 * page that may be Swedish, and its wording is the library's to change;
 * this form renders its own sentence for each answer above.
 *
 * **NO `callbackURL` IS SENT.** Given one, the library answers a success
 * with a redirect that the client follows by itself — a full page load on
 * every sign-in, racing the `router.push` below; `next` stays this form's
 * business. The confirmation mail a sign-in triggers still carries `next`:
 * the instance reads it off this page's address, the request's referrer
 * (`nextOf`, src/auth/member-recovery.ts — a review found invitees losing
 * their invitation without it).
 *
 * **THE CALLOUT IS ANNOUNCED THROUGH A LIVE REGION THAT EXISTS BEFORE IT
 * FILLS**, the recovery screens' pattern (`/reset-password`): a status
 * element mounted with its text already inside is not reliably read out,
 * so the visible callout carries no role of its own and the sr-only region
 * after the shell speaks the same sentence. Errors keep `FormMessage`'s
 * `role="alert"`, which is announced on insertion.
 *
 * **THE FOOTER HAS THE PAGE'S TWO OTHER DOORS** — a forgotten password
 * (C30 (a)) and a new account — as links, never buttons: an auth page is
 * allowed exactly one --primary element, and that is the submit button.
 * The reset link carries no `next`, because the way back in from a reset
 * is a mailed link, not this form.
 *
 * `#email`, `#password` and the ONE submit button in the credentials form
 * are what the e2e suite and its global set-up sign in by.
 */
export function LoginForm({ cap, minutes }: { cap: number; minutes: number }) {
  const t = useTranslations("auth");
  const router = useRouter();
  const params = useSearchParams();
  // THROUGH THE GUARD, and this form is the reason it exists. `next`
  // reached `router.push` unvalidated, so `/login?next=https://evil.example`
  // signed a member in and then sent them to somebody else's site with
  // the credibility of having just come from their own workspace. No
  // prefix: any same-origin path is a legitimate destination here (the
  // proxy sends people back to the page they asked for).
  const next = safeNext(params.get("next"), "/home");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [stage, setStage] = useState<"credentials" | "totp">("credentials");
  const [error, setError] = useState<string | null>(null);
  // The address the last sign-in named, when the answer was "not confirmed
  // yet" — kept apart from `error` because it is not one.
  const [unconfirmedFor, setUnconfirmedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitCredentials(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setUnconfirmedFor(null);
    let data: unknown;
    let err: { status: number; code?: string | undefined } | null;
    try {
      ({ data, error: err } = await authClient.signIn.email({ email, password }));
    } catch {
      setBusy(false);
      setError(t("login.unreachable"));
      return;
    }
    setBusy(false);
    if (err) {
      if (err.code === "EMAIL_NOT_VERIFIED") {
        setUnconfirmedFor(email);
        return;
      }
      setError(err.status === 429 ? t("login.tooMany") : t("login.invalid"));
      return;
    }
    if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
      setStage("totp");
      return;
    }
    router.push(next);
  }

  async function submitTotp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    let err: { status: number } | null;
    try {
      ({ error: err } = await authClient.twoFactor.verifyTotp({ code: totp }));
    } catch {
      setBusy(false);
      setError(t("login.unreachable"));
      return;
    }
    setBusy(false);
    if (err) {
      setError(err.status === 429 ? t("login.tooMany") : t("login.invalidCode"));
      return;
    }
    router.push(next);
  }

  const unconfirmedMessage =
    unconfirmedFor === null ? "" : t("login.unconfirmed", { email: unconfirmedFor, cap, minutes });

  return (
    <>
      <AuthShell
        title={stage === "credentials" ? t("login.title") : t("login.totpTitle")}
        description={stage === "credentials" ? t("login.subtitle") : t("login.totpHint")}
        footer={
          <div className="flex flex-col gap-2">
            <p>
              {t("login.forgot")}{" "}
              <Link className={authLinkClass} href="/reset-password">
                {t("login.reset")}
              </Link>
            </p>
            <p>
              {t("login.noAccount")}{" "}
              <Link className={authLinkClass} href={`/signup?next=${encodeURIComponent(next)}`}>
                {t("login.signUp")}
              </Link>
            </p>
          </div>
        }
      >
        {stage === "credentials" ? (
          <form onSubmit={submitCredentials} className="flex flex-col gap-4">
            <Field label={t("email")} htmlFor="email">
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                className={AUTH_CONTROL}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label={t("password")} htmlFor="password">
              <Input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                className={AUTH_CONTROL}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button type="submit" size="lg" className="mt-2 w-full" disabled={busy}>
              {busy ? t("login.submitting") : t("login.submit")}
            </Button>
          </form>
        ) : (
          <form onSubmit={submitTotp} className="flex flex-col gap-4">
            {/* `autoFocus` kept from before the split, deliberately: the
                credentials form has just unmounted from under the button
                the member pressed, and the code box is the one place they
                are going next. No focus-returning dialog is rendered in
                this file, which is the keymap test's concern. */}
            <Field label={t("login.totpLabel")} htmlFor="totp">
              <Input
                id="totp"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                autoComplete="one-time-code"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                className="otp-field h-10 text-lg"
              />
            </Field>
            <Button type="submit" size="lg" className="mt-2 w-full" disabled={busy}>
              {busy ? t("login.verifying") : t("login.verify")}
            </Button>
          </form>
        )}
        {/* `wrap-anywhere`: it opens with the typed address, which has no break
            opportunity at "." or "@" (AuthShell's description says the same). */}
        {unconfirmedFor !== null ? (
          <Callout tone="info" className="wrap-anywhere">
            {unconfirmedMessage}
          </Callout>
        ) : null}
        {error ? <FormMessage state={{ ok: false, message: error }} /> : null}
      </AuthShell>
      <p role="status" className="sr-only">
        {unconfirmedMessage}
      </p>
    </>
  );
}
