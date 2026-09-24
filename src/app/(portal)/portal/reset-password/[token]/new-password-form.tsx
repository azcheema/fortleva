"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { AUTH_CONTROL, AuthShell, authLinkClass } from "@/app/(tenant)/login/auth-shell";
import { contactAuthClient } from "@/auth/client";
import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { ResetUnavailable } from "../reset-unavailable";
import { useFocusHeadingOnChange } from "../use-focus-heading";

type View = "form" | "dead" | "saved";

/**
 * The second half of the portal's password reset. `page.tsx` has already
 * checked the link is live and whose it is; this form sets the password
 * and signs the contact in with it.
 *
 * **PURE VALIDATION FIRST, AND IT MAY BE AS SPECIFIC AS IT LIKES** — the
 * same order the invitation's action keeps, for the same reason. Length and
 * confirmation are checked here before anything leaves the browser, so a
 * mistyped confirmation costs no request and says exactly what is wrong.
 * The bounds are the instance's own (`portalPasswordPolicy`, via the page),
 * so this check and the service's are one number, not two literals.
 *
 * **A LINK THAT DIES WHILE THE PERSON TYPES** — the hour runs out, or they
 * used a newer mail in another tab — comes back `INVALID_TOKEN`, and the
 * form becomes the very page they would have met had they arrived a minute
 * later. Nothing else is worth distinguishing: the rate limiter says so,
 * and every other failure is "try again", because the password was not
 * saved and saying otherwise would be the one lie this form could tell.
 *
 * **THEN IT SIGNS THEM IN**, which the endpoint deliberately does not. It
 * adds nothing an attacker could use — whoever holds a live link can set
 * the password and then sign in anyway — and it spares a person who has
 * just chosen a password from typing it a third time. The reset has
 * already revoked every other session the contact held
 * (`revokeSessionsOnPasswordReset`), so this one is the only one. If the
 * sign-in fails the password is still saved, so the form says THAT and
 * offers the sign-in page, rather than reporting a failure that did not
 * happen.
 *
 * `router.replace`, not `push`: the address bar holds a token that is now
 * spent, and Back should not return to it.
 *
 * **A NETWORK FAILURE THROWS** out of the auth client — it is built without
 * `catchAllError`, so a rejected fetch is not returned as `{ error }` — and
 * the first cut awaited both calls bare: a dropped connection left the form
 * disabled on "Saving your password…" for good, and a dropped SIGN-IN, after
 * a reset that had already succeeded, hid the one fact the person needed —
 * that their new password was saved (review finding). Each call is wrapped
 * now. A reset whose answer never arrived is exactly that — UNCONFIRMED: the
 * server may have saved it and spent the link, so pressing Save again would
 * only meet the dead-link page — and the message says so and points at the
 * sign-in link in the footer first (a second review finding). A sign-in that
 * failed after a CONFIRMED reset goes to "Password saved".
 *
 * **THE VIEWS THAT REPLACE THE FORM ARE ANNOUNCED AND FOCUSED** — a live
 * region that exists before it fills, and focus moved to the new heading
 * (`useFocusHeadingOnChange`) — because each of them unmounts the button
 * the person just pressed.
 *
 * Both password fields are controlled, like every auth form here, and the
 * hidden `username` field is for password managers, which otherwise have
 * no way to know which account the new password belongs to.
 */
export function NewPasswordForm({
  token,
  email,
  minLength,
  maxLength,
  minutes,
}: {
  token: string;
  email: string;
  minLength: number;
  maxLength: number;
  minutes: number;
}) {
  const t = useTranslations("auth.portalReset");
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
      ({ error: err } = await contactAuthClient.resetPassword({ newPassword: password, token }));
    } catch {
      setBusy(false);
      setError(t("unreachable"));
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

    let signedIn = false;
    try {
      signedIn = !(await contactAuthClient.signIn.email({ email, password })).error;
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
    router.replace("/portal");
  }

  useFocusHeadingOnChange(view);
  const announcement =
    view === "dead"
      ? `${t("unavailableTitle")}. ${t("unavailable", { minutes })}`
      : view === "saved"
        ? t("saved")
        : "";

  // Plain elements, not components declared in here: a component defined
  // inside this function would be a NEW type on every render, and React
  // would remount the inputs — and drop their focus — on each keystroke.
  const saved = (
    <AuthShell plane="portal" eyebrow={t("eyebrow")} title={t("savedTitle")} description={t("saved")}>
      <Button asChild size="lg" className="w-full">
        <Link href="/portal/login">{t("signIn")}</Link>
      </Button>
    </AuthShell>
  );

  const form = (
    <AuthShell
      plane="portal"
      eyebrow={t("eyebrow")}
      title={t("newTitle")}
      description={t.rich("newSubtitle", {
        email,
        strong: (chunks) => <strong className="font-medium text-foreground">{chunks}</strong>,
      })}
      footer={
        <>
          {t("remembered")}{" "}
          <Link className={authLinkClass} href="/portal/login">
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
          {busy ? t("saving") : t("save")}
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
