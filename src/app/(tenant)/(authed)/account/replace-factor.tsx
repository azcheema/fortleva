"use client";

import { SmartphoneIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import QRCode from "qrcode";
import { useActionState, useEffect, useState } from "react";

import { Callout, Disclosure, Field, FormMessage, Timeline, TimelineItem } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  confirmNewFactorAction,
  replaceFactorAction,
  type ConfirmState,
  type ReplaceState,
} from "./replace-factor-actions";

/**
 * "LOST YOUR PHONE, OR MOVING TO A NEW ONE?" (slice 84, founder decision
 * C50) — replace the authenticator from `/account`.
 *
 * Collapsed behind a control, like the reissue beside it: it ends the
 * current authenticator and every other session, so it must not look like
 * an inspection. It asks for a code from the CURRENT authenticator or an
 * unused backup code, and the password — the server action says why the
 * password is checked first.
 *
 * Then the enrolment's three steps, drawn the same way (`TotpEnrollment`):
 * scan, keep the new codes, prove the scan took. The replacement has
 * ALREADY happened by then, so the third step changes nothing; it is
 * there so a member does not leave with an app that never scanned. The
 * URI and codes live only in this component's state, shown once.
 */
type Held = { readonly totpUri: string; readonly backupCodes: readonly string[] };
type Replaced = Held & { readonly account: string; readonly at: number };

/**
 * THE NEW SECRET AND CODES OUTLIVE THIS COMPONENT, for a while (the
 * fix-pass review's low). The old factor is already dead, so losing them
 * before the new app checks out means an owner's reset — and a client-side
 * navigation (the rail, ⌘K, a `G` sequence) unmounts the component without
 * the `beforeunload` prompt below ever firing. So the first successful
 * result is kept here, in the tab's memory, for the account that made it
 * and for fifteen minutes, and coming back to `/account` shows it again;
 * it is dropped the moment the new code checks out. Written only in an
 * effect, so the server's copy of this module never holds anything, and
 * keyed by account, so another person signing in in this tab sees nothing.
 */
let carried: Replaced | null = null;
const CARRY_MS = 15 * 60_000;
const carriedFor = (account: string): Replaced | null =>
  carried && carried.account === account && Date.now() - carried.at < CARRY_MS ? carried : null;

