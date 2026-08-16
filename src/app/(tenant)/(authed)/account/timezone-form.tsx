"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { FormResult } from "@/lib/server-actions";
import { TIMEZONES } from "@/preferences/config";

import { setTimezoneAction } from "./actions";

const WORKSPACE_DEFAULT = "";

/**
 * Personal time-zone override (UI.md §5.10: auto-save on change). Writes
 * Member.timezone for the active membership; empty = workspace default.
 */
export function TimezoneForm({ current, workspaceDefault }: { current: string | null; workspaceDefault: string }) {
  const t = useTranslations("account.timezone");
  const router = useRouter();
  const [state, action, pending] = useActionState<FormResult | null, FormData>(setTimezoneAction, null);
  const [, startTransition] = useTransition();
  const [value, setValue] = useState(current ?? WORKSPACE_DEFAULT);

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      toast.success(state.message);
      router.refresh();
    } else {
      toast.error(state.message);
    }
  }, [state, router]);

  return (
    <div className="flex max-w-xs flex-col gap-1.5">
      <Label htmlFor="member-timezone">{t("label")}</Label>
      <NativeSelect
        id="member-timezone"
        name="timezone"
        value={value}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          const fd = new FormData();
          fd.set("timezone", next);
          startTransition(() => action(fd));
        }}
      >
        <option value={WORKSPACE_DEFAULT}>{t("workspaceDefault", { zone: workspaceDefault })}</option>
        {TIMEZONES.map((z) => (
          <option key={z} value={z}>
            {z}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
