"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";

import { authClient } from "@/auth/client";

type Stage =
  | { step: "idle" }
  | { step: "scan"; qrDataUrl: string; totpUri: string; backupCodes: string[] }
  | { step: "done"; backupCodes: string[] };

export function TotpEnrollment({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>({ step: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (enabled && stage.step === "idle") {
    return null;
  }

  async function begin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: err } = await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (err || !data) {
      setError(err?.message ?? "Could not start enrollment");
      return;
    }
    const qrDataUrl = await QRCode.toDataURL(data.totpURI, { width: 220 });
    setStage({
      step: "scan",
      qrDataUrl,
      totpUri: data.totpURI,
      backupCodes: data.backupCodes,
    });
    setPassword("");
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (stage.step !== "scan") return;
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (err) {
      setError(err.message ?? "Code did not match — try the next one");
      return;
    }
    setStage({ step: "done", backupCodes: stage.backupCodes });
    router.refresh();
  }

  if (stage.step === "scan") {
    return (
      <div className="mt-3 flex flex-col gap-4">
        <p className="text-sm">
          1. Scan with your authenticator app (or add the secret manually):
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element -- data URL */}
        <img src={stage.qrDataUrl} alt="TOTP enrollment QR code" width={220} height={220} />
        <details className="text-xs text-neutral-600">
          <summary>Can&apos;t scan? Show the URI</summary>
          <code className="break-all">{stage.totpUri}</code>
        </details>
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium">Backup codes — store them in Bitwarden now:</p>
          <ul className="mt-1 grid grid-cols-2 gap-x-6 font-mono text-xs">
            {stage.backupCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        <form onSubmit={verify} className="flex items-center gap-3">
          <input
            inputMode="numeric"
            maxLength={6}
            required
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="rounded border border-neutral-300 px-3 py-2 text-center"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
          >
            {busy ? "Verifying…" : "Verify & activate"}
          </button>
        </form>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>
    );
  }

  if (stage.step === "done") {
    return (
      <p className="mt-3 text-sm text-green-700">
        Two-factor authentication is active. You&apos;ll be asked for a code at
        every sign-in.
      </p>
    );
  }

  return (
    <form onSubmit={begin} className="mt-3 flex items-center gap-3">
      <input
        type="password"
        placeholder="Confirm your password"
        required
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="rounded border border-neutral-300 px-3 py-2"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
      >
        {busy ? "Starting…" : "Enroll TOTP"}
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </form>
  );
}
