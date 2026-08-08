"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { authClient } from "@/auth/client";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/dashboard";

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
    const { data, error: err } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (err) {
      setError(err.message ?? "Sign-in failed");
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
    const { error: err } = await authClient.twoFactor.verifyTotp({ code: totp });
    setBusy(false);
    if (err) {
      setError(err.message ?? "Invalid code");
      return;
    }
    router.push(next);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Sign in to Fortleva</h1>
      {stage === "credentials" ? (
        <form onSubmit={submitCredentials} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded border border-neutral-300 px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Password
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded border border-neutral-300 px-3 py-2"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      ) : (
        <form onSubmit={submitTotp} className="flex flex-col gap-4">
          <p className="text-sm text-neutral-600">
            Enter the 6-digit code from your authenticator app.
          </p>
          <input
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            className="rounded border border-neutral-300 px-3 py-2 text-center text-lg tracking-widest"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
          >
            {busy ? "Verifying…" : "Verify"}
          </button>
        </form>
      )}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
