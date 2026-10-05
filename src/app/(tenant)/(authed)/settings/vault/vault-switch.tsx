"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useFocusReturn } from "@/components/ui/use-focus-return";

import { setVaultSwitchAction } from "./actions";

/**
 * ONE OF THE VAULT'S WORKSPACE SWITCHES (Phase 3V slice 91). Switching ON
 * acts at once (the service asks `settings:manage_modules` ✦ and a fresh
 * factor). Switching OFF asks first, because it is for good: every open
 * share link stops, or every login shown to a client is hidden, and
 * switching on again brings none of them back (slice 90; C59 (b)) — the
 * one sentence the member must read before pressing.
 *
 * The thumb moves only when the server agreed: a refusal never looks like
 * a revert (AGENTS.md's standing trap — the action's message is toasted,
 * and a stale factor is the step-up page, through `runForm`).
 */
export function VaultSwitch({
  name,
  on,
  canEdit,
  canTurnOn,
}: {
  name: "shareLinks" | "clientLogins";
  on: boolean;
  /** `settings:edit` — may switch it off (and, with `canTurnOn`, on). */
  canEdit: boolean;
  /** `settings:manage_modules` ✦ — switching either ON is a privilege decision (AUTHZ.md §5). */
  canTurnOn: boolean;
}) {
  const t = useTranslations(`settings.vault.${name}`);
  const tVault = useTranslations("settings.vault");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const focusReturn = useFocusReturn();

  const send = (next: boolean) =>
    start(async () => {
      const r = await setVaultSwitchAction({ key: name, on: next });
      setConfirming(false);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(r.message);
      router.refresh();
    });

  const id = `vault-switch-${name}`;
  // NOT disabled while a change is pending, only refused: the confirmation
  // closes before the refresh lands, and `useFocusReturn` must hand focus
  // back to a control that can take it — a disabled one sends it to
  // `<body>` (the code review's low).
  const disabled = !canEdit || (!on && !canTurnOn);
  return (
    <div className="flex flex-col gap-2" data-testid={id}>
      <div className="flex items-center gap-2">
        <Switch
          id={id}
          checked={on}
          disabled={disabled}
          aria-busy={pending}
          onCheckedChange={(next) => {
            if (pending) return;
            if (next) send(true);
            else setConfirming(true);
          }}
          aria-describedby={`${id}-hint`}
          className="data-checked:bg-(--tone-neutral-line)"
        />
        <Label htmlFor={id} className="font-normal">
          {on ? t("on") : t("off")}
        </Label>
      </div>
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {t("hint")}
      </p>
      {!on && canEdit && !canTurnOn ? <p className="text-xs text-muted-foreground">{tVault("ownerOnly")}</p> : null}
      <Dialog open={confirming} onOpenChange={(open) => (pending ? null : setConfirming(open))}>
        <DialogContent {...focusReturn} className="sm:max-w-md" data-testid={`${id}-confirm`}>
          <DialogHeader>
            <DialogTitle>{t("confirmTitle")}</DialogTitle>
            <DialogDescription>{t("confirmBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
              {tCommon("cancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={() => send(false)} disabled={pending}>
              {t("confirmSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
