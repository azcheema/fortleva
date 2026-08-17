"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useOptimistic, useTransition } from "react";
import { toast } from "sonner";

import { Field, InlineEdit } from "@/components/semantic";
import type { FormResult } from "@/lib/server-actions";

import { setNameAction } from "./actions";

/**
 * Display name on the global identity (User.name) — what every other
 * member sees in the member list, on assignments and in avatars.
 *
 * Inline edit rather than an input with a Save button (UI.md §5.10): a
 * name is read far more often than it is changed, so at rest it is the
 * value, and the control appears on click / Enter / F2.
 *
 * The value shown is optimistic, exactly as `files/visibility-select.tsx`
 * does it. `InlineEdit` re-seeds itself from the `value` prop (it is
 * keyed on it), and the identity that prop comes from is Better Auth's
 * session — which a `router.refresh()` does not always re-read in the
 * same tick as the action that changed it. Without this the control
 * snapped back to the old name for a moment even though the write had
 * succeeded, which is indistinguishable from a failed save. The server
 * value still wins once it arrives.
 *
 * Until this field existed the only way to change a name was an UPDATE
 * against the database, which bypasses validation, the audit trail and
 * Better Auth's session cache.
 */
export function NameForm({ current }: { current: string }) {
  const t = useTranslations("account.name");
  const router = useRouter();
  const [state, action, pending] = useActionState<FormResult | null, FormData>(setNameAction, null);
  const [, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(current);

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
    <Field label={t("label")} htmlFor="displayName" hint={t("hint")}>
      <InlineEdit
        kind="text"
        name="name"
        value={shown}
        label={t("label")}
        placeholder={t("placeholder")}
        hiddenInput={false}
        invalid={state ? !state.ok : false}
        inputProps={{ id: "displayName", required: true, maxLength: 80, autoComplete: "name" }}
        onCommit={(next) => {
          const trimmed = next.trim();
          if (trimmed === "" || trimmed === shown.trim() || pending) return;
          const fd = new FormData();
          fd.set("name", trimmed);
          startTransition(() => {
            setShown(trimmed);
            action(fd);
          });
        }}
      />
    </Field>
  );
}
