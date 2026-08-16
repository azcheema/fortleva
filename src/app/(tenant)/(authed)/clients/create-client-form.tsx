"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormMessage } from "@/components/form-message";
import type { FormResult } from "@/lib/server-actions";

import { createClientAction } from "./actions";

/** Title-only creation (UI.md rule 2): one required field, Enter creates and refocuses. */
export function CreateClientForm({ autoFocus = false }: { autoFocus?: boolean }) {
  const t = useTranslations("clients.create");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(
    createClientAction,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message);
      formRef.current?.reset();
      nameRef.current?.focus();
    }
  }, [state]);

  return (
    <form ref={formRef} action={action} className="flex flex-wrap items-end gap-3">
      <div className="flex min-w-56 flex-1 flex-col gap-1.5">
        <Label htmlFor="client-name">{t("name")}</Label>
        <Input
          id="client-name"
          ref={nameRef}
          name="name"
          required
          maxLength={200}
          autoFocus={autoFocus}
          placeholder={t("namePlaceholder")}
          disabled={pending}
        />
      </div>
      <div className="flex w-40 flex-col gap-1.5">
        <Label htmlFor="client-orgnr">{t("orgNr")}</Label>
        <Input id="client-orgnr" name="orgNr" maxLength={32} disabled={pending} />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? t("submitting") : t("submit")}
      </Button>
      {state && !state.ok ? <FormMessage state={state} className="basis-full" /> : null}
    </form>
  );
}
