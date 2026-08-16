"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormMessage } from "@/components/form-message";

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
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="step-up-code">{t("label")}</Label>
        <Input
          id="step-up-code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={32}
          required
          autoFocus
          className="text-center text-lg tracking-widest"
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? t("verifying") : t("verify")}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
