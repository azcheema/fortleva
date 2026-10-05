"use client";

import { LockKeyholeIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { openLoginsDoorAction, resendLoginsCodeAction, startLoginsDoorAction } from "./actions";

/**
 * THE CLIENT'S DOOR (Phase 3V slice 91; C52 (k)) — two steps: their portal
 * password, which mails them a code; then the code, which opens their
 * logins for the staff window in this session. Each time.
 *
 * Forms submit through `onSubmit` + a transition, never `<form action>`:
 * React 19 resets a form after EVERY action, a refusal included, and a
 * mistyped code would empty the field under the client (AGENTS.md's
 * standing trap). The password is read once from the form and never kept
 * in state. A refusal that means "start again" (five wrong codes, the codes
 * spent) goes back to the password step; success refreshes the page, whose
 * server render then draws the list behind the open door. The page starts
 * at the code step when this session's door is already waiting for a code
 * (the page's own read of the door says so), so a reload never sends the client back to their
 * password and a second door their mailed code no longer fits.
 */
export function LoginsDoor({
  initialStep,
}: {
  /** "code" when this session already has a door waiting for the code it was mailed (a reload, a failed mail). */
  initialStep: "password" | "code";
}) {
  const t = useTranslations("portal.logins.door");
  const router = useRouter();
  const [step, setStep] = useState<"password" | "code">(initialStep);
  const [message, setMessage] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  const [resending, startResend] = useTransition();

  const submitPassword = (form: HTMLFormElement) => {
    const password = new FormData(form).get("password");
    start(async () => {
      const r = await startLoginsDoorAction(typeof password === "string" ? password : "");
      setMessage(r);
      // A door exists either way when the mail failed: a new code is asked
      // for at the code step, not with the password again.
      if (r.ok || r.toCode) {
        form.reset();
        setStep("code");
      }
    });
  };

  const submitCode = (form: HTMLFormElement) => {
    const code = new FormData(form).get("code");
    start(async () => {
      const r = await openLoginsDoorAction(typeof code === "string" ? code : "");
      if (r.ok) {
        setMessage(null);
        router.refresh();
        return;
      }
      setMessage(r);
      if (r.restart) setStep("password");
    });
  };

  const resend = () =>
    startResend(async () => {
      const r = await resendLoginsCodeAction();
      setMessage(r);
      if (!r.ok && r.restart) setStep("password");
    });

  return (
    <div className="flex flex-col gap-4" data-testid="logins-door" data-step={step}>
      <div className="flex items-start gap-3">
        <LockKeyholeIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium text-foreground">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{step === "password" ? t("passwordIntro") : t("codeIntro")}</p>
        </div>
      </div>
      {step === "password" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitPassword(e.currentTarget);
          }}
          className="flex flex-col gap-3"
          data-testid="logins-password-form"
        >
          <Field label={t("password")} htmlFor="logins-password" required>
            <Input
              id="logins-password"
              name="password"
              type="password"
              required
              maxLength={1024}
              autoComplete="current-password"
              disabled={pending}
            />
          </Field>
          {message ? <FormMessage state={message} /> : null}
          <Button type="submit" disabled={pending}>
            {pending ? t("checking") : t("continue")}
          </Button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitCode(e.currentTarget);
          }}
          className="flex flex-col gap-3"
          data-testid="logins-code-form"
        >
          <Field label={t("code")} htmlFor="logins-code" hint={t("codeHint")} required>
            <Input
              id="logins-code"
              name="code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={32}
              className="font-mono"
              disabled={pending}
            />
          </Field>
          {message ? <FormMessage state={message} /> : null}
          {/* Not while a new code is on its way: this one would be checked
              against the code being replaced, and counted. */}
          <Button type="submit" disabled={pending || resending}>
            {pending ? t("opening") : t("open")}
          </Button>
          <Button type="button" variant="ghost" onClick={resend} disabled={pending || resending}>
            {resending ? t("sending") : t("resend")}
          </Button>
        </form>
      )}
    </div>
  );
}
