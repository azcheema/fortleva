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
import type { FormResult } from "@/lib/server-actions";
import { TIMEZONES } from "@/preferences/config";

import { setTimezoneAction } from "./actions";

/**
 * Personal time-zone override (UI.md §5.10: auto-save on change). Writes
 * Member.timezone for the active membership; the sentinel value maps
 * back to "" — the workspace default.
 *
 * Radix `Select`, like the language field beside it: §10.10 reserves
 * `NativeSelect` for inside `<AutoForm>` (it needs a real `change`
 * event), and this is not one. Two implementations of the same control
 * 100px apart is two arrow glyphs, two text insets and, on a phone, two
 * interaction models.
 */
const WORKSPACE_DEFAULT = "__default";

export function TimezoneForm({
  current,
  workspaceDefault,
}: {
  current: string | null;
  workspaceDefault: string;
}) {
  const t = useTranslations("account.timezone");
  const router = useRouter();
  const [state, action, pending] = useActionState<FormResult | null, FormData>(setTimezoneAction, null);
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
    // Radix cannot carry an empty-string item value; the sentinel maps to "".
    fd.set("timezone", next === WORKSPACE_DEFAULT ? "" : next);
    startTransition(() => action(fd));
  };

  return (
    <Field label={t("label")} htmlFor="member-timezone">
      <Select value={value} onValueChange={onChange} disabled={pending}>
        <SelectTrigger id="member-timezone" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={WORKSPACE_DEFAULT}>
            {t("workspaceDefault", { zone: workspaceDefault })}
          </SelectItem>
          {TIMEZONES.map((z) => (
            <SelectItem key={z} value={z}>
              {z}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
