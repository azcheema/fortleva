"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

import { authClient } from "@/auth/client";

/**
 * Member self-signup creates a global User IDENTITY only — membership
 * in a workspace arrives exclusively via invitation, and signup can
 * never create a contact identity (decision 6; PLAN.md non-negotiable).
 */
function SignupForm() {
  const params = useSearchParams();
  const next = params.get("next") ?? "/dashboard";

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
      setError(err.message ?? "Sign-up failed");
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
        <h1 className="text-2xl font-semibold">Check your email</h1>
        <p className="text-sm text-neutral-600">
          We sent a verification link to <strong>{email}</strong>. Verify your
          address, then sign in.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Create your Fortleva account</h1>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <input
          placeholder="Full name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border border-neutral-300 px-3 py-2"
        />
        <input
          type="email"
          placeholder="Email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded border border-neutral-300 px-3 py-2"
        />
        <input
          type="password"
          placeholder="Password (12+ characters)"
          required
          minLength={12}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded border border-neutral-300 px-3 py-2"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create account"}
        </button>
      </form>
      <p className="text-sm text-neutral-600">
        Already have an account?{" "}
        <Link className="underline" href={`/login?next=${encodeURIComponent(next)}`}>
          Sign in
        </Link>
      </p>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </main>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
