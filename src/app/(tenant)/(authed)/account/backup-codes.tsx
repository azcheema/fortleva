"use client";

import { KeyRoundIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import { Callout, Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { reissueBackupCodesAction, type ReissueState } from "./backup-codes-actions";

/**
 * Reissue backup codes.
 *
 * Collapsed behind a control on purpose: reissuing INVALIDATES the codes
 * you already hold, so it must not look like an inspection. It asks for
 * a live authenticator code as well as the password — see the note on
 * the server action for why both.
 *
 * The new codes are rendered here and nowhere else, once. That is the
 * same contract as enrolment, and it is why the copy says so plainly
 * rather than trusting the reader to infer it.
 */
export function BackupCodes({ enabled }: { enabled: boolean }) {
  const t = useTranslations("account.backupCodes");
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ReissueState, FormData>(
    reissueBackupCodesAction,
    null,
  );

  // Nothing to reissue without a factor, and offering it would only
  // confuse the not-yet-enrolled case that sits directly above.
  if (!enabled) return null;

  if (state?.ok) {
    return (
      <Callout tone="info" title={t("newTitle")}>
        <p className="text-sm">{t("newHint")}</p>
        <ul className="num-id mt-2 grid grid-cols-2 gap-x-6 font-mono text-xs">
          {state.codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </Callout>
    );
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">{t("lostHint")}</p>
        <Button type="button" variant="outline" className="w-fit" onClick={() => setOpen(true)}>
          <KeyRoundIcon aria-hidden="true" />
          {t("reissue")}
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Callout tone="caution" title={t("replaceTitle")}>
        {t("replaceHint")}
      </Callout>
      <Field label={t("codeLabel")} htmlFor="reissue-code" hint={t("codeHint")}>
        <Input
          id="reissue-code"
          name="code"
          inputMode="numeric"
          maxLength={6}
          pattern="[0-9]{6}"
          required
          autoComplete="one-time-code"
          className="otp-field w-40"
        />
      </Field>
      <Field label={t("passwordLabel")} htmlFor="reissue-password">
        <Input
          id="reissue-password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
        />
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
