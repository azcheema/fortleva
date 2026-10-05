"use client";

import {
  EyeOffIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  RotateCcwKeyIcon,
  Share2Icon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { Field, FormMessage, InlineEdit, RowActions, type RowAction } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import { useRun } from "@/components/use-run";
import { SecretField } from "@/components/vault/secret-field";
import { TotpField } from "@/components/vault/totp-field";
import { afterClosingLayers } from "@/lib/after-closing-layers";
import type { FormResult } from "@/lib/server-actions";

import {
  deleteCredentialAction,
  hideLoginFromClientAction,
  replaceCredentialSecretAction,
  updateCredentialAction,
} from "./actions";
import { ShareDialog } from "./share-dialog";
import { ShowToClientDialog } from "./show-to-client-dialog";
import type { VaultSurface } from "./surface";
import { fieldLabelKey, isMultilineSecret, type FieldsByType, type VaultItem } from "./vault-shape";

/** What the member may do inside the open vault (`openVault().can`). */
export type VaultRowAbilities = {
  readonly edit: boolean;
  readonly delete: boolean;
  readonly reveal: boolean;
  /** Share links (slice 90): the longest a link may live here, or null when this member may not make one. */
  readonly share: { readonly maxHours: number } | null;
  /**
   * Logins shown to clients (slice 91): `credential:change_visibility` ✦ —
   * `showToClient` only while the workspace has client logins on;
   * `hideFromClient` always, so a shown login can always be hidden.
   */
  readonly showToClient: boolean;
  readonly hideFromClient: boolean;
};

/**
 * ONE LOGIN, read-first (FOUNDER MANDATE 1): its name, username, web
 * address and notes are text until edited, saved on blur through the
 * row's `<AutoForm>`; its secrets are masked fields with the eye and the
 * copy (C52); its verbs — change the secret, delete — live in the row's
 * menu (MANDATE 2). Moving a login to another client or project is not
 * offered: the service does not either.
 *
 * One row for every vault page (slice 86): `surface` names the page, so
 * its actions revalidate it and a stale factor's step-up returns to it.
 * `showProject` is the project's badge — noise on a project's own tab,
 * where every row carries the same one.
 */
export function VaultRow({
  surface,
  item,
  can,
  fieldsByType,
  showProject,
}: {
  surface: VaultSurface;
  item: VaultItem;
  can: VaultRowAbilities;
  fieldsByType: FieldsByType;
  showProject: boolean;
}) {
  const t = useTranslations("vault.row");
  const tVault = useTranslations("vault");
  const tCommon = useTranslations("common");
  const { run } = useRun();
  const [secretOpen, setSecretOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [showOpen, setShowOpen] = useState(false);
  // A login with only an authenticator key has no field a link could share.
  const canShare = can.share !== null && item.secretFieldKeys.length > 0;

  const items: RowAction[] = [];
  if (canShare) {
    items.push({
      key: "share",
      label: tVault("share.menu"),
      icon: Share2Icon,
      onSelect: () => afterClosingLayers(() => setShareOpen(true)),
    });
  }
  // Showable: the agency's own logins have no client (C49). The DIALOG
  // stays mounted whatever the login's state, so the revalidation that
  // makes it "shown" cannot unmount it before its success is said (slice
  // 70's lesson); only the menu verb follows the state.
  const canShow = can.showToClient && item.hasClient;
  if (canShow && !item.shownToClient) {
    items.push({
      key: "show-to-client",
      label: tVault("clientView.menuShow"),
      icon: UsersIcon,
      onSelect: () => afterClosingLayers(() => setShowOpen(true)),
    });
  }
  if (can.hideFromClient && item.shownToClient) {
    // One click: it takes access away, as revoking a share link does — no
    // confirm (a confirm on a non-danger action is dead string).
    items.push({
      key: "hide-from-client",
      label: tVault("clientView.menuHide"),
      icon: EyeOffIcon,
      onSelect: () => run(() => hideLoginFromClientAction(surface, item.id)),
    });
  }
  if (can.edit) {
    items.push({
      key: "change-secret",
      label: tVault("secret.change"),
      icon: RotateCcwKeyIcon,
      onSelect: () => afterClosingLayers(() => setSecretOpen(true)),
    });
  }
  if (can.delete) {
    items.push({
      key: "delete",
      label: t("delete"),
      icon: Trash2Icon,
      tone: "danger",
      confirm: t("deleteConfirm", { name: item.name }),
      onSelect: () => run(() => deleteCredentialAction(surface, item.id)),
    });
  }

  const readOnly = !can.edit;
  const body = (
    <>
      {/* The menu stays on the name's line: on a phone the name and its
          badges wrap, the trigger never does. */}
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <KeyRoundIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <InlineEdit
            kind="text"
            name="name"
            value={item.name}
            label={t("name")}
            placeholder={item.name}
            readOnly={readOnly}
            density="table"
            fit
            inputProps={{ required: true, maxLength: 200 }}
            controlClassName="font-medium"
            display={<span className="font-medium">{item.name}</span>}
          />
          <Badge variant="neutral">{tVault(`types.${item.type}`)}</Badge>
          {showProject && item.project ? (
            <Badge variant="outline" title={item.project.name}>
              {item.project.key}
            </Badge>
          ) : null}
          {item.needsRotation ? <Badge variant="caution">{t("needsRotation")}</Badge> : null}
          {item.shownToClient ? (
            <Badge variant="brand" data-testid="client-can-see">
              {tVault("clientView.badge")}
            </Badge>
          ) : null}
        </div>
        {items.length > 0 ? <RowActions label={tCommon("actionsFor", { name: item.name })} items={items} /> : null}
      </div>
      <dl className="grid min-w-0 gap-x-4 gap-y-1 sm:grid-cols-2">
        <div className="flex min-w-0 items-center gap-2">
          <dt className="w-28 shrink-0 text-xs text-muted-foreground">{t("username")}</dt>
          <dd className="min-w-0 flex-1">
            <InlineEdit
              kind="text"
              name="username"
              value={item.username ?? ""}
              label={t("username")}
              placeholder={tCommon("notSet")}
              readOnly={readOnly}
              density="table"
              inputProps={{ maxLength: 320, autoComplete: "off" }}
            />
          </dd>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <dt className="w-28 shrink-0 text-xs text-muted-foreground">{t("url")}</dt>
          <dd className="flex min-w-0 flex-1 items-center gap-1">
            <InlineEdit
              kind="text"
              name="url"
              value={item.url ?? ""}
              label={t("url")}
              placeholder={tCommon("notSet")}
              readOnly={readOnly}
              density="table"
              inputProps={{ maxLength: 2048, inputMode: "url", autoComplete: "off" }}
              className="min-w-0 flex-1"
            />
            {item.url ? (
              <Button asChild variant="ghost" size="icon-sm">
                <a href={item.url} target="_blank" rel="noreferrer noopener" aria-label={t("openUrl", { name: item.name })}>
                  <ExternalLinkIcon />
                </a>
              </Button>
            ) : null}
          </dd>
        </div>
      </dl>
      <div className="flex min-w-0 flex-col gap-1">
        {item.secretFieldKeys.map((key) => (
          <SecretField
            key={key}
            credentialId={item.id}
            field={key}
            label={tVault(fieldLabelKey(key))}
            canReveal={can.reveal}
            multiline={isMultilineSecret(key)}
          />
        ))}
        {item.hasTotp ? <TotpField credentialId={item.id} label={tVault("totp.label")} canReveal={can.reveal} /> : null}
      </div>
      {can.edit || item.notes ? (
        <div className="flex min-w-0 items-start gap-2">
          <span className="w-28 shrink-0 pt-1.5 text-xs text-muted-foreground">{t("notes")}</span>
          <InlineEdit
            kind="multiline"
            name="notes"
            value={item.notes ?? ""}
            label={t("notes")}
            placeholder={t("addNote")}
            readOnly={readOnly}
            density="table"
            className="min-w-0 flex-1"
          />
        </div>
      ) : null}
    </>
  );

  return (
    <li className="px-3 py-3" data-testid="vault-item" data-name={item.name} data-credential-id={item.id}>
      {readOnly ? (
        <div className="flex flex-col gap-2">{body}</div>
      ) : (
        <AutoForm action={updateCredentialAction} className="flex flex-col gap-2">
          <input type="hidden" name="surface" value={surface} />
          <input type="hidden" name="credentialId" value={item.id} />
          {body}
        </AutoForm>
      )}
      {canShare && can.share ? (
        <ShareDialog
          surface={surface}
          item={item}
          maxHours={can.share.maxHours}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      ) : null}
      {canShow ? (
        <ShowToClientDialog surface={surface} item={item} open={showOpen} onOpenChange={setShowOpen} />
      ) : null}
      {can.edit ? (
        <ChangeSecretDialog
          surface={surface}
          item={item}
          fields={fieldsByType[item.type]}
          open={secretOpen}
          onOpenChange={setSecretOpen}
        />
      ) : null}
    </li>
  );
}

/**
 * CHANGE THE SECRET — the rotate gesture. A blank field keeps its value; a
 * typed one replaces it; the old value becomes a version in the history.
 * The authenticator key is replaced when typed and removed when ticked.
 * The editor never sees the old value: changing is not revealing.
 *
 * A dialog because it is a deliberate act with its own confirm, opened from
 * the row menu after the menu has gone (`afterClosingLayers`), returning
 * focus through `useFocusReturn` since it has no trigger of its own. The
 * form lives INSIDE the content, which Radix unmounts on close — so every
 * opening starts blank, its action state included: nothing typed, and no
 * earlier refusal, survives a close (slice 85's code review).
 */
function ChangeSecretDialog({
  surface,
  item,
  fields,
  open,
  onOpenChange,
}: {
  surface: VaultSurface;
  item: VaultItem;
  /** The type's secret field names, in display order. */
  fields: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("vault.secret");
  const focusReturn = useFocusReturn();
  // Stable, so the form's success effect runs once per success.
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent {...focusReturn} className="sm:max-w-md" data-testid="change-secret-dialog">
        <DialogHeader>
          <DialogTitle>{t("title", { name: item.name })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <ChangeSecretForm surface={surface} item={item} fields={fields} onDone={close} />
      </DialogContent>
    </Dialog>
  );
}

function ChangeSecretForm({
  surface,
  item,
  fields,
  onDone,
}: {
  surface: VaultSurface;
  item: VaultItem;
  fields: readonly string[];
  onDone: () => void;
}) {
  const t = useTranslations("vault");
  const tCommon = useTranslations("common");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(replaceCredentialSecretAction, null);

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message);
      onDone();
    }
  }, [state, onDone]);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="surface" value={surface} />
      <input type="hidden" name="credentialId" value={item.id} />
      {fields.map((key) => (
        <Field key={key} label={t(fieldLabelKey(key))} htmlFor={`cs-${item.id}-${key}`}>
          {isMultilineSecret(key) ? (
            <Textarea
              id={`cs-${item.id}-${key}`}
              name={`secret.${key}`}
              rows={4}
              className="font-mono text-xs"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={pending}
            />
          ) : (
            <Input
              id={`cs-${item.id}-${key}`}
              name={`secret.${key}`}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="secret-mask font-mono"
              data-lpignore="true"
              data-1p-ignore=""
              disabled={pending}
            />
          )}
        </Field>
      ))}
      <Field label={t("secret.totp")} htmlFor={`cs-${item.id}-totp`} hint={t("add.totpHint")}>
        <Input id={`cs-${item.id}-totp`} name="totp" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={pending} />
      </Field>
      {item.hasTotp ? (
        <Label className="flex items-center gap-2.5 font-normal">
          <Checkbox name="removeTotp" value="1" disabled={pending} />
          {t("secret.removeTotp")}
        </Label>
      ) : null}
      {state && !state.ok ? <FormMessage state={state} /> : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? t("secret.changing") : t("secret.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
