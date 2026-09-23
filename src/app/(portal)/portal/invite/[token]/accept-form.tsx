"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import { AUTH_CONTROL } from "@/app/(tenant)/login/auth-shell";
import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FormResult } from "@/lib/server-actions";

import { acceptPortalInviteAction } from "./actions";

/**
 * A PASSWORD AND NOTHING ELSE (founder decision, 2026-09-23). No name,
 * no title, no telephone number. The `Contact` row is a record the
 * agency owns, and an invitee correcting their own title on it would be
 * the first write a contact ever makes to a member-owned field — the
 * name and address on this page were recorded by the member who added
 * them, and are shown above this form precisely so the reader can see
 * whose invitation they are holding.
 *
 * BOTH FIELDS ARE CONTROLLED, for AGENTS.md's standing React 19 trap: a
 * `<form action>` is reset at the start of every action, so uncontrolled
 * password inputs empty themselves the moment the submit begins. On a
 * form whose failures are a mistyped confirmation and a password one
 * character short, that means the visitor watches their typing vanish
 * under a message telling them to fix it.
 *
 * NO TOAST, AND THE REASON IS NOT THE ONE THIS COMMENT FIRST GAVE. It
 * said Sonner is mounted on the member app's shell and not the portal's,
 * which is simply false — `<Toaster>` is in the ROOT layout
 * (`src/app/layout.tsx`), above all three route groups — and a fresh
 * review caught it. (`request-form.tsx` carries the same wrong claim; it
 * is another feature's file and is recorded in PLAN §0 rather than edited
 * silently here.)
 *
 * The real reason is that a refusal on this form belongs BESIDE the
 * fields it is about: "the two passwords are not the same" is a note on
 * the second box, and a message that floats into a corner of the screen
 * for four seconds is the wrong place to say it. Success needs no
 * message at all — the action redirects and the contact is simply in.
 *
 * The bounds come from the instance that enforces them, handed down by
 * the page, so the browser's own check and the service's are the same
 * number rather than two literals that can drift.
 */
export function AcceptInviteForm({
  token,
  minLength,
  maxLength,
}: {
  token: string;
  minLength: number;
  maxLength: number;
}) {
  const t = useTranslations("auth.portalInvite");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(
    acceptPortalInviteAction,
    null,
  );
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <Field label={t("password")} htmlFor="invite-password" hint={t("passwordHint", { min: minLength })}>
        <Input
          id="invite-password"
          name="password"
          type="password"
          required
          minLength={minLength}
          maxLength={maxLength}
          autoComplete="new-password"
          className={AUTH_CONTROL}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={pending}
        />
      </Field>
      <Field label={t("confirm")} htmlFor="invite-confirm">
        <Input
          id="invite-confirm"
          name="confirm"
          type="password"
          required
          minLength={minLength}
          maxLength={maxLength}
          autoComplete="new-password"
          className={AUTH_CONTROL}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={pending}
        />
      </Field>
      <Button type="submit" size="lg" className="mt-2 w-full" disabled={pending}>
        {pending ? t("submitting") : t("submit")}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