export function ReplaceFactor({ accountId }: { accountId: string }) {
  const t = useTranslations("account.replace");
  const tTotp = useTranslations("account.totp");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ReplaceState, FormData>(replaceFactorAction, null);
  const [confirm, confirmAction, confirming] = useActionState<ConfirmState, FormData>(confirmNewFactorAction, null);
  const [qr, setQr] = useState<{ uri: string; dataUrl: string } | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [held, setHeld] = useState<Held | null>(() => carriedFor(accountId));

  // The FIRST success wins and is held: a later refusal — a stray second
  // submit whose backup code the first one spent — must not replace it.
  // Adjusted while rendering (React's pattern for state derived from a
  // change), not in an effect.
  if (state?.ok && held === null) setHeld({ totpUri: state.totpUri, backupCodes: state.backupCodes });

  // The tab's copy, for an in-app navigation (`carried`, above): written
  // once per result, dropped once the new code checks out.
  useEffect(() => {
    if (confirm?.ok) carried = null;
    else if (held && carried?.totpUri !== held.totpUri) carried = { account: accountId, at: Date.now(), ...held };
  }, [held, confirm, accountId]);

  const replaced = held;
  const replacedUri = replaced?.totpUri ?? null;

  // The QR is drawn here, never on the server: the URI carries the new
  // secret and goes nowhere it does not have to. A failure still leaves
  // the URI on screen (the enrolment's rule).
  useEffect(() => {
    if (!replacedUri) return;
    let live = true;
    QRCode.toDataURL(replacedUri, { width: 220 }).then(
      (dataUrl) => {
        if (live) setQr({ uri: replacedUri, dataUrl });
      },
      () => {
        if (live) setQrFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [replacedUri]);

  // The replacement ended the other sessions and issued fresh codes, so the
  // page's devices and codes-left are stale: redraw them under this
  // component, which keeps its state across a refresh. Keyed on the URI,
  // so the hand-over from the action's state to `held` is one refresh.
  useEffect(() => {
    if (replacedUri) router.refresh();
  }, [replacedUri, router]);

  // THE OLD FACTOR IS ALREADY DEAD (Better Auth writes the new row verified
  // because the replaced one was), and the new secret and codes exist only
  // in this tab. A reload or a closed tab would lose them — both reviews'
  // low — so the browser asks first, until step 3 passes; an in-app
  // navigation keeps them (`carried`, above).
  const unconfirmed = replaced !== null && confirm?.ok !== true;
  useEffect(() => {
    if (!unconfirmed) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // What a Chromium older than 119 needs before it will ask.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unconfirmed]);

  if (replaced) {
    const dataUrl = qr?.uri === replaced.totpUri ? qr.dataUrl : null;
    return (
      <div className="flex flex-col gap-4" data-testid="replace-factor-scan">
        <FormMessage state={{ ok: true, message: t("replaced") }} />
        {confirm?.ok ? null : <Callout tone="caution">{t("stayHint")}</Callout>}
        <Timeline>
          <TimelineItem node={<span className="text-2xs font-semibold">{1}</span>}>
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">{t("scan")}</p>
              {dataUrl ? (
                <div className="w-fit rounded-card border border-border bg-card p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element -- data URL */}
                  <img src={dataUrl} alt={tTotp("qrAlt")} width={220} height={220} />
                </div>
              ) : null}
              {qrFailed ? <p className="text-sm text-muted-foreground">{tTotp("qrFailed")}</p> : null}
              <Disclosure label={tTotp("cantScan")} className="-ml-2.5">
                <code className="num-id block break-all font-mono text-xs text-muted-foreground">
                  {replaced.totpUri}
                </code>
              </Disclosure>
            </div>
          </TimelineItem>

          <TimelineItem node={<span className="text-2xs font-semibold">{2}</span>}>
            <Callout tone="info" title={t("codesTitle")}>
              <p className="text-sm">{t("codesHint")}</p>
              <ul className="num-id mt-2 grid grid-cols-2 gap-x-6 font-mono text-xs">
                {replaced.backupCodes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </Callout>
          </TimelineItem>

          <TimelineItem node={<span className="text-2xs font-semibold">{3}</span>} last>
            {confirm?.ok ? (
              <FormMessage state={confirm} />
            ) : (
              <form action={confirmAction} className="flex flex-col gap-3">
                <div className="flex flex-wrap items-end gap-3">
                  <Field label={t("newCodeLabel")} htmlFor="replace-new-code">
                    <Input
                      id="replace-new-code"
                      name="code"
                      inputMode="numeric"
                      maxLength={6}
                      pattern="[0-9]{6}"
                      required
                      autoComplete="one-time-code"
                      className="otp-field w-32"
                    />
                  </Field>
                  <Button type="submit" disabled={confirming}>
                    {confirming ? t("checking") : t("check")}
                  </Button>
                </div>
                {confirm && !confirm.ok ? <FormMessage state={confirm} /> : null}
              </form>
            )}
          </TimelineItem>
        </Timeline>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">{t("lostHint")}</p>
        <Button type="button" variant="outline" className="w-fit" onClick={() => setOpen(true)}>
          <SmartphoneIcon aria-hidden="true" />
          {t("open")}
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="replace-factor-form">
      <Callout tone="caution" title={t("warnTitle")}>
        {t("warnHint")}
      </Callout>
      <Field label={t("codeLabel")} htmlFor="replace-code" hint={t("codeHint")}>
        <Input
          id="replace-code"
          name="code"
          required
          maxLength={64}
          autoComplete="one-time-code"
          spellCheck={false}
          className="otp-field w-48"
        />
      </Field>
      <Field label={t("passwordLabel")} htmlFor="replace-password">
        <Input id="replace-password" name="password" type="password" required autoComplete="current-password" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? t("working") : t("confirm")}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          {t("cancel")}
        </Button>
      </div>
      {state && !state.ok ? <FormMessage state={state} /> : null}
    </form>
  );
}
