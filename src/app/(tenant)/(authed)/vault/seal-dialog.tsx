"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import { useRun } from "@/components/use-run";

import { sealLoginAction } from "./actions";
import type { VaultSurface } from "./surface";
import type { VaultItem } from "./vault-shape";

/**
 * SEAL A LOGIN FOR ITS CLIENT (Phase 3V slice 92; founder decisions C52 (e),
 * C60) — the row menu's "Seal…". A dialog, not a one-click verb, because
 * the member should read what it means before doing something only an
 * owner can undo: the team keeps using it; the client cannot see it and no
 * share link can carry it (its open links end now); a login the client can
 * see now is hidden; only an owner unseals or deletes it. No authenticator
 * code: sealing only locks a login further, inside the vault's window.
 *
 * Mounted whatever the login's state (the row keeps it), so the
 * revalidation that makes it "sealed" cannot unmount it before its success
 * is said (slice 70's lesson); opened from the row menu after the menu has
 * gone (`afterClosingLayers`), returning focus through `useFocusReturn`
 * since it has no trigger of its own.
 */
export function SealDialog({
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
  const t = useTranslations("vault.seal");
  const tCommon = useTranslations("common");
  const focusReturn = useFocusReturn();
  const { pending, run } = useRun();
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent {...focusReturn} className="sm:max-w-md" data-testid="seal-dialog">
        <DialogHeader>
          <DialogTitle>{t("title", { name: item.name })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
          <li>{t("pointTeam")}</li>
          <li>{t("pointClient")}</li>
          {item.shownToClient ? <li>{t("pointShown")}</li> : null}
          <li>{t("pointOwners")}</li>
        </ul>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={() => run(() => sealLoginAction(surface, item.id), close)}
          >
            {pending ? t("submitting") : t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
