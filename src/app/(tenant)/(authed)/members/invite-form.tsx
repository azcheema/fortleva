"use client";

import { SendIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState } from "react";

import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { inviteMemberAction, type InviteFormState } from "./actions";

/**
 * One composed form: address, then the roles that address will arrive
 * with. The roles sit in their own bordered group rather than loose
 * checkboxes, because "which permissions am I handing out" is the
 * consequential half of an invitation and should read as one decision.
 */
export function InviteForm({ roles }: { roles: { id: string; name: string }[] }) {
  const t = useTranslations("members.invite");
  const [state, action, pending] = useActionState<InviteFormState, FormData>(
    inviteMemberAction,
    null,
  );

  return (
    <form action={action} className="flex max-w-lg flex-col gap-4">
      <Field label={t("email")} htmlFor="invite-email" hint={t("emailHint")} required>
        <Input
          id="invite-email"
          type="email"
          name="email"
          required
          autoComplete="off"
          placeholder={t("emailPlaceholder")}
        />
      </Field>
      <fieldset className="flex flex-col gap-2" disabled={pending}>
        <legend className="mb-1.5 text-sm font-medium">{t("roles")}</legend>
        <div className="flex flex-col divide-y divide-border rounded-md border border-border">
          {roles.map((r) => (
            <Label key={r.id} className="flex items-center gap-2.5 px-3 py-2 font-normal">
              <Checkbox name="roleIds" value={r.id} disabled={pending} />
              {r.name}
            </Label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("pickRole")}</p>
      </fieldset>
      <Button type="submit" disabled={pending} className="self-start">
        <SendIcon />
        {pending ? t("submitting") : t("submit")}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
