"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Field } from "@/components/semantic";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LOCALES } from "@/i18n/config";

import { setLocaleAction, type LocaleFormState } from "./actions";

const WORKSPACE_DEFAULT = "__default";

/**
 * Language switcher (UI.md §5.10: settings forms auto-save per field —
 * no Save button). Writes User.locale via a server action, then
 * refreshes so every server component re-renders in the new locale.
 */
export function LocaleForm({ current }: { current: string }) {
  const t = useTranslations("account.language");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [state, action, pending] = useActionState<LocaleFormState, FormData>(setLocaleAction, null);
  const [, startTransition] = useTransition();
  const [value, setValue] = useState(current || WORKSPACE_DEFAULT);

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      toast.success(state.message);
      router.refresh();
    } else {
      toast.error(state.message);
    }
  }, [state, router]);

  const onChange = (next: string) => {
    setValue(next);
    const fd = new FormData();
    fd.set("locale", next === WORKSPACE_DEFAULT ? "" : next);
    startTransition(() => action(fd));
  };

  return (
    <Field label={t("label")} htmlFor="locale">
      <Select value={value} onValueChange={onChange} disabled={pending}>
        <SelectTrigger id="locale" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={WORKSPACE_DEFAULT}>{t("workspaceDefault")}</SelectItem>
          {LOCALES.map((l) => (
            <SelectItem key={l} value={l}>
              {tCommon(`languageName.${l}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
