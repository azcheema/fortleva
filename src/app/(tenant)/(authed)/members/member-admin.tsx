"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";

import { FormMessage, Pending } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
    <form action={action} className="flex min-w-0 flex-col gap-1.5 py-1">
      <input type="hidden" name="memberId" value={memberId} />
      <fieldset disabled={!canManage || pending} className="flex flex-wrap gap-x-3 gap-y-1.5">
        {roles.map((r) => (
          <Label key={r.id} className="flex items-center gap-2 font-normal">
            <Checkbox name="roleIds" value={r.id} defaultChecked={held.has(r.id)} disabled={!canManage || pending} />
            {r.name}
          </Label>
        ))}
      </fieldset>
      {canManage ? (
        <div className="flex items-center gap-3">
          <Button type="submit" variant="outline" size="sm" disabled={pending}>
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
  const tCommon = useTranslations("common");
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    setMemberStatusAction,
    null,
  );
  const suspend = status === "ACTIVE";
  const button = (
    <Button
      type="submit"
      variant={suspend ? "destructive" : "outline"}
      size="sm"
      disabled={pending || (suspend && isSelf)}
    >
      {pending ? <Pending label={tCommon("loading")} /> : suspend ? t("suspend") : t("reactivate")}
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
  const tCommon = useTranslations("common");
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    revokeInviteAction,
    null,
  );
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="inviteId" value={inviteId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? <Pending label={tCommon("loading")} /> : t("revoke")}
      </Button>
      <FormMessage state={state} className="text-xs" />
    </form>
  );
}
