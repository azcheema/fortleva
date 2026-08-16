"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { FormMessage } from "@/components/form-message";
import type { FormResult } from "@/lib/server-actions";

import { createProjectAction } from "./actions";

/** Inline project creation: client · key · name; Enter creates the next (UI.md rule 2). */
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
    <form ref={formRef} action={action} className="flex flex-wrap items-end gap-3">
      <div className="flex w-56 flex-col gap-1.5">
        <Label htmlFor="p-client">{t("client")}</Label>
        <NativeSelect id="p-client" name="clientId" required defaultValue={clients[0]?.id} disabled={pending}>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex w-32 flex-col gap-1.5">
        <Label htmlFor="p-key">{t("key")}</Label>
        <Input
          id="p-key"
          ref={keyRef}
          name="key"
          required
          maxLength={8}
          pattern="[A-Za-z][A-Za-z0-9]{0,7}"
          placeholder={t("keyPlaceholder")}
          className="font-mono uppercase"
          autoFocus={autoFocus}
          disabled={pending}
        />
      </div>
      <div className="flex min-w-56 flex-1 flex-col gap-1.5">
        <Label htmlFor="p-name">{t("name")}</Label>
        <Input
          id="p-name"
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
