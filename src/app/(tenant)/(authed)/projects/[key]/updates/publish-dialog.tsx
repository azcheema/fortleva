"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Callout, VISIBILITY_VALUES, VisibilityIcon, visibilityChipClass, type VisibilityValue } from "@/components/semantic";
import { Pending } from "@/components/semantic/field";
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
import { cn } from "@/lib/utils";

/**
 * THE PUBLISH DIALOG — where the audience is chosen (DATA_MODEL §6.16:
 * "the publish flow asks; portal-enabled projects default
 * CLIENT_VISIBLE"). The same two-token radiogroup the comment composer
 * uses, so "Client can see" wears the same warm pill everywhere a
 * member decides who reads their words (UI.md §10.4).
 *
 * No `DialogTrigger`: the composer's button opens it, so
 * `useFocusReturn` is spread onto the content (AGENTS.md's standing
 * trap — a trigger-less Radix dialog returns focus to nothing).
 */
export function PublishDialog({
  open,
  portalEnabled,
  privateNamed,
  checking,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  portalEnabled: boolean;
  /** Titles of private work the post's text names (slice 102) — warned about before a client reads it. */
  privateNamed: readonly string[];
  /** The private-work check is still out — Confirm waits for it (slice 102). */
  checking: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (visibility: VisibilityValue) => void;
}) {
  const t = useTranslations("projects.updates.publish");
  const tCommon = useTranslations("common");
  const focusReturn = useFocusReturn();
  const [audience, setAudience] = useState<VisibilityValue>(portalEnabled ? "CLIENT_VISIBLE" : "INTERNAL");

  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? onCancel() : undefined)}>
      <DialogContent {...focusReturn} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <p id="publish-audience-label" className="text-sm font-medium text-foreground">
            {t("audience")}
          </p>
          <div role="radiogroup" aria-labelledby="publish-audience-label" className="flex flex-wrap items-center gap-1">
            {VISIBILITY_VALUES.map((v) => {
              const selected = audience === v;
              return (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`publish-audience-${v}`}
                  onClick={() => setAudience(v)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1 border px-2 text-xs whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    selected
                      ? visibilityChipClass(v)
                      : "rounded-sm border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <VisibilityIcon value={v} />
                  {t(v)}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">{audience === "CLIENT_VISIBLE" ? t("clientHint") : t("internalHint")}</p>
          {audience === "CLIENT_VISIBLE" && !portalEnabled ? <Callout tone="caution">{t("portalOffHint")}</Callout> : null}
          {audience === "CLIENT_VISIBLE" && privateNamed.length > 0 ? (
            <Callout tone="caution" role="status">
              <span data-testid="publish-private-named">
                {t("privateNamed", {
                  names: privateNamed.slice(0, 5).join(", ") + (privateNamed.length > 5 ? ", …" : ""),
                })}
              </span>
            </Callout>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {t("back")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => onConfirm(audience)}
            disabled={busy || checking}
            data-testid="publish-confirm"
          >
            {busy || checking ? <Pending label={tCommon("loading")} /> : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
