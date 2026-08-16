"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormMessage } from "@/components/form-message";
import type { FormResult } from "@/lib/server-actions";

import { createClientProjectAction } from "../actions";

/** Inline project creation under a client: key + name (UI.md rule 2). */
export function CreateClientProjectForm({ clientId }: { clientId: string }) {
  const t = useTranslations("projects.create");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(
    createClientProjectAction,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message);
      formRef.current?.reset();
      keyRef.current?.focus();
    }
  }, [state]);
  return (
    <form ref={formRef} action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="clientId" value={clientId} />
      <div className="flex w-32 flex-col gap-1.5">
        <Label htmlFor="cp-key">{t("key")}</Label>
        <Input
          id="cp-key"
          ref={keyRef}
          name="key"
          required
          maxLength={8}
          pattern="[A-Za-z][A-Za-z0-9]{0,7}"
          placeholder={t("keyPlaceholder")}
          className="font-mono uppercase"
          disabled={pending}
        />
      </div>
      <div className="flex min-w-56 flex-1 flex-col gap-1.5">
        <Label htmlFor="cp-name">{t("name")}</Label>
        <Input
          id="cp-name"
          name="name"
          required
          maxLength={200}
          placeholder={t("namePlaceholder")}
          disabled={pending}
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? t("submitting") : t("submit")}
      </Button>
      <p className="basis-full text-xs text-muted-foreground">{t("keyHint")}</p>
      {state && !state.ok ? <FormMessage state={state} className="basis-full" /> : null}
    </form>
  );
}
