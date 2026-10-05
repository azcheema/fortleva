"use client";

import { useTranslations } from "next-intl";
import { startTransition, useActionState, useCallback, useEffect } from "react";
import { toast } from "sonner";

import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import type { FormResult } from "@/lib/server-actions";

import { showLoginToClientAction } from "./actions";
import type { VaultSurface } from "./surface";
import type { VaultItem } from "./vault-shape";

/**
 * SHOW A LOGIN TO THE CLIENT (Phase 3V slice 91; C52 (d)) — the row
 * menu's "Show to client…". A dialog, because showing ALWAYS asks for the
 * member's authenticator code (AUTHZ.md §7.5, CP4), and because the member
 * should read what it means first: the client's main contacts will be able
 * to open this login in their portal, with their password and a code
 * mailed to them each time, and every look is logged.
 *
 * Opened from the row menu after the menu has gone (`afterClosingLayers`),
 * returning focus through `useFocusReturn` since it has no trigger of its
 * own. Its form lives INSIDE the content, which Radix unmounts on close,
 * so every opening starts blank: no typed code, no earlier refusal.
 */
export function ShowToClientDialog({
  surface,
  item,
  open,
  onOpenChange,
}: {
  surface: VaultSurface;
  item: VaultItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("vault.clientView");
  const focusReturn = useFocusReturn();
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent {...focusReturn} className="sm:max-w-md" data-testid="show-to-client-dialog">
        <DialogHeader>
          <DialogTitle>{t("title", { name: item.name })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <ShowForm surface={surface} item={item} onDone={close} />
      </DialogContent>
    </Dialog>
  );
}

function ShowForm({ surface, item, onDone }: { surface: VaultSurface; item: VaultItem; onDone: () => void }) {
  const t = useTranslations("vault.clientView");
  const tCommon = useTranslations("common");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(showLoginToClientAction, null);

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message);
      onDone();
    }
  }, [state, onDone]);

  return (
    <form
      onSubmit={(e) => {
        // NOT a `<form action>`: React 19 resets one after EVERY action, a
        // refusal included (AGENTS.md's standing trap) — the share form's way.
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
      className="flex flex-col gap-3"
      data-testid="show-to-client-form"
    >
      <input type="hidden" name="surface" value={surface} />
      <input type="hidden" name="credentialId" value={item.id} />
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
        <li>{t("pointWho")}</li>
        <li>{t("pointDoor")}</li>
        <li>{t("pointLogged")}</li>
      </ul>
      <Field label={t("code")} htmlFor={`sc-${item.id}-code`} hint={t("codeHint")} required>
        <Input
          id={`sc-${item.id}-code`}
          name="code"
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={32}
          className="font-mono"
          disabled={pending}
        />
      </Field>
      {state && !state.ok ? <FormMessage state={state} /> : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? t("submitting") : t("submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
