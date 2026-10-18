"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Callout, VISIBILITY_VALUES, VisibilityIcon, visibilityChipClass, type VisibilityValue } from "@/components/semantic";
import { Field, Pending } from "@/components/semantic/field";
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
import { NativeSelect } from "@/components/ui/native-select";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import { cn } from "@/lib/utils";
import { addDays } from "@/lib/week";
import { UPDATE_SCHEDULE_MAX_DAYS } from "@/modules/work/update-body";

/** A schedule's wall-clock answer (slice 135): a day and a whole hour in the member's zone. */
export type PublishLater = { readonly date: string; readonly hour: number };

/** 00:00 … 23:00 — a 24-hour clock reads the same in both languages (the summary email's picker). */
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: `${String(h).padStart(2, "0")}:00` }));

/** A new schedule's first answer: tomorrow, 09:00. */
const DEFAULT_HOUR = 9;

/**
 * THE PUBLISH DIALOG — where the audience is chosen (DATA_MODEL §6.16:
 * "the publish flow asks; portal-enabled projects default
 * CLIENT_VISIBLE"). The same two-token radiogroup the comment composer
 * uses, so "Client can see" wears the same warm pill everywhere a
 * member decides who reads their words (UI.md §10.4).
 *
 * AND WHEN (slice 135, founder decision C112): Now, or Later — a day and a
 * whole hour in the member's own zone (`timeZone`, the page's
 * `resolveTimeZone`; the server reads the same zone, never this one), from
 * today to `UPDATE_SCHEDULE_MAX_DAYS` ahead. Offered only to a member who
 * may publish (`canSchedule`); the server asks the publish code either way.
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
  canSchedule,
  timeZone,
  today,
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
  /** The member may publish, so may schedule (slice 135). */
  canSchedule: boolean;
  /** The zone the hour is read in — the member's own, else the workspace's. */
  timeZone: string;
  /** Today in `timeZone`, ISO — the first day a schedule may name. */
  today: string;
  onCancel: () => void;
  onConfirm: (visibility: VisibilityValue, later: PublishLater | null) => void;
}) {
  const t = useTranslations("projects.updates.publish");
  const tCommon = useTranslations("common");
  const focusReturn = useFocusReturn();
  const [audience, setAudience] = useState<VisibilityValue>(portalEnabled ? "CLIENT_VISIBLE" : "INTERNAL");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [date, setDate] = useState(() => addDays(today, 1));
  const [hour, setHour] = useState(DEFAULT_HOUR);
  const later = canSchedule && when === "later";
  // Publish now leaves the warning to the member; a SCHEDULED post for the
  // client that names private work would only be refused when it is due, with
  // nobody there to heed it — so Schedule waits until the lines are out (the
  // server refuses it too, UPDATE_NAMES_PRIVATE).
  const blocksSchedule = audience === "CLIENT_VISIBLE" && privateNamed.length > 0;

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
        {canSchedule ? (
          <div className="flex flex-col gap-2">
            <p id="publish-when-label" className="text-sm font-medium text-foreground">
              {t("when")}
            </p>
            <div role="radiogroup" aria-labelledby="publish-when-label" className="flex flex-wrap items-center gap-1">
              {(["now", "later"] as const).map((w) => {
                const selected = when === w;
                return (
                  <button
                    key={w}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid={`publish-when-${w}`}
                    onClick={() => setWhen(w)}
                    className={cn(
                      "inline-flex h-7 items-center rounded-sm border px-2 text-xs whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      selected
                        ? "border-border bg-accent text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {t(w === "now" ? "whenNow" : "whenLater")}
                  </button>
                );
              })}
            </div>
            {later ? (
              <>
                <div className="flex flex-wrap gap-3">
                  <Field htmlFor="publish-date" label={t("day")}>
                    <Input
                      id="publish-date"
                      type="date"
                      value={date}
                      min={today}
                      max={addDays(today, UPDATE_SCHEDULE_MAX_DAYS)}
                      onChange={(e) => setDate(e.currentTarget.value)}
                      data-testid="publish-date"
                    />
                  </Field>
                  <Field htmlFor="publish-hour" label={t("hour")} hint={t("zoneHint", { zone: timeZone })}>
                    <NativeSelect
                      id="publish-hour"
                      value={String(hour)}
                      onChange={(e) => setHour(Number(e.currentTarget.value))}
                      data-testid="publish-hour"
                    >
                      {HOURS.map((h) => (
                        <option key={h.value} value={h.value}>
                          {h.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                </div>
                <p className="text-xs text-muted-foreground">{t("laterHint")}</p>
                {blocksSchedule ? (
                  <p id="publish-later-blocked" className="text-xs text-muted-foreground" data-testid="publish-later-blocked">
                    {t("privateNamedLater")}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {t("back")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => onConfirm(audience, later ? { date, hour } : null)}
            disabled={busy || checking || (later && (date === "" || blocksSchedule))}
            aria-describedby={later && blocksSchedule ? "publish-later-blocked" : undefined}
            data-testid="publish-confirm"
          >
            {busy || checking ? <Pending label={tCommon("loading")} /> : later ? t("scheduleConfirm") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
