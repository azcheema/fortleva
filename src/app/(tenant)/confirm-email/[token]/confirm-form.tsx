"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { AUTH_CONTROL, AuthShell, authLinkClass } from "@/app/(tenant)/login/auth-shell";
import { Callout, Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFocusHeadingOnChange } from "@/components/use-focus-heading";

import { confirmEmailAction } from "./actions";
import { ConfirmedState } from "./confirmed-state";
import { ConfirmUnavailable } from "./confirm-unavailable";

type View = "form" | "confirmed" | "already" | "dead";

/**
 * The confirmation page's one control — `page.tsx` beside it holds why the
 * page exists at all; this file holds how the form behaves.
 *
 * **CONFIRMING TAKES THE ACCOUNT'S PASSWORD, AND THEN SIGNS THE PERSON IN**
 * (C30, after its review; `confirmEmailAction` beside it). Rendering the page
 * reads; only this form confirms, and only with the password the account was
 * created with. The link proves the mailbox, the password proves the account —
 * and the owner of an address a STRANGER signed up first holds only the
 * first: their password is refused here, and the refusal sends them to
 * "Choose a new password", which replaces the stranger's and confirms the
 * address too. The first cut was a single Confirm button with a warning; the
 * review showed an owner who has just signed up themselves reads the
 * stranger's mail as their own, presses it, and so turns the stranger's
 * password on.
 *
 * **ITS ANSWERS**, each the action's own: signed in → the page leaves for
 * `next` (`busy` stays true, so a second press cannot follow); confirmed but
 * the sign-in did not go through → "Address confirmed, sign in"; the address
 * was confirmed already → the same state the page draws for it; a dead link →
 * the page a person would have met had they opened it later; the wrong
 * password → the way to a new one; the limiter → says so. A network failure
 * THROWS out of a server-action call like out of the auth client, so the call
 * is wrapped; the address may or may not be confirmed by then, and "try
 * again" is safe either way.
 *
 * The password field is controlled, and the call is made from the submit
 * handler rather than as a `<form action>`: React 19 resets a form around
 * its action, which would empty the field on every refusal (AGENTS.md). The
 * hidden `username` field is for password managers.
 *
 * The views that replace the form are announced through a live region that
 * exists before it fills, and focused at their heading
 * (`useFocusHeadingOnChange`), as on the reset screens.
 */
export function ConfirmForm({
  token,
  email,
  next,
  minutes,
}: {
  token: string;
  email: string;
  next: string;
  minutes: number;
}) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [view, setView] = useState<View>("form");
  const [error, setError] = useState<string | null>(null);
  const [wrongPassword, setWrongPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setWrongPassword(false);
    let result: Awaited<ReturnType<typeof confirmEmailAction>>;
    try {
      result = await confirmEmailAction(token, password);
    } catch {
      setBusy(false);
      setError(t("confirmEmail.unreachable"));
      return;
    }
    if (result.ok && result.signedIn) {
      router.replace(next);
      return;
    }
    setBusy(false);
    if (result.ok) {
      setView("confirmed");
      return;
    }
    switch (result.reason) {
      case "dead":
        setView("dead");
        return;
      case "already":
        setView("already");
        return;
      case "password":
        setWrongPassword(true);
        return;
      case "tooMany":
        setError(t("confirmEmail.tooMany"));
        return;
    }
  }

  useFocusHeadingOnChange(view);
  const announcement =
    view === "dead"
      ? `${t("confirmEmail.unavailableTitle")}. ${t("confirmEmail.unavailable", { minutes })}`
      : view === "confirmed"
        ? `${t("confirmEmail.confirmedTitle")}. ${t("confirmEmail.confirmed")}`
        : view === "already"
          ? `${t("confirmEmail.alreadyTitle")}.`
          : wrongPassword
            ? t("confirmEmail.wrongPassword")
            : "";

  // Plain elements rather than components declared in here, for the reason
  // the reset form gives: a component type minted per render remounts.
  const form = (
    <AuthShell
      title={t("confirmEmail.title")}
      description={t.rich("confirmEmail.subtitle", {
        email,
        strong: (chunks) => <strong className="font-medium text-foreground">{chunks}</strong>,
      })}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
        <Field label={t("password")} htmlFor="confirm-password">
          <Input
            id="confirm-password"
            type="password"
            required
            autoComplete="current-password"
            className={AUTH_CONTROL}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Button type="submit" size="lg" className="mt-2 w-full" disabled={busy}>
          {busy ? t("confirmEmail.submitting") : t("confirmEmail.submit")}
        </Button>
        {wrongPassword ? (
          // No role: the sr-only region below speaks it, having existed
          // before it filled (the login form's reason).
          <Callout tone="danger" className="wrap-anywhere">
            {t("confirmEmail.wrongPassword")}{" "}
            <Link className={authLinkClass} href="/reset-password">
              {t("confirmEmail.chooseNew")}
            </Link>
          </Callout>
        ) : null}
        {error ? <FormMessage state={{ ok: false, message: error }} /> : null}
      </form>
    </AuthShell>
  );

  return (
    <>
      {view === "dead" ? (
        <ConfirmUnavailable minutes={minutes} next={next} />
      ) : view === "confirmed" ? (
        <ConfirmedState title={t("confirmEmail.confirmedTitle")} description={t("confirmEmail.confirmed")} next={next} />
      ) : view === "already" ? (
        <ConfirmedState
          title={t("confirmEmail.alreadyTitle")}
          description={t.rich("confirmEmail.already", {
            email,
            strong: (chunks) => <strong className="font-medium text-foreground">{chunks}</strong>,
          })}
          next={next}
        />
      ) : (
        form
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </>
  );
}
