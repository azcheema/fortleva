"use client";

import { PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { Field, FormMessage, KeyboardHint } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { FormResult } from "@/lib/server-actions";

import { createProjectAction } from "./actions";

/**
 * Inline project creation (UI.md rule 2): client · key · name on one
 * row, Enter creates and re-focuses the key so a batch of projects can
 * be typed without touching the mouse. The client stays selected
 * between creations — the common case is several projects for the same
 * workspace.
 *
 * The keyboard hint is part of the affordance, not decoration: rule 7
 * says every action shows its key where the action is.
 */
export function CreateProjectForm({
  clients,
  autoFocus = false,
}: {
  clients: { id: string; name: string }[];
  autoFocus?: boolean;
}) {
  const t = useTranslations("projects.create");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(
    createProjectAction,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message);
      const client = formRef.current?.elements.namedItem("clientId") as HTMLSelectElement | null;
      const keep = client?.value;
      formRef.current?.reset();
      if (client && keep) client.value = keep;
      keyRef.current?.focus();
    }
  }, [state]);

  return (
    <form
      ref={formRef}
      action={action}
      className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[14rem_8rem_1fr_auto]"
    >
      <Field label={t("client")} htmlFor="p-client">
        <NativeSelect
          id="p-client"
          name="clientId"
          required
          defaultValue={clients[0]?.id}
          disabled={pending}
        >
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={t("key")} htmlFor="p-key">
        <Input
          id="p-key"
          ref={keyRef}
          name="key"
          required
          maxLength={8}
          pattern="[A-Za-z][A-Za-z0-9]{0,7}"
          placeholder={t("keyPlaceholder")}
          className="num-id font-mono uppercase"
          autoFocus={autoFocus}
          disabled={pending}
        />
      </Field>
      <Field label={t("name")} htmlFor="p-name">
        <Input
          id="p-name"
          name="name"
          required
          maxLength={200}
          placeholder={t("namePlaceholder")}
          disabled={pending}
        />
      </Field>
      <Button type="submit" disabled={pending}>
        <PlusIcon />
        {pending ? t("submitting") : t("submit")}
      </Button>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:col-span-4">
        <p className="text-xs text-muted-foreground">{t("keyHint")}</p>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <KeyboardHint keys={["Enter"]} />
          {t("enterHint")}
        </span>
      </div>
      {state && !state.ok ? <FormMessage state={state} className="sm:col-span-4" /> : null}
    </form>
  );
}
