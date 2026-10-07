"use client";

import { useTranslations } from "next-intl";
import { startTransition, useActionState, useState } from "react";

import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { FormResult } from "@/lib/server-actions";

import { declineLoginAskAction } from "./actions";

/**
 * "WE DON'T HAVE THIS" (Phase 3V slice 98; founder decision C66 (c)) — the
 * contact the agency asked says they cannot send it, with an optional note
 * the agency's team reads. Either answer closes the ask; the team is told.
 *
 * The send form's shape (`send-login-form.tsx`): dispatched from
 * `onSubmit` in a transition so a refusal keeps what was typed, and
 * `action={action}` kept so a press before the script loads still POSTs
 * to the server action rather than putting the note in a URL. Success
 * redirects from the server (`?declined=1`).
 */
export function DeclineAskForm({ askId }: { askId: string }) {
  const t = useTranslations("portal.sendLogin.decline");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(declineLoginAskAction, null);
  const [note, setNote] = useState("");

  return (
    <form
      action={action}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
      className="flex flex-col gap-3"
      data-testid="decline-ask-form"
    >
      <input type="hidden" name="askId" value={askId} />
      <Field label={t("note")} htmlFor="decline-note" hint={t("noteHint")}>
        <Textarea
          id="decline-note"
          name="note"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={pending}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? t("sending") : t("submit")}
        </Button>
        {state && !state.ok ? <FormMessage state={state} /> : null}
      </div>
    </form>
  );
}
