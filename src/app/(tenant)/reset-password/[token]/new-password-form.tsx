"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { AUTH_CONTROL, AuthShell, authLinkClass } from "@/app/(tenant)/login/auth-shell";
import { authClient } from "@/auth/client";
import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFocusHeadingOnChange } from "@/components/use-focus-heading";

import { ResetUnavailable } from "../reset-unavailable";

type View = "form" | "dead" | "saved";

/**
 * The second half of the member plane's password reset. `page.tsx` has
 * already checked the link is live, whose it is and whether a second
 * factor guards the account; this form sets the password and, where it
 * can, signs the member in with it. The portal's `new-password-form.tsx`
 * on the member plane — every rule below is that form's — except after
 * the save.
 *
 * **PURE VALIDATION FIRST, AND IT MAY BE AS SPECIFIC AS IT LIKES.** Length
 * and confirmation are checked here before anything leaves the browser, so
 * a mistyped confirmation costs no request and says exactly what is wrong.
 * The bounds are the instance's own (`memberPasswordPolicy`, via the page),
 * so this check and the service's are one number, not two literals.
 *
 * **A LINK THAT DIES WHILE THE PERSON TYPES** comes back `INVALID_TOKEN`, and
 * the form becomes the page they would have met had they arrived a minute
 * later. The rate limiter says so; every other failure is "try again",
 * because the password was not saved and saying otherwise would be the one
 * lie this form could tell. A reset whose answer never arrived (a network
 * failure THROWS out of the auth client) is UNCONFIRMED — the server may
 * have saved it and spent the link, so pressing Save again would only meet
 * the dead-link page — and `unreachableSave` says so and points at signing
 * in first.
 *
 * **THEN, WHERE IT CAN, IT SIGNS THEM IN**, which the endpoint deliberately
 * does not — it adds nothing an attacker could use (whoever holds a live
 * link can set the password and then sign in anyway), and the reset has
 * already revoked every other session (`revokeSessionsOnPasswordReset`).
 * Where the member plane differs from the portal:
 *
 *  - **a member with a SECOND FACTOR goes straight to "Password saved"**,
 *    whose one button is Sign in. The code stage belongs to `/login`, and
 *    starting a sign-in here that only `/login` can finish would leave a
 *    half-open challenge and a page with nowhere to type the code. The
 *    save button does not promise a sign-in to that member, either.
 *  - otherwise a sign-in that answers anything but a plain success — a
 *    second factor enabled since the page was drawn, the address still
 *    unconfirmed, a refusal, a dropped connection — also lands on "Password
 *    saved", because the password IS saved and that is the fact the person
 *    needs. (A completed reset confirms the address on the instance —
 *    `afterMemberPasswordReset` — so "unconfirmed" should not arise.)
 *
 * `router.replace`, not `push`: the address bar holds a token that is now
 * spent, and Back should not return to it.
 *
 * **THE VIEWS THAT REPLACE THE FORM ARE ANNOUNCED AND FOCUSED** — a live
 * region that exists before it fills, and focus moved to the new heading —
 * because each of them unmounts the button the person just pressed.
 *
 * Both password fields are controlled, like every auth form here, and the
 * hidden `username` field is for password managers, which otherwise have no
 * way to know which account the new password belongs to.
 */
export function NewPasswordForm({
  token,
  email,
  twoFactor,
  minLength,
  maxLength,
  minutes,
}: {
  token: string;
  email: string;
  twoFactor: boolean;
  minLength: number;
  maxLength: number;
  minutes: number;
}) {
  const t = useTranslations("auth.memberReset");
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>("form");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < minLength) return setError(t("passwordShort", { min: minLength }));
    if (password.length > maxLength) return setError(t("passwordLong", { max: maxLength }));
    if (password !== confirm) return setError(t("mismatch"));

    setBusy(true);
    setError(null);
    let err: { status: number; code?: string | undefined } | null;
    try {
      ({ error: err } = await authClient.resetPassword({ newPassword: password, token }));
    } catch {
      setBusy(false);
      setError(t("unreachableSave"));
      return;
    }
    if (err) {
      setBusy(false);
      if (err.code === "INVALID_TOKEN") {
        setView("dead");
        return;
      }
      setError(err.status === 429 ? t("tooMany") : t("saveFailed"));
      return;
    }

    // A second factor cannot be completed on this screen: "Password saved"
    // and its Sign in button are the whole of what is left to do here.
    if (twoFactor) {
      setBusy(false);
      setView("saved");
      return;
    }

    let signedIn = false;
    try {
      const { data, error: signInError } = await authClient.signIn.email({ email, password });
      signedIn =
        !signInError &&
        data != null &&
        !(data as { twoFactorRedirect?: boolean }).twoFactorRedirect;
    } catch {
      signedIn = false;
    }
    if (!signedIn) {
      setBusy(false);
      setView("saved");
      return;
    }
    // `busy` stays true: the page is leaving, and a second press must not
    // spend a token that no longer exists.
    router.replace("/home");
  }

  useFocusHeadingOnChange(view);
  const savedMessage = twoFactor ? t("savedTwoFactor") : t("saved");
  const announcement =
    view === "dead"
      ? `${t("unavailableTitle")}. ${t("unavailable", { minutes })}`
      : view === "saved"
        ? savedMessage
        : "";

  // Plain elements, not components declared in here: a component defined
  // inside this function would be a NEW type on every render, and React
  // would remount the inputs — and drop their focus — on each keystroke.
  const saved = (
    <AuthShell title={t("savedTitle")} description={savedMessage}>
      <Button asChild size="lg" className="w-full">
        <Link href="/login">{t("signIn")}</Link>
      </Button>
    </AuthShell>
  );

  const form = (
    <AuthShell
      title={t("newTitle")}
      description={t.rich("newSubtitle", {
        email,
        strong: (chunks) => <strong className="font-medium text-foreground">{chunks}</strong>,
      })}
      footer={
        <>
          {t("remembered")}{" "}
          <Link className={authLinkClass} href="/login">
            {t("signIn")}
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
        <Field label={t("password")} htmlFor="reset-password" hint={t("passwordHint", { min: minLength })}>
          <Input
            id="reset-password"
            type="password"
            required
            minLength={minLength}
            maxLength={maxLength}
            autoComplete="new-password"
            className={AUTH_CONTROL}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label={t("confirm")} htmlFor="reset-confirm">
          <Input
            id="reset-confirm"
            type="password"
            required
            minLength={minLength}
            maxLength={maxLength}
            autoComplete="new-password"
            className={AUTH_CONTROL}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Button type="submit" size="lg" className="mt-2 w-full" disabled={busy}>
          {busy ? t("saving") : twoFactor ? t("saveOnly") : t("save")}
        </Button>
        {error ? <FormMessage state={{ ok: false, message: error }} /> : null}
      </form>
    </AuthShell>
  );

  return (
    <>
      {view === "dead" ? <ResetUnavailable minutes={minutes} /> : view === "saved" ? saved : form}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </>
  );
}
