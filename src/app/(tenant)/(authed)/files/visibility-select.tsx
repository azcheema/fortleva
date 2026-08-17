"use client";

import { useTranslations } from "next-intl";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";

import { VisibilityInlineEdit } from "@/components/semantic";
import type { Visibility } from "@/documents/service";

import { changeVisibilityAction } from "./actions";

/**
 * The documents table's editable visibility (SAFETY-CRITICAL, UI.md
 * §10.4). At rest it IS the `<VisibilityBadge>` — the same silhouette
 * the read-only rows wear, carrying all five channels (fill, icon,
 * shape, weight, border); the picker opens on click, Enter, Space or
 * F2 and wears the same warm fill while it is set to CLIENT_VISIBLE.
 * A 28px filled `<select>` dropped the icon and the shape, so one
 * value was rendered three ways down a four-row table.
 *
 * It is NOT wrapped in a <form action>: React resets a form once its
 * action has run, which restores a native <select> to the value the
 * server rendered — the control then showed the OLD visibility while
 * the database held the new one. Instead the action is called inside a
 * transition, and useOptimistic keeps the SERVER value authoritative:
 * the chosen value is shown while the round trip is in flight, and
 * whatever comes back from the revalidated page is what remains. A
 * failure therefore falls back to the truth *and* says so out loud —
 * this control must never revert quietly.
 */
export function VisibilitySelect({
  documentId,
  value,
  returnTo,
}: {
  documentId: string;
  value: Visibility;
  returnTo: string;
}) {
  const tErrors = useTranslations("files.errors");
  const [, startTransition] = useTransition();
  const [current, setCurrent] = useOptimistic(value);

  return (
    <VisibilityInlineEdit
      value={current}
      // There is no <AutoForm> here and no FormData to preserve, so the
      // resting hidden input would only add a stray field to any form
      // this table ever lands inside.
      hiddenInput={false}
      onCommit={(next) => {
        startTransition(async () => {
          setCurrent(next);
          const result = await changeVisibilityAction({
            documentId,
            visibility: next,
            returnTo,
          }).catch(() => ({ ok: false as const, message: tErrors("visibilityFailed") }));
          if (!result.ok) toast.error(result.message);
        });
      }}
    />
  );
}
