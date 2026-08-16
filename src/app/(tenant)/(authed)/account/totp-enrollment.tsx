"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import QRCode from "qrcode";
import { useState } from "react";

import { authClient } from "@/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Stage =
  | { step: "idle" }
  | { step: "scan"; qrDataUrl: string; totpUri: string; backupCodes: string[] }
  | { step: "done"; backupCodes: string[] };

export function TotpEnrollment({ enabled }: { enabled: boolean }) {
  const t = useTranslations("account.totp");
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
      setError(err?.message ?? t("startFailed"));
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
      setError(err.message ?? t("mismatch"));
      return;
    }
    setStage({ step: "done", backupCodes: stage.backupCodes });
    router.refresh();
  }

  if (stage.step === "scan") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm">{t("scan")}</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- data URL */}
        <img src={stage.qrDataUrl} alt={t("qrAlt")} width={220} height={220} />
        <details className="text-xs text-muted-foreground">
          <summary>{t("cantScan")}</summary>
          <code className="break-all">{stage.totpUri}</code>
        </details>
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">{t("backupTitle")}</p>
          <ul className="mt-1 grid grid-cols-2 gap-x-6 font-mono text-xs">
            {stage.backupCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        <form onSubmit={verify} className="flex items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="totp-code">{t("codePlaceholder")}</Label>
            <Input
              id="totp-code"
              inputMode="numeric"
              maxLength={6}
              required
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-32 text-center"
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? t("verifying") : t("activate")}
          </Button>
        </form>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (stage.step === "done") {
    return (
      <p role="status" className="text-sm text-green-700">
        {t("done")}
      </p>
    );
  }

  return (
    <form onSubmit={begin} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="totp-password">{t("confirmPassword")}</Label>
        <Input
          id="totp-password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? t("starting") : t("enrol")}
      </Button>
      {error ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
