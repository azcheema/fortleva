"use client";

import { CheckIcon, MinusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useState, useTransition } from "react";
import { toast } from "sonner";

import { InlineConfirm } from "@/components/inline-confirm";
import { Callout, Field, FormMessage } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";

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

/** `client:view` reads faster as a quiet namespace plus a loud verb. */
function PermissionCode({ code, granted }: { code: string; granted: boolean }) {
  const [resource, verb] = code.split(":");
  return (
    <code className={cn("font-mono text-xs", granted ? "text-foreground" : "text-muted-foreground")}>
      <span className="text-muted-foreground">
        {resource}
        {":"}
      </span>
      {verb}
    </code>
  );
}

/**
 * One role's permission matrix.
 *
 * Sixty-three codes is too many to read as a wall, so the matrix is a
 * single scrolling column with a STICKY module header: whatever row
 * the eye is on, the module it belongs to is still on screen. The
 * scroll container is what makes the stickiness real — an
 * overflow-hidden card would make position:sticky inert.
 *
 * System roles render as a read-only ledger (tick / dash) rather than
 * 63 disabled checkboxes: they cannot be edited, so a checkbox would
 * be a control that lies. Custom roles get real checkboxes when the
 * viewer holds role:edit (a stale factor is resolved by the step-up
 * redirect on save).
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
      {role.isSystem ? <Callout tone="info">{t("systemReadOnly")}</Callout> : null}
      {revoked.size > 0 ? (
        <Callout tone="caution" title={t("tombstoneTitle")}>
          {t("tombstoneBody", { count: revoked.size })}
        </Callout>
      ) : null}

      <fieldset
        disabled={!editable || pending}
        className="max-h-96 overflow-y-auto rounded-md border border-border"
      >
        {groups.map((g) => (
          <div key={g.module}>
            <h4 className="hairline-b sticky top-0 z-1 bg-card px-3 py-1.5 eyebrow text-muted-foreground">
              {isModuleKey(g.module) ? t(`modules.${g.module}`) : g.module}
            </h4>
            <ul className="flex flex-col">
              {g.permissions.map((p) => {
                const granted = held.has(p.code);
                const rowClass = "flex min-h-8 items-center gap-2.5 px-3 py-1 font-normal";
                const body = (
                  <>
                    <PermissionCode code={p.code} granted={granted} />
                    {p.requiresMfa ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            role="img"
                            aria-label={t("requiresMfa")}
                            className="cursor-help text-muted-foreground"
                          >
                            {"✦"}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{t("requiresMfa")}</TooltipContent>
                      </Tooltip>
                    ) : null}
                    {revoked.has(p.code) ? (
                      <Badge variant="caution" className="ml-auto">
                        {t("tombstone")}
                      </Badge>
                    ) : null}
                  </>
                );
                return (
                  <li key={p.code} className="scroll-mt-8 border-b border-border last:border-0">
                    {editable ? (
                      <Label className={rowClass} title={p.description}>
                        <Checkbox
                          name="codes"
                          value={p.code}
                          defaultChecked={granted}
                          disabled={pending}
                        />
                        {body}
                      </Label>
                    ) : (
                      // No control to label: a system role is a ledger, so the
                      // grant state is an icon plus a word for screen readers.
                      <div className={rowClass} title={p.description}>
                        <span
                          className={cn(
                            "inline-flex size-4 shrink-0 items-center justify-center",
                            granted ? "text-(--tone-success-line)" : "text-muted-foreground",
                          )}
                        >
                          {granted ? (
                            <CheckIcon aria-hidden="true" className="size-3.5" />
                          ) : (
                            <MinusIcon aria-hidden="true" className="size-3.5" />
                          )}
                          <span className="sr-only">{granted ? t("granted") : t("notGranted")}</span>
                        </span>
                        {body}
                      </div>
                    )}
                  </li>
                );
              })}
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

/**
 * Deleting a role is destructive, so it asks (UI.md §5.9) — and it asks
 * at resting weight `outline`. The solid `--destructive` fill is spent
 * on the "Yes" of the question and nowhere else, so a page of role
 * cards is not a page of red buttons.
 */
export function DeleteRoleForm({ roleId, name }: { roleId: string; name: string }) {
  const t = useTranslations("roles");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <InlineConfirm
      label={tCommon("delete")}
      question={t("deleteConfirm", { name })}
      variant="outline"
      tone="danger"
      size="sm"
      pending={pending}
      onConfirm={() =>
        start(async () => {
          const fd = new FormData();
          fd.set("roleId", roleId);
          const r = await deleteRoleAction(null, fd);
          if (r) {
            if (r.ok) toast.success(r.message);
            else toast.error(r.message);
          }
          router.refresh();
        })
      }
    />
  );
}

export function CreateRoleForm({
  templates,
}: {
  templates: { templateKey: string; displayName: string }[];
}) {
  const t = useTranslations("roles.create");
  const [state, action, pending] = useActionState<RoleFormState, FormData>(createRoleAction, null);
  const [templateKey, setTemplateKey] = useState("blank");
  return (
    <form action={action} className="flex max-w-lg flex-col gap-4">
      <Field label={t("name")} htmlFor="role-name" required>
        <Input id="role-name" type="text" name="name" required minLength={2} maxLength={60} />
      </Field>
      <Field label={t("description")} htmlFor="role-description">
        <Input id="role-description" type="text" name="description" maxLength={200} />
      </Field>
      <Field label={t("startFrom")} htmlFor="role-template" hint={t("startFromHint")}>
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
      </Field>
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? t("submitting") : t("submit")}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
