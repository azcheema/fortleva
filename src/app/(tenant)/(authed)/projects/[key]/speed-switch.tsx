"use client";

import { useTranslations } from "next-intl";

import { Pending } from "@/components/semantic";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useRun } from "@/components/use-run";

import { setSpeedSharedAction } from "./actions";

/**
 * "SHOW TO THE CLIENT" (Phase 6 slice 118; founder decision C94 (a)) — the
 * Website speed card's one control, in its header. OFF at birth; a GATE
 * (the database derives every speed row's visibility from it), so it is
 * NOT optimistic: bound to the server value, the typed result toasted
 * (`useRun` — a refusal never looks like a revert), and the pending state
 * shown, because the action revalidates the whole project page.
 */
export function SpeedShareSwitch({
  projectId,
  projectKey,
  shown,
  disabled,
}: {
  projectId: string;
  projectKey: string;
  shown: boolean;
  disabled: boolean;
}) {
  const t = useTranslations("projects.speed");
  const tCommon = useTranslations("common");
  const { pending, run } = useRun();
  return (
    <div className="flex shrink-0 items-center gap-3">
      {pending ? <Pending label={tCommon("loading")} /> : null}
      <Label htmlFor="p-speed-shared" className="text-sm">
        {t("show")}
      </Label>
      <Switch
        id="p-speed-shared"
        data-testid="speed-switch"
        checked={shown}
        disabled={disabled || pending}
        onCheckedChange={(v) => run(() => setSpeedSharedAction(projectId, projectKey, v))}
      />
    </div>
  );
}
