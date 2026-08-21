"use client";

import { SendIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useRef } from "react";

import { InlineConfirm } from "@/components/inline-confirm";
import { Field, FormMessage } from "@/components/semantic";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { publishNoticeAction, type TimeSettingsFormState } from "./actions";

/**
 * Publish a new staff-notice version (SECURITY.md §9.7.5): both locales
 * at once, prefilled with the current text. Publishing is consequential
 * — every member must read it again before their next timer — so the
 * button asks in place (UI.md §5.9) at neutral weight: it is not
 * destructive, it is a commitment. Submission is the form's own
 * requestSubmit, so the server action sees the real FormData.
 */
export function NoticePublishForm({
  texts,
  nextVersion,
}: {
  texts: { locale: string; title: string; body: string }[];
  nextVersion: number;
}) {
  const t = useTranslations("settings.time.notice.publish");
  const tCommon = useTranslations("common");
  const [state, action, pending] = useActionState<TimeSettingsFormState, FormData>(publishNoticeAction, null);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-4" data-testid="notice-publish-form">
      {texts.map((x) => (
        <fieldset key={x.locale} className="flex flex-col gap-3" disabled={pending}>
          <legend className="eyebrow text-muted-foreground">{tCommon(`languageName.${x.locale}` as "languageName.en")}</legend>
          <Field htmlFor={`notice-title-${x.locale}`} label={t("titleField")} required>
            <Input id={`notice-title-${x.locale}`} name={`title.${x.locale}`} defaultValue={x.title} required maxLength={200} />
          </Field>
          <Field htmlFor={`notice-body-${x.locale}`} label={t("bodyField")} hint={t("bodyHint")} required>
            <Textarea
              id={`notice-body-${x.locale}`}
              name={`body.${x.locale}`}
              defaultValue={x.body}
              required
              rows={12}
              className="font-mono text-xs"
            />
          </Field>
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <InlineConfirm
          label={
            <span className="inline-flex items-center gap-1.5">
              <SendIcon aria-hidden="true" className="size-3.5" />
              {pending ? t("publishing") : t("submit")}
            </span>
          }
          question={t("confirm", { version: nextVersion })}
          variant="default"
          tone="neutral"
          size="sm"
          pending={pending}
          onConfirm={() => formRef.current?.requestSubmit()}
        />
        <FormMessage state={state} className="text-xs" />
      </div>
    </form>
  );
}
