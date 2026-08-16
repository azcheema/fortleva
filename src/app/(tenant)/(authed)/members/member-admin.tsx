"use client";

import { PencilIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState } from "react";

import { FormMessage, Pending } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import {
  revokeInviteAction,
  setMemberRolesAction,
  setMemberStatusAction,
  type AdminFormState,
} from "./actions";

type RoleOption = { id: string; name: string };

/**
 * Roles, as a cluster of outline badges (DESIGN SPEC §7) rather than a
 * grid of checkboxes in every row: a members table is read a hundred
 * times for every time it is edited, and the checkbox grid made the
 * 36px rhythm impossible.
 *
 * Editing keeps exactly the same form and the same action — it just
 * moves into a popover behind one 28px pencil, which is also where the
 * save button and the result message live.
 */
export function MemberRolesForm({
  memberId,
  memberName,
  roles,
  heldRoleIds,
  canManage,
}: {
  memberId: string;
  memberName: string;
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
  const heldRoles = roles.filter((r) => held.has(r.id));

  const badges =
    heldRoles.length === 0 ? (
      <span className="text-muted-foreground">{t("none")}</span>
    ) : (
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {heldRoles.map((r) => (
          <Badge key={r.id} variant="outline">
            {r.name}
          </Badge>
        ))}
      </span>
    );

  if (!canManage) return badges;

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {badges}
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("edit", { name: memberName })}
              >
                <PencilIcon />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("edit", { name: memberName })}</TooltipContent>
        </Tooltip>
        <PopoverContent align="start" className="w-64">
          <PopoverHeader>
            <PopoverTitle>{t("title")}</PopoverTitle>
          </PopoverHeader>
          <form action={action} className="flex flex-col gap-3">
            <input type="hidden" name="memberId" value={memberId} />
            <fieldset disabled={pending} className="flex flex-col gap-2">
              {roles.map((r) => (
                <Label key={r.id} className="flex items-center gap-2 font-normal">
                  <Checkbox
                    name="roleIds"
                    value={r.id}
                    defaultChecked={held.has(r.id)}
                    disabled={pending}
                  />
                  {r.name}
                </Label>
              ))}
            </fieldset>
            <div className="flex flex-col gap-2">
              <Button type="submit" size="sm" disabled={pending} className="self-start">
                {pending ? t("saving") : t("save")}
              </Button>
              <FormMessage state={state} className="text-xs" />
            </div>
          </form>
        </PopoverContent>
      </Popover>
    </span>
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
    <form action={action} className="flex items-center justify-end gap-3">
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
    <form action={action} className="flex items-center justify-end gap-3">
      <input type="hidden" name="inviteId" value={inviteId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? <Pending label={tCommon("loading")} /> : t("revoke")}
      </Button>
      <FormMessage state={state} className="text-xs" />
    </form>
  );
}
