"use client";

import QRCode from "qrcode";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useState } from "react";

import { AUTH_CONTROL, AuthShell } from "@/app/(tenant)/login/auth-shell";
import { platformAuthClient } from "@/auth/client";
import { Callout, Disclosure, Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The platform plane's entry — and, since 2026-09-09, its ONLY entry.
 *
 * Identical geometry to the member login so the product reads as one
 * system, but a shield mark and a "Platform" eyebrow: the two planes
 * must never be mistaken for one another.
 *
 * It also carries the console's MFA ramp, and that placement is the
 * anti-lockout property rather than a convenience. MFA is mandatory on
 * this plane (SECURITY.md §3.5) and requirePlatformAdmin() now enforces
 * it, so a SUPERADMIN who has never enrolled cannot reach any console
 * route to enrol from. `/ops/login` is the one path in proxy.ts's
 * PUBLIC_PATHS, which makes it the only route the gate structurally
 * cannot block — so the remedy for "you need a second factor" has to
 * live here, or it lives somewhere the person needing it cannot go.
 *
 * Both remedies end at "sign in again". An earlier version of this
 * comment justified that by claiming the enrolment-time verify "creates
 * nothing" — that was WRONG, and it is worth recording because it is the
 * kind of wrong that reads as safe. Better Auth's FIRST-enrolment verify
 * does call createSession on `/two-factor/verify-totp`, which is a fresh
 * factor path, so it stamps `mfaVerifiedAt` and the gate would accept
 * it. The signOut() below is therefore doing real work rather than
 * tidying up — but it binds this UI only. A raw HTTP client keeps that
 * stamped cookie, which is why first enrolment being reachable with the
 * password alone is a real, bounded window (SECURITY.md §3.5), and why
 * replacing an EXISTING factor is refused server-side in
 * src/auth/platform.ts rather than merely being absent from this page.
 */

type Stage =
  | { step: "credentials" }
  | { step: "totp" }
  | { step: "enrolPassword" }
  | { step: "enrolScan"; qrDataUrl: string; totpUri: string; backupCodes: string[] }
  | { step: "enrolled"; backupCodes: string[] };

function OpsLoginInner() {
  const t = useTranslations("auth");
  const router = useRouter();
  const params = useSearchParams();
  // The gate's verdict, handed over as a search param by
  // requirePlatformAdmin(). Anything unrecognised falls through to the
  // ordinary credentials form.
  const reason = params.get("reason");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [code, setCode] = useState("");
  // DERIVED from `reason`, not seeded from it. Seeding a useState with
  // a search param looked equivalent and was not: the gate's redirect is
  // a client-side navigation from /ops back into THIS segment, so the
  // component is never remounted, the initializer never re-runs, and an
  // unenrolled SUPERADMIN would loop on a plain sign-in form with no
  // message — the anti-lockout ramp unreachable by the only flow that
  // produces the param. `chosen` is the explicit override that user
  // actions set; until one does, the URL decides.
  // The override is tagged with the `reason` it was chosen under, so a
  // FRESH verdict from the gate always wins. Without the tag a stale
  // stage survives the redirect: verify a code, get bounced back for a
  // different reason entirely (`not_superadmin`, say), and the page
  // would still be showing a TOTP form whose challenge cookie is gone —
  // no message, no way back to credentials.
  const [chosen, setChosen] = useState<{ stage: Stage; forReason: string | null } | null>(null);
  const stage: Stage =
    chosen && chosen.forReason === reason
      ? chosen.stage
      : reason === "enrol"
        ? { step: "enrolPassword" }
        : { step: "credentials" };
  const setStage = (next: Stage) => setChosen({ stage: next, forReason: reason });
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
      setStage({ step: "totp" });
      return;
    }
    // Hand the stage back to the URL before navigating. The override is
    // tagged with the reason it was chosen under, which yields to a
    // DIFFERENT verdict but not to the SAME one — so after startOver()
    // from the ramp, signing in again on a still-unenrolled account
    // returns to the identical `?reason=enrol`, and without this the
    // stage would stay on `credentials` with no notice and no ramp.
    setChosen(null);
    // No factor was demanded. That USUALLY means this account has none
    // and needs the enrolment ramp — but inferring it here would also
    // catch the trusted-device branch, walking an operator who already
    // holds a working factor into replacing it. So do not infer:
    // navigate, and let requirePlatformAdmin() say which remedy applies.
    // The gate is the authority; this page only renders its verdict.
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
    // Same reason as in submitCredentials: let the gate's next verdict
    // choose the stage rather than a stale override.
    setChosen(null);
    router.push("/ops");
  }

  async function beginEnrol(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: err } = await platformAuthClient.twoFactor.enable({ password });
    if (err || !data) {
      setBusy(false);
      setError(err?.message ?? t("ops.enrolFailed"));
      return;
    }
    // The server-side row already exists at this point, so a QR failure
    // must still hand over the URI and the backup codes rather than
    // leaving the form disabled with nothing on screen.
    let qrDataUrl = "";
    try {
      qrDataUrl = await QRCode.toDataURL(data.totpURI, { width: 220 });
    } catch {
      setError(t("ops.qrFailed"));
    }
    setBusy(false);
    setStage({
      step: "enrolScan",
      qrDataUrl,
      totpUri: data.totpURI,
      backupCodes: data.backupCodes,
    });
    setPassword("");
  }

  async function activate(e: React.FormEvent) {
    e.preventDefault();
    if (stage.step !== "enrolScan") return;
    setBusy(true);
    setError(null);
    const { error: err } = await platformAuthClient.twoFactor.verifyTotp({ code });
    if (err) {
      setBusy(false);
      setError(err.message ?? t("ops.mismatch"));
      return;
    }
    // Enrolled. End the password-born session here rather than let the
    // operator walk into a redirect they cannot read (see the note at the
    // top of this file). try/finally, because a rejected signOut must not
    // strand the form: the factor now EXISTS, guardFactorMutations will
    // refuse a second enrolment, and the only copy of the backup codes is
    // on this screen. Reaching the success stage matters more than the
    // sign-out succeeding.
    try {
      await platformAuthClient.signOut();
    } catch {
      // Ignored on purpose: the next sign-in supersedes this session.
    } finally {
      setBusy(false);
      setCode("");
      // Carry the codes forward. They are shown once and can NEVER be
      // reissued: guardFactorMutations permanently refuses
      // /two-factor/generate-backup-codes and a second /two-factor/enable
      // for a SUPERADMIN, so codes not transcribed before Activate would
      // be recoverable only by database surgery. Dropping them here would
      // make the higher-privilege plane less forgiving than the member
      // one, which keeps them on its own done stage.
      setStage({ step: "enrolled", backupCodes: stage.backupCodes });
    }
  }

  async function startOver() {
    setBusy(true);
    try {
      await platformAuthClient.signOut();
    } catch {
      // Ignored: signing in again replaces whatever session survives.
    } finally {
      setBusy(false);
      setError(null);
      setPassword("");
      setTotp("");
      setStage({ step: "credentials" });
    }
  }

  const notice =
    stage.step === "enrolPassword" && reason === "enrol"
      ? t("ops.enrolRequired")
      : reason === "verify" && stage.step === "credentials"
        ? t("ops.verifyRequired")
        : null;

  const title =
    stage.step === "enrolPassword" || stage.step === "enrolScan"
      ? t("ops.enrolTitle")
      : stage.step === "enrolled"
        ? t("ops.enrolledTitle")
        : t("ops.loginTitle");

  const description =
    stage.step === "credentials"
      ? t("ops.loginSubtitle")
      : stage.step === "totp"
        ? t("login.totpHint")
        : stage.step === "enrolPassword"
          ? t("ops.enrolSubtitle")
          : stage.step === "enrolScan"
            ? t("ops.scanSubtitle")
            : t("ops.enrolledSubtitle");

  return (
    <AuthShell plane="platform" eyebrow={t("ops.eyebrow")} title={title} description={description}>
      {notice ? (
        <div className="mb-4">
          <Callout tone="caution" title={t("ops.mfaMandatory")}>
            {notice}
          </Callout>
        </div>
      ) : null}

      {stage.step === "credentials" ? (
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
      ) : null}

      {stage.step === "totp" ? (
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
              className="otp-field h-10 text-lg"
            />
          </Field>
          <Button type="submit" size="lg" className="mt-2 w-full" disabled={busy}>
            {busy ? t("login.verifying") : t("login.verify")}
          </Button>
        </form>
      ) : null}

      {stage.step === "enrolPassword" ? (
        <form onSubmit={beginEnrol} className="flex flex-col gap-4">
          <Field label={t("password")} htmlFor="enrol-password">
            <Input
              id="enrol-password"
              type="password"
              required
              autoComplete="current-password"
              className={AUTH_CONTROL}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" size="lg" className="mt-2 w-full" disabled={busy}>
            {busy ? t("login.submitting") : t("ops.enrolStart")}
          </Button>
          {/* The way out. Without it this stage is a dead end: it is
              derived from ?reason=enrol, so reloading after a successful
              enrolment (the guard then refuses a second one) or letting
              the session idle out (401) leaves the operator on a form
              that can never succeed — on the page whose whole purpose is
              anti-lockout. */}
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="w-full"
            onClick={startOver}
            disabled={busy}
          >
            {t("ops.signInAgain")}
          </Button>
        </form>
      ) : null}

      {stage.step === "enrolScan" ? (
        <div className="flex flex-col gap-4">
          {stage.qrDataUrl ? (
            <div className="w-fit rounded-card border border-border bg-card p-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- data URL */}
              <img src={stage.qrDataUrl} alt={t("ops.qrAlt")} width={220} height={220} />
            </div>
          ) : null}
          <Disclosure label={t("ops.cantScan")} className="-ml-2.5">
            <code className="num-id block break-all font-mono text-xs text-muted-foreground">
              {stage.totpUri}
            </code>
          </Disclosure>
          <Callout tone="info" title={t("ops.backupTitle")}>
            <p className="text-sm">{t("ops.backupHint")}</p>
            <ul className="num-id mt-2 grid grid-cols-2 gap-x-6 font-mono text-xs">
              {stage.backupCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </Callout>
          <form onSubmit={activate} className="flex flex-col gap-4">
            <Field label={t("ops.codePlaceholder")} htmlFor="enrol-code">
              <Input
                id="enrol-code"
                inputMode="numeric"
                maxLength={6}
                required
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="otp-field h-10 text-lg"
              />
            </Field>
            <Button type="submit" size="lg" className="w-full" disabled={busy}>
              {busy ? t("login.verifying") : t("ops.activate")}
            </Button>
          </form>
        </div>
      ) : null}

      {stage.step === "enrolled" ? (
        <div className="flex flex-col gap-4">
          <FormMessage state={{ ok: true, message: t("ops.enrolledBody") }} />
          <Callout tone="info" title={t("ops.backupTitle")}>
            <p className="text-sm">{t("ops.backupLastChance")}</p>
            <ul className="num-id mt-2 grid grid-cols-2 gap-x-6 font-mono text-xs">
              {stage.backupCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </Callout>
          <Button size="lg" className="w-full" onClick={startOver} disabled={busy}>
            {t("ops.signInAgain")}
          </Button>
        </div>
      ) : null}

      {error ? <FormMessage state={{ ok: false, message: error }} /> : null}
    </AuthShell>
  );
}

export default function OpsLoginPage() {
  // useSearchParams() needs a Suspense boundary to keep this route
  // prerenderable; without it the whole page opts into dynamic
  // rendering at build time.
  return (
    <Suspense fallback={null}>
      <OpsLoginInner />
    </Suspense>
  );
}
