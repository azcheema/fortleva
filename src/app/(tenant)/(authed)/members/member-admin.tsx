"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FormMessage } from "@/components/form-message";

import {
  revokeInviteAction,
  setMemberRolesAction,
  setMemberStatusAction,
  type AdminFormState,
} from "./actions";

type RoleOption = { id: string; name: string };

/** Roles editor for one member: checkboxes of tenant roles, saved as a set. */
export function MemberRolesForm({
  memberId,
  roles,
  heldRoleIds,
  canManage,
}: {
  memberId: string;
  roles: RoleOption[];
  heldRoleIds: string[];
  canManage: boolean;
}) {
  const t = useTranslations("members.roles");
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    setMemberRolesAction,
    null,
  );
  const held = new Set(heldRoleIds);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="memberId" value={memberId} />
      <fieldset disabled={!canManage || pending} className="flex flex-wrap gap-x-4 gap-y-1.5">
        {roles.map((r) => (
          <Label key={r.id} className="flex items-center gap-2 font-normal">
            <Checkbox name="roleIds" value={r.id} defaultChecked={held.has(r.id)} disabled={!canManage || pending} />
            {r.name}
          </Label>
        ))}
      </fieldset>
      {canManage ? (
        <div className="flex items-center gap-3">
          <Button type="submit" variant="outline" size="xs" disabled={pending}>
            {pending ? t("saving") : t("save")}
          </Button>
          <FormMessage state={state} className="text-xs" />
        </div>
      ) : null}
    </form>
  );
}

/** Suspend / Reactivate for one member (member:remove). */
export function MemberStatusForm({
  memberId,
  status,
  isSelf,
}: {
  memberId: string;
  status: "ACTIVE" | "SUSPENDED";
  isSelf: boolean;
}) {
  const t = useTranslations("members.status");
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    setMemberStatusAction,
    null,
  );
  const suspend = status === "ACTIVE";
  const button = (
    <Button
      type="submit"
      variant={suspend ? "destructive" : "outline"}
      size="xs"
      disabled={pending || (suspend && isSelf)}
    >
      {pending ? "…" : suspend ? t("suspend") : t("reactivate")}
    </Button>
  );
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="memberId" value={memberId} />
      <input type="hidden" name="op" value={suspend ? "suspend" : "reactivate"} />
      {suspend && isSelf ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>{button}</span>
          </TooltipTrigger>
          <TooltipContent>{t("cannotSuspendSelf")}</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
      <FormMessage state={state} className="text-xs" />
    </form>
  );
}

/** Revoke button for one pending invitation (member:invite). */
export function RevokeInviteForm({ inviteId }: { inviteId: string }) {
  const t = useTranslations("members.pending");
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    revokeInviteAction,
    null,
  );
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="inviteId" value={inviteId} />
      <Button type="submit" variant="outline" size="xs" disabled={pending}>
        {pending ? "…" : t("revoke")}
      </Button>
      <FormMessage state={state} className="text-xs" />
    </form>
  );
}
