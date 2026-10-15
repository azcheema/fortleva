"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { TemplatePicker, type TemplateChoiceView } from "@/app/(tenant)/(authed)/projects/template-picker";
import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FormResult } from "@/lib/server-actions";

import { createClientProjectAction } from "../actions";

/** Inline project creation under a client: key + name (UI.md rule 2), and a template with its start date (slice 124). */
export function CreateClientProjectForm({
  clientId,
  templates,
  today,
}: {
  clientId: string;
  templates: TemplateChoiceView[];
  today: string;
}) {
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
      <Field label={t("key")} htmlFor="cp-key" className="w-36">
        <Input
          id="cp-key"
          ref={keyRef}
          name="key"
          required
          maxLength={8}
          pattern="[A-Za-z][A-Za-z0-9]{0,7}"
          placeholder={t("keyPlaceholder")}
          className="num-id font-mono uppercase"
          disabled={pending}
        />
      </Field>
      <Field label={t("name")} htmlFor="cp-name" className="min-w-56 flex-1">
        <Input
          id="cp-name"
          name="name"
          required
          maxLength={200}
          placeholder={t("namePlaceholder")}
          disabled={pending}
        />
      </Field>
      <TemplatePicker
        templates={templates}
        today={today}
        idPrefix="cp"
        disabled={pending}
        classNames={{ template: "w-56", start: "w-44" }}
      />
      <Button type="submit" disabled={pending}>
        {pending ? t("submitting") : t("submit")}
      </Button>
      <p className="basis-full text-xs text-muted-foreground">{t("keyHint")}</p>
      {state && !state.ok ? <FormMessage state={state} className="basis-full" /> : null}
    </form>
  );
}
