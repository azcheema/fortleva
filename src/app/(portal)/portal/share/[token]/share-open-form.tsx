"use client";

import { CopyIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { fieldLabelKey, isMultilineSecret } from "@/app/(tenant)/(authed)/vault/vault-shape";
import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { vaultClipboard } from "@/components/vault/vault-clipboard";
import type { SharedSecret } from "@/modules/vault";

import { openShareLinkAction, sendShareCodeAction } from "./actions";

/** Never the value's length: a hidden value is always the same row of dots. */
const MASK = "••••••••••";

/**
 * THE SHARE PAGE'S THREE STEPS (slice 90): ask for a code — it goes to the
 * address the link was made for, which this page never shows — type it,
 * and see the login once.
 *
 * The secret lives in this component's state and nowhere else: not in the
 * URL, not in storage, not in the server's page. Leaving or reloading the
 * page drops it, and the link is spent, which the page says before and
 * after. It is shown masked until asked for, and copied through the
 * vault's clipboard guard, which empties the clipboard again (30 s, or on
 * coming back — `src/lib/clipboard-guard.ts`).
 *
 * A refusal that means the link is DEAD refreshes the page, whose server
 * render then draws the one dead-link state; every other refusal is said
 * here, in the visitor's words.
 */
export function ShareOpenForm({ token }: { token: string }) {
  const t = useTranslations("auth.portalShare");
  const router = useRouter();
  const [step, setStep] = useState<"start" | "code">("start");
  const [secret, setSecret] = useState<SharedSecret | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; message: string } | null>(null);
  const [sending, startSend] = useTransition();
  const [opening, startOpen] = useTransition();

  const send = () =>
    startSend(async () => {
      const r = await sendShareCodeAction(token);
      if (!r.ok && r.dead) {
        router.refresh();
        return;
      }
      setMessage(r);
      // A code that went out a moment ago, or the last code still live,
      // is still worth typing: every answer but a dead link moves on.
      setStep("code");
    });

  const open = (form: HTMLFormElement) => {
    const code = new FormData(form).get("code");
    startOpen(async () => {
      const r = await openShareLinkAction(token, typeof code === "string" ? code : "");
      if (r.ok) {
        setSecret(r.secret);
        setMessage(null);
        return;
      }
      if (r.dead) {
        router.refresh();
        return;
      }
      setMessage(r);
    });
  };

  if (secret) return <SharedLogin secret={secret} />;

  return (
    <div className="flex flex-col gap-4" data-testid="share-open">
      {step === "start" ? (
        <>
          <Button type="button" size="lg" className="w-full" onClick={send} disabled={sending}>
            {sending ? t("sending") : t("sendCode")}
          </Button>
          <Button type="button" variant="ghost" className="w-full" onClick={() => setStep("code")}>
            {t("haveCode")}
          </Button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            open(e.currentTarget);
          }}
          className="flex flex-col gap-3"
          data-testid="share-code-form"
        >
          <Field label={t("code")} htmlFor="share-code" hint={t("codeHint")} required>
            <Input
              id="share-code"
              name="code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={32}
              className="font-mono"
              disabled={opening}
            />
          </Field>
          {message ? <FormMessage state={message} /> : null}
          <Button type="submit" size="lg" className="w-full" disabled={opening}>
            {opening ? t("opening") : t("open")}
          </Button>
          <Button type="button" variant="ghost" className="w-full" onClick={send} disabled={sending || opening}>
            {sending ? t("sending") : t("resend")}
          </Button>
        </form>
      )}
      <p className="text-center text-xs text-muted-foreground">{t("onceNote")}</p>
    </div>
  );
}

/** The login, once: its name, address and username as text, the secret masked until asked for. */
function SharedLogin({ secret }: { secret: SharedSecret }) {
  const t = useTranslations("auth.portalShare.shown");
  const tVault = useTranslations("vault");
  const [visible, setVisible] = useState(false);
  const multiline = isMultilineSecret(secret.field);

  const copy = (text: string) => {
    // Handed to the guard INSIDE the click (Safari honours a write only there).
    vaultClipboard()
      .copy(text)
      .then(
        () => toast.success(t("copied")),
        () => toast.error(t("copyFailed")),
      );
  };

  return (
    <div className="flex flex-col gap-4" data-testid="share-shown">
      <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">{t("once")}</p>
      <dl className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">{t("name")}</dt>
          <dd className="text-sm font-medium text-foreground">{secret.name}</dd>
        </div>
        {secret.url ? (
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">{t("url")}</dt>
            <dd className="text-sm break-all">
              <a href={secret.url} target="_blank" rel="noreferrer noopener" className="text-foreground underline">
                {secret.url}
              </a>
            </dd>
          </div>
        ) : null}
        {secret.username ? (
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">{t("username")}</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{secret.username}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => copy(secret.username!)}
                aria-label={t("copyUsername")}
                data-vault-copy=""
              >
                <CopyIcon />
              </Button>
            </dd>
          </div>
        ) : null}
        <div className="flex flex-col gap-0.5" data-slot="secret-field">
          <dt className="text-xs text-muted-foreground">{tVault(fieldLabelKey(secret.field))}</dt>
          <dd className="flex min-w-0 items-start gap-2">
            {visible ? (
              <pre
                className={
                  multiline
                    ? "max-h-64 min-w-0 flex-1 overflow-auto font-mono text-sm whitespace-pre-wrap break-all text-foreground"
                    : "min-w-0 flex-1 font-mono text-sm break-all whitespace-pre-wrap text-foreground"
                }
                data-testid="share-value"
              >
                {secret.value}
              </pre>
            ) : (
              <span className="min-w-0 flex-1 font-mono text-sm text-muted-foreground" aria-hidden="true">
                {MASK}
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? t("hide") : t("show")}
              aria-pressed={visible}
            >
              {visible ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => copy(secret.value)}
              aria-label={t("copy")}
              data-vault-copy=""
            >
              <CopyIcon />
            </Button>
          </dd>
        </div>
      </dl>
    </div>
  );
}
