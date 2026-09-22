"use client";

import { CheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { Callout } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmptyState,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import { matchesQuery } from "@/lib/text-match";
import { cn } from "@/lib/utils";
import { TRIAGE_REASON_MAX, TRIAGE_SNOOZE_MAX_DAYS } from "@/modules/work/triage-limits";

import type { DuplicateTarget, TriageActionInput } from "./actions";

/**
 * THE ANSWER DIALOG — Decline, Duplicate and Snooze.
 *
 * Accept is not here on purpose: it needs nothing from the member, so
 * putting it behind a dialog would be a confirmation step for the one
 * outcome nobody regrets. It fires straight from the row.
 *
 * **THE REASON FIELD IS THE POINT OF THIS FILE, AND THE COPY SAYS SO.**
 * `triage_reason` is the only string in this product a MEMBER writes and
 * a CONTACT reads — it appears on the client's portal under "Declined",
 * verbatim. A member typing here is writing to their client, and a field
 * that does not say that invites an internal note ("dupe of the thing
 * Jonas mentioned") to be published to the company that asked. The
 * callout above it is not decoration.
 *
 * **NO `autoFocus` ANYWHERE INSIDE** (the standing trap, pinned by
 * `keymap.test.ts`): `useFocusReturn` captures the origin in
 * `onOpenAutoFocus`, which Radix never dispatches when a child has
 * `autoFocus`, because React focuses that child during commit first.
 * The reason field is focused by an effect instead, after mount.
 *
 * `useFocusReturn` is spread on the content because this dialog has no
 * `DialogTrigger` — it is opened by a row's button or by a single key,
 * so Radix would return focus to a null trigger and leave it on
 * `<body>`, where no suppression guard applies and every single key acts
 * behind the layer.
 *
 * **AND IT PUSHES AN EXCLUSIVE `modal` SCOPE WHILE IT IS OPEN.**
 * `SUPPRESS_SELECTOR` deliberately does NOT list `dialog-content` (the
 * item peek IS a dialog, and suppressing dialogs would kill `S` on the
 * surface that rule exists for), and `keymap.ts` names the cure in as
 * many words: "a modal that really should own the keyboard pushes an
 * `exclusive` scope instead". Without it, `J` pressed with focus on the
 * Snooze dialog's "Tomorrow" button — not editable, not a cmdk layer —
 * reaches the lane behind the scrim and moves focus there. Four other
 * dialogs in this repo do the same thing for the same reason.
 *
 * **THE DUPLICATE PICKER OWNS ITS FILTERING AND ITS HIGHLIGHT, and the
 * first cut of this file got both wrong in the way AGENTS.md warns
 * about.** cmdk's `value` is a HIGHLIGHT, never a selection: it
 * auto-picks the first row on mount and again on every search change,
 * and with a controlled `value` it calls `onValueChange` directly. Wired
 * to the chosen id, that opened the dialog with a target the member
 * never picked and silently re-pointed it as they typed — and on a
 * search matching nothing it called back with `""`, which left the
 * confirm button enabled over a submit that did nothing. So the
 * highlight is its own state, the CHOICE only ever comes from
 * `onSelect`, and `shouldFilter` is false with the matching done here
 * (cmdk would otherwise score the member's typing against a UUID,
 * because that is what each row's `value` is). This is the shape
 * `PropertyPicker` and the palette already use.
 */

export type AnswerMode = "DECLINE" | "DUPLICATE" | "SNOOZE";

/** The snooze presets, in days. A specific date is the fourth option. */
const SNOOZE_PRESETS = [
  { key: "tomorrow", days: 1 },
  { key: "week", days: 7 },
  { key: "month", days: 30 },
] as const;

/**
 * A chosen calendar day becomes 09:00 LOCAL on that day, not midnight.
 *
 * Two reasons, and the first is a bug the other shape would have: the
 * service refuses a moment that is not in the future, so midnight of the
 * day a member picks TODAY is already past and the snooze would be
 * rejected with nothing on screen explaining why. The second is that a
 * snooze is a working-hours promise — "look at this again on the 14th"
 * means during the 14th, not at the instant it begins.
 */
function dayToInstant(day: string): string | null {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return null;
  const at = new Date(y, m - 1, d, 9, 0, 0, 0);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** `YYYY-MM-DD`, N days from today, in the member's own timezone — what
 *  an `<input type="date">` takes for `min`/`max`. */
const dayString = (days: number): string => {
  const at = new Date();
  at.setDate(at.getDate() + days);
  // Local parts, never `toISOString()`: that converts to UTC and would
  // shift the bound by a day for anyone east or west of it.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

const inDays = (days: number): string => {
  const at = new Date();
  at.setDate(at.getDate() + days);
  at.setHours(9, 0, 0, 0);
  return at.toISOString();
};

export function TriageAnswer({
  mode,
  itemKey,
  itemTitle,
  reason,
  onReasonChange,
  targets,
  targetsPending,
  busy,
  onCancel,
  onSubmit,
}: {
  /** `null` closes it. Keyed on the mode outside, so each opening starts clean. */
  mode: AnswerMode | null;
  itemKey: string;
  itemTitle: string;
  /**
   * THE REPLY, OWNED BY THE CALLER — which is not tidiness. The dialog
   * closes before the server is asked, and a refusal reopens it; held
   * here, up to 500 characters a member wrote FOR A CLIENT would be
   * thrown away by the failure they are being asked to retry.
   */
  reason: string;
  onReasonChange: (next: string) => void;
  /** The rows a duplicate may point at — loaded lazily, only for DUPLICATE. */
  targets: readonly DuplicateTarget[];
  targetsPending: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: TriageActionInput) => void;
}) {
  const t = useTranslations("projects.triage");
  const tCommon = useTranslations("common");
  const focusReturn = useFocusReturn();
  const [duplicateOfId, setDuplicateOfId] = useState<string | null>(null);
  // cmdk's own cursor. SEPARATE from the choice above — see the header.
  const [highlight, setHighlight] = useState("");
  const [query, setQuery] = useState("");
  const [day, setDay] = useState("");

  // OWN FILTERING (`shouldFilter={false}`), so the member's typing is
  // matched against the key and the title rather than against a UUID.
  const shown = useMemo(
    () => targets.filter((target) => matchesQuery(`${target.key} ${target.title}`, query)),
    [targets, query],
  );

  // The keyboard scope is pushed unconditionally-shaped but gated on
  // `mode` (the standing trap: an `exclusive` scope registered
  // unconditionally kills every key in the app).
  useScopeKeys("modal", [], { exclusive: mode !== null });

  if (mode === null) return null;

  const needsReason = mode === "DECLINE" || mode === "DUPLICATE";
  const trimmed = reason.trim();
  const canSubmit =
    !busy &&
    (mode === "SNOOZE"
      ? day !== "" && dayToInstant(day) !== null
      : trimmed.length > 0 && (mode === "DECLINE" || duplicateOfId !== null));

  const submit = () => {
    if (mode === "SNOOZE") {
      const until = dayToInstant(day);
      if (until) onSubmit({ verb: "SNOOZE", until });
      return;
    }
    if (trimmed.length === 0) return;
    if (mode === "DECLINE") {
      onSubmit({ verb: "DECLINE", reason: trimmed });
      return;
    }
    if (duplicateOfId) onSubmit({ verb: "DUPLICATE", reason: trimmed, duplicateOfId });
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onCancel()}>
      <DialogContent {...focusReturn}>
        <DialogHeader>
          <DialogTitle>{t(`answer.${mode}.title`)}</DialogTitle>
          <DialogDescription>
            {t("answer.about", { key: itemKey, title: itemTitle })}
          </DialogDescription>
        </DialogHeader>

        {mode === "SNOOZE" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {SNOOZE_PRESETS.map((preset) => (
                <Button
                  key={preset.key}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => onSubmit({ verb: "SNOOZE", until: inDays(preset.days) })}
                >
                  {t(`answer.SNOOZE.${preset.key}`)}
                </Button>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="triage-snooze-day">{t("answer.SNOOZE.dayLabel")}</Label>
              {/* `min` and `max` ARE the service's own bounds, offered
                  rather than discovered: `parseInput` refuses a moment
                  that is not in the future and one past
                  `TRIAGE_SNOOZE_MAX_DAYS`, and without these a member
                  picks a day and gets a generic error toast with nothing
                  naming the field. `min` is TOMORROW, not today, because
                  a day resolves to 09:00 local — so "today" is already
                  past for anyone working after nine, which is most of
                  them. */}
              <Input
                id="triage-snooze-day"
                type="date"
                value={day}
                min={dayString(1)}
                max={dayString(TRIAGE_SNOOZE_MAX_DAYS)}
                disabled={busy}
                onChange={(e) => setDay(e.target.value)}
              />
            </div>
          </div>
        ) : null}

        {mode === "DUPLICATE" ? (
          <div className="flex flex-col gap-1.5">
            <Label>{t("answer.DUPLICATE.targetLabel")}</Label>
            {/* `vimBindings` is false through our own `Command` wrapper
                (cmdk defaults it TRUE, which shadows the global ⌘K on
                Windows and Linux). The picker is the dialog's own list,
                so a `value` is controlled here rather than read back. */}
            <Command
              shouldFilter={false}
              value={highlight}
              onValueChange={setHighlight}
              disablePointerSelection
            >
              <CommandInput
                placeholder={t("answer.DUPLICATE.search")}
                value={query}
                onValueChange={setQuery}
              />
              <CommandList>
                {/* GATED, because `CommandEmptyState` is a plain div with
                    no logic of its own — it exists for callers that own
                    their filtering, and cmdk's own `CommandEmpty` cannot
                    fire under `shouldFilter={false}`. Rendered
                    unconditionally it sat above the populated list
                    saying there was nothing in it. */}
                {!targetsPending && shown.length === 0 ? (
                  <CommandEmptyState>{t("answer.DUPLICATE.noTargets")}</CommandEmptyState>
                ) : null}
                <CommandGroup>
                  {shown.map((target) => (
                    <CommandItem
                      key={target.id}
                      value={target.id}
                      // THE ONLY PLACE A CHOICE IS MADE. cmdk's `value`
                      // above is a cursor; this is the member.
                      onSelect={() => setDuplicateOfId(target.id)}
                    >
                      <CheckIcon
                        aria-hidden="true"
                        className={cn(
                          "size-3.5 shrink-0",
                          target.id === duplicateOfId ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="num-id shrink-0 font-mono text-xs text-muted-foreground">
                        {target.key}
                      </span>
                      <span className="truncate">{target.title}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </div>
        ) : null}

        {needsReason ? (
          <div className="flex flex-col gap-1.5">
            {/* THE WARNING IS THE FEATURE. Everywhere else in this app a
                member types for their colleagues; here they type for the
                client, and the tone that means "a client can see this"
                is `caution` (UI.md §10.4). */}
            <Callout tone="caution">
              {t("answer.clientReads")}
            </Callout>
            <Label htmlFor="triage-reason">{t("answer.reasonLabel")}</Label>
            <Textarea
              id="triage-reason"
              value={reason}
              disabled={busy}
              maxLength={TRIAGE_REASON_MAX}
              rows={4}
              placeholder={t(`answer.${mode}.placeholder`)}
              onChange={(e) => onReasonChange(e.target.value)}
            />
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            {tCommon("cancel")}
          </Button>
          <Button type="button" onClick={submit} disabled={!canSubmit}>
            {t(`answer.${mode}.confirm`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
