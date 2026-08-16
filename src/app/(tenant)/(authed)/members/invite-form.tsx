"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormMessage } from "@/components/form-message";

import { inviteMemberAction, type InviteFormState } from "./actions";

export function InviteForm({ roles }: { roles: { id: string; name: string }[] }) {
  const t = useTranslations("members.invite");
  const [state, action, pending] = useActionState<InviteFormState, FormData>(
    inviteMemberAction,
    null,
  );

  return (
    <form action={action} className="flex max-w-md flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="invite-email">{t("email")}</Label>
        <Input
          id="invite-email"
          type="email"
          name="email"
          required
          placeholder={t("emailPlaceholder")}
        />
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm font-medium">{t("roles")}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {roles.map((r) => (
            <Label key={r.id} className="flex items-center gap-2 font-normal">
              <Checkbox name="roleIds" value={r.id} />
              {r.name}
            </Label>
          ))}
        </div>
      </fieldset>
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? t("submitting") : t("submit")}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
