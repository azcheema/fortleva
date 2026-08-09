"use client";

import { useState } from "react";

import { authClient } from "@/auth/client";

export function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const { error } = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    });
    setBusy(false);
    if (error) {
      setMessage({ ok: false, text: error.message ?? "Password change failed" });
      return;
    }
    setCurrent("");
    setNext("");
    setMessage({
      ok: true,
      text: "Password changed. Other sessions have been signed out.",
    });
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
      <input
        type="password"
        placeholder="Current password"
        required
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        className="rounded border border-neutral-300 px-3 py-2"
      />
      <input
        type="password"
        placeholder="New password (12+ characters)"
        required
        minLength={12}
        autoComplete="new-password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        className="rounded border border-neutral-300 px-3 py-2"
      />
      <button
        type="submit"
        disabled={busy}
        className="self-start rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
      >
        {busy ? "Changing…" : "Change password"}
      </button>
      {message ? (
        <p className={`text-sm ${message.ok ? "text-green-700" : "text-red-600"}`}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
