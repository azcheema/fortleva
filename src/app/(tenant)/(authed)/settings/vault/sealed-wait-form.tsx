"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { Field } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { setSealedWaitAction } from "./actions";

/**
 * THE SEALED LOGINS' WAIT (Phase 3V slice 93; C52 (g)) — the days a
 * client's ask waits for an answer before the client may confirm it
 * themselves, then 48 hours more. 7 to 60. Submitted through `onSubmit` + a
 * transition, never `<form action>` (React 19 resets a form after every
 * action, a refusal included); the field keeps what was typed until the
 * server agrees, and a refusal is toasted, never shown as a revert.
 */
export function SealedWaitForm({ days, canEdit, min, max }: { days: number; canEdit: boolean; min: number; max: number }) {
  const t = useTranslations("settings.vault.sealedWait");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const value = Number(new FormData(e.currentTarget).get("days"));
        start(async () => {
          const r = await setSealedWaitAction(value);
          if (!r.ok) {
            toast.error(r.message);
            return;
          }
          toast.success(r.message);
          router.refresh();
        });
      }}
      className="flex flex-col gap-3"
      data-testid="sealed-wait-form"
    >
      <Field label={t("label")} htmlFor="sealed-wait-days" hint={t("hint", { min, max })} required>
        <Input
          id="sealed-wait-days"
          name="days"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          defaultValue={days}
          required
          disabled={!canEdit || pending}
          className="w-24"
        />
      </Field>
      {canEdit ? (
        <div>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? t("saving") : t("save")}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
