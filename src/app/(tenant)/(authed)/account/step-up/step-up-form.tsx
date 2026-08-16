"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";

import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { verifyStepUpAction, type StepUpFormState } from "./actions";

export function StepUpForm({ next }: { next: string }) {
  const t = useTranslations("account.stepUp");
  const [state, action, pending] = useActionState<StepUpFormState, FormData>(
    verifyStepUpAction,
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <Field label={t("label")} htmlFor="step-up-code">
        <Input
          id="step-up-code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={32}
          required
          autoFocus
          className="num text-center font-mono text-lg tracking-[0.4em]"
        />
      </Field>
      <Button type="submit" disabled={pending}>
        {pending ? t("verifying") : t("verify")}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
