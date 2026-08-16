"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useState } from "react";

import { authClient } from "@/auth/client";
import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { AUTH_CONTROL, AuthShell, authLinkClass } from "../login/auth-shell";

/**
 * Member self-signup creates a global User IDENTITY only — membership
 * in a workspace arrives exclusively via invitation, and signup can
 * never create a contact identity (decision 6; PLAN.md non-negotiable).
 */
function SignupForm() {
  const t = useTranslations("auth");
  const params = useSearchParams();
  const next = params.get("next") ?? "/home";

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
    const { error: err } = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: next,
    });
    setBusy(false);
    if (err) {
      setError(err.message ?? t("signup.failed"));
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <AuthShell
        title={t("signup.checkEmailTitle")}
        description={t.rich("signup.checkEmail", {
          email,
          strong: (chunks) => <strong className="font-medium text-foreground">{chunks}</strong>,
        })}
        footer={
          <Link className={authLinkClass} href={`/login?next=${encodeURIComponent(next)}`}>
            {t("signup.signIn")}
          </Link>
        }
      />
    );
  }

  return (
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
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
