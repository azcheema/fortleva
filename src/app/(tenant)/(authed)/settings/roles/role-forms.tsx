"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FormMessage } from "@/components/form-message";

import {
  createRoleAction,
  deleteRoleAction,
  setRolePermissionsAction,
  type RoleFormState,
} from "./actions";

export type PermissionGroup = {
  module: string;
  permissions: { code: string; description: string; requiresMfa: boolean }[];
};

const MODULE_KEYS = [
  "core",
  "invoicing",
  "contracts",
  "reports",
  "issues",
  "documentation",
  "continuity_box",
  "portal",
] as const;
type ModuleKey = (typeof MODULE_KEYS)[number];
const isModuleKey = (m: string): m is ModuleKey => (MODULE_KEYS as readonly string[]).includes(m);

/**
 * One role's permission matrix, grouped by module. System roles render
 * read-only; custom roles are editable when the viewer holds role:edit
 * (a stale factor is resolved by the step-up redirect on save).
 */
export function RolePermissionsForm({
  role,
  groups,
  canEdit,
}: {
  role: {
    id: string;
    isSystem: boolean;
    codes: string[];
    revokedCodes: string[];
  };
  groups: PermissionGroup[];
  canEdit: boolean;
}) {
  const t = useTranslations("roles");
  const [state, action, pending] = useActionState<RoleFormState, FormData>(
    setRolePermissionsAction,
    null,
  );
  const held = new Set(role.codes);
  const revoked = new Set(role.revokedCodes);
  const editable = canEdit && !role.isSystem;

  return (
    <form action={action} className="mt-3 flex flex-col gap-3">
      <input type="hidden" name="roleId" value={role.id} />
      <fieldset disabled={!editable || pending} className="grid gap-3 sm:grid-cols-2">
        {groups.map((g) => (
          <div key={g.module} className="rounded-md border border-border p-2">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {isModuleKey(g.module) ? t(`modules.${g.module}`) : g.module}
            </p>
            <ul className="mt-1 flex flex-col gap-1 text-sm">
              {g.permissions.map((p) => (
                <li key={p.code}>
                  <Label className="flex items-start gap-2 font-normal" title={p.description}>
                    <Checkbox
                      name="codes"
                      value={p.code}
                      defaultChecked={held.has(p.code)}
                      disabled={!editable || pending}
                      className="mt-0.5"
                    />
                    <span className={held.has(p.code) ? "" : "text-muted-foreground"}>
                      <code className="font-mono text-xs">{p.code}</code>
                      {p.requiresMfa ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="ml-1 cursor-help">{"✦"}</span>
                          </TooltipTrigger>
                          <TooltipContent>{t("requiresMfa")}</TooltipContent>
                        </Tooltip>
                      ) : null}
                      {revoked.has(p.code) ? (
                        <span className="ml-1 text-xs text-amber-700">{t("tombstone")}</span>
                      ) : null}
                    </span>
                  </Label>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </fieldset>
      {editable ? (
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? t("saving") : t("save")}
          </Button>
          <FormMessage state={state} className="text-xs" />
        </div>
      ) : null}
    </form>
  );
}

export function DeleteRoleForm({ roleId, name }: { roleId: string; name: string }) {
  const t = useTranslations("roles");
  const [state, action, pending] = useActionState<RoleFormState, FormData>(
    deleteRoleAction,
    null,
  );
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="roleId" value={roleId} />
      <Button type="submit" variant="destructive" size="xs" disabled={pending}>
        {pending ? "…" : t("delete", { name })}
      </Button>
      <FormMessage state={state} className="text-xs" />
    </form>
  );
}

export function CreateRoleForm({
  templates,
}: {
  templates: { templateKey: string; displayName: string }[];
}) {
  const t = useTranslations("roles.create");
  const [state, action, pending] = useActionState<RoleFormState, FormData>(
    createRoleAction,
    null,
  );
  const [templateKey, setTemplateKey] = useState("blank");
  return (
    <form action={action} className="flex max-w-md flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="role-name">{t("name")}</Label>
        <Input id="role-name" type="text" name="name" required minLength={2} maxLength={60} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="role-description">{t("description")}</Label>
        <Input id="role-description" type="text" name="description" maxLength={200} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="role-template">{t("startFrom")}</Label>
        {/* Radix Select cannot carry an empty-string item value; "blank" maps to "" for the action. */}
        <input type="hidden" name="templateKey" value={templateKey === "blank" ? "" : templateKey} />
        <Select value={templateKey} onValueChange={setTemplateKey}>
          <SelectTrigger id="role-template" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="blank">{t("blank")}</SelectItem>
            {templates.map((tpl) => (
              <SelectItem key={tpl.templateKey} value={tpl.templateKey}>
                {t("clone", { name: tpl.displayName })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? t("submitting") : t("submit")}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
