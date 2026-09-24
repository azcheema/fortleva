"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useState } from "react";

import { authClient } from "@/auth/client";
import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFocusHeadingOnChange } from "@/components/use-focus-heading";
import { safeNext } from "@/lib/safe-next";

import { AUTH_CONTROL, AuthShell, authLinkClass } from "../login/auth-shell";

/**
 * Member self-signup creates a global User IDENTITY only — membership
 * in a workspace arrives exclusively via invitation, and signup can
 * never create a contact identity (decision 6; PLAN.md non-negotiable).
 */
function SignupForm() {
  const t = useTranslations("auth");
  const params = useSearchParams();
  // Same guard as /login. Better Auth checks a `callbackURL` against its
  // own `trustedOrigins`, so this is defence in depth there — but the
  // value is also interpolated into two links on this page, which nothing
  // else validates.
  const next = safeNext(params.get("next"), "/home");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // A network failure THROWS out of the auth client (no `catchAllError`);
    // unwrapped, the button stayed disabled on "Creating…" for good — the
    // other auth forms were fixed for the same thing (C30's review).
    let err: { status: number; code?: string | undefined } | null;
    try {
      ({ error: err } = await authClient.signUp.email({
        name,
        email,
        password,
        callbackURL: next,
      }));
    } catch {
      setBusy(false);
      setError(t("login.unreachable"));
      return;
    }
    setBusy(false);
    if (err) {
      // The one refusal this product authors (src/auth/sign-up-answer.ts,
      // `SIGN_UP_REFUSED`) gets its own words, and so does the limiter; every
      // other refusal reads "Sign-up failed" — never the library's English
      // `err.message` on a page that may be Swedish (C30's review).
      setError(
        err.code === "INVALID_SIGN_UP"
          ? t("signup.invalidInput")
          : err.status === 429
            ? t("login.tooMany")
            : t("signup.failed"),
      );
      return;
    }
    setDone(true);
  }

  // The done view replaces the form and unmounts the button that was just
  // pressed: focus goes to its heading, and the live region below says it.
  useFocusHeadingOnChange(done ? "done" : "form");

  // Announced through a region that exists before it fills: the done view
  // unmounts the form under the person, and a status element mounted with its
  // text already inside is not reliably read out.
  const announcement = done
    ? t.rich("signup.checkEmail", { email, strong: (chunks) => chunks })
    : null;
  const live = (
    <p role="status" className="sr-only">
      {announcement}
    </p>
  );

  if (done) {
    // The sentence is the same for a new address and a registered one (a
    // registered one is mailed nothing — src/auth/sign-up-answer.ts), so
    // the footer offers the door each of them needs next: sign in, or —
    // since C30 — choose a new password.
    return (
      <>
        <AuthShell
          title={t("signup.checkEmailTitle")}
          description={t.rich("signup.checkEmail", {
            email,
            strong: (chunks) => <strong className="font-medium text-foreground">{chunks}</strong>,
          })}
          footer={
            <div className="flex flex-col gap-2">
              <p>
                <Link className={authLinkClass} href={`/login?next=${encodeURIComponent(next)}`}>
                  {t("signup.signIn")}
                </Link>
              </p>
              <p>
                {t("login.forgot")}{" "}
                <Link className={authLinkClass} href="/reset-password">
                  {t("login.reset")}
                </Link>
              </p>
            </div>
          }
        />
        {live}
      </>
    );
  }

  return (
    <>
      <AuthShell
        title={t("signup.title")}
        description={t("signup.subtitle")}
        footer={
          <>
            {t("signup.haveAccount")}{" "}
            <Link className={authLinkClass} href={`/login?next=${encodeURIComponent(next)}`}>
              {t("signup.signIn")}
            </Link>
          </>
        }
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label={t("name")} htmlFor="name">
            <Input
              id="name"
              required
              autoComplete="name"
              className={AUTH_CONTROL}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
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
          <Field label={t("signup.passwordHint")} htmlFor="password">
            <Input
              id="password"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              className={AUTH_CONTROL}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" size="lg" className="mt-2 w-full" disabled={busy}>
            {busy ? t("signup.submitting") : t("signup.submit")}
          </Button>
        </form>
        {error ? <FormMessage state={{ ok: false, message: error }} /> : null}
      </AuthShell>
      {live}
    </>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
