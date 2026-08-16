"use client";

import { ShieldCheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import QRCode from "qrcode";
import { useState } from "react";

import { authClient } from "@/auth/client";
import { Callout, Field, FormMessage, Timeline, TimelineItem } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Stage =
  | { step: "idle" }
  | { step: "scan"; qrDataUrl: string; totpUri: string; backupCodes: string[] }
  | { step: "done"; backupCodes: string[] };

/**
 * TOTP enrolment, as three states that look like three states.
 *
 * The middle one is where people give up, so it is drawn as a numbered
 * rail: scan, keep the backup codes, prove it works. The codes sit in
 * an info Callout in the mono face with tabular figures — they are
 * transcribed by hand, and a proportional 0/O is how a password
 * manager ends up with a code that does not work.
 */
export function TotpEnrollment({ enabled }: { enabled: boolean }) {
  const t = useTranslations("account.totp");
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>({ step: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (enabled && stage.step === "idle") {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-(--tone-success-fg)">
        <ShieldCheckIcon aria-hidden="true" className="size-4 shrink-0" />
        {t("activeSummary")}
      </p>
    );
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
        <Timeline>
          <TimelineItem node={<span className="text-2xs font-semibold">{1}</span>}>
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">{t("scan")}</p>
              <div className="w-fit rounded-card border border-border bg-card p-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- data URL */}
                <img src={stage.qrDataUrl} alt={t("qrAlt")} width={220} height={220} />
              </div>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  {t("cantScan")}
                </summary>
                <code className="num mt-1.5 block break-all font-mono">{stage.totpUri}</code>
              </details>
            </div>
          </TimelineItem>

          <TimelineItem node={<span className="text-2xs font-semibold">{2}</span>}>
            <Callout tone="info" title={t("backupTitle")}>
              <ul className="num mt-1 grid grid-cols-2 gap-x-6 font-mono text-xs">
                {stage.backupCodes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </Callout>
          </TimelineItem>

          <TimelineItem node={<span className="text-2xs font-semibold">{3}</span>} last>
            <form onSubmit={verify} className="flex flex-wrap items-end gap-3">
              <Field label={t("codePlaceholder")} htmlFor="totp-code">
                <Input
                  id="totp-code"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="num w-32 text-center font-mono tracking-[0.4em]"
                />
              </Field>
              <Button type="submit" disabled={busy}>
                {busy ? t("verifying") : t("activate")}
              </Button>
            </form>
          </TimelineItem>
        </Timeline>
        {error ? <FormMessage state={{ ok: false, message: error }} /> : null}
      </div>
    );
  }

  if (stage.step === "done") {
    return <FormMessage state={{ ok: true, message: t("done") }} />;
  }

  return (
    <form onSubmit={begin} className="flex flex-col gap-4">
      <Field label={t("confirmPassword")} htmlFor="totp-password" hint={t("confirmPasswordHint")}>
        <Input
          id="totp-password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="max-w-xs"
        />
      </Field>
      <Button type="submit" disabled={busy} className="self-start">
        <ShieldCheckIcon />
        {busy ? t("starting") : t("enrol")}
      </Button>
      {error ? <FormMessage state={{ ok: false, message: error }} /> : null}
    </form>
  );
}
