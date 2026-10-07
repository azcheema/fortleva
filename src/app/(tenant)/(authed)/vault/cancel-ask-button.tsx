"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { useRun } from "@/components/use-run";

import { cancelLoginAskAction } from "./actions";
import type { VaultSurface } from "./surface";

/**
 * CANCEL AN OPEN ASK (Phase 3V slice 98) — one click: nothing is lost (the
 * client simply no longer sees it, and the team can ask again), so no
 * question. The vault rows' runner (`useRun`): a toast either way (AGENTS.md:
 * a failure never looks like a revert), then a refresh that redraws the row
 * as cancelled — or, if the client answered first, as what they did
 * (`LOGIN_ASK_ENDED` says so).
 */
export function CancelAskButton({ surface, askId, name }: { surface: VaultSurface; askId: string; name: string }) {
  const t = useTranslations("vault.asks");
  const { pending, run } = useRun();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={pending}
      aria-label={t("cancelLabel", { name })}
      onClick={() => run(() => cancelLoginAskAction(surface, askId))}
      data-testid="cancel-login-ask"
    >
      {t("cancel")}
    </Button>
  );
}
