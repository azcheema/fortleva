"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { platformAuthClient } from "@/auth/client";

export default function OpsLoginPage() {
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
      setError(err.message ?? "Sign-in failed");
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
      setError(err.message ?? "Invalid code");
      return;
    }
    router.push("/ops");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Fortleva Ops — sign in</h1>
      {stage === "credentials" ? (
        <form onSubmit={submitCredentials} className="flex flex-col gap-4">
          <input
            type="email"
            placeholder="Email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded border border-neutral-300 px-3 py-2"
          />
          <input
            type="password"
            placeholder="Password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded border border-neutral-300 px-3 py-2"
          />
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
          <input
            inputMode="numeric"
            maxLength={6}
            required
            autoFocus
            placeholder="6-digit code"
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            className="rounded border border-neutral-300 px-3 py-2 text-center"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
          >
            Verify
          </button>
        </form>
      )}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </main>
  );
}
