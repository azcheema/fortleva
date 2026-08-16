"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { AUTH_CONTROL, AuthShell } from "@/app/(tenant)/login/auth-shell";
import { platformAuthClient } from "@/auth/client";
import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The platform plane's entry. Identical geometry to the member login so
 * the product reads as one system, but a shield mark and a "Platform"
 * eyebrow — the two planes must never be mistaken for one another.
 */
export default function OpsLoginPage() {
  const t = useTranslations("auth");
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [stage, setStage] = useState<"credentials" | "totp">("credentials");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitCredentials(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: err } = await platformAuthClient.signIn.email({ email, password });
    setBusy(false);
    if (err) {
      setError(err.message ?? t("login.failed"));
      return;
    }
    if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
      setStage("totp");
      return;
    }
    router.push("/ops");
  }

  async function submitTotp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await platformAuthClient.twoFactor.verifyTotp({ code: totp });
    setBusy(false);
    if (err) {
      setError(err.message ?? t("login.invalidCode"));
      return;
    }
    router.push("/ops");
  }

  return (
    <AuthShell
      plane="platform"
      eyebrow={t("ops.eyebrow")}
      title={t("ops.loginTitle")}
      description={stage === "credentials" ? t("ops.loginSubtitle") : t("login.totpHint")}
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
          <Field label={t("login.totpLabel")} htmlFor="totp">
            <Input
              id="totp"
              inputMode="numeric"
              maxLength={6}
              required
              autoFocus
              autoComplete="one-time-code"
              placeholder={t("ops.codePlaceholder")}
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              className="num h-10 text-center font-mono text-lg tracking-[0.4em]"
            />
          </Field>
          <Button type="submit" size="lg" className="mt-2 w-full" disabled={busy}>
            {busy ? t("login.verifying") : t("login.verify")}
          </Button>
        </form>
      )}
      {error ? <FormMessage state={{ ok: false, message: error }} /> : null}
    </AuthShell>
  );
}
