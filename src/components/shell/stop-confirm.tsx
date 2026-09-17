"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { updateEntryAction, type StoppedEntry } from "@/app/(tenant)/(authed)/time/actions";
import { Field } from "@/components/semantic";
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
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import { durationInputText, formatDurationClock } from "@/lib/format";

import { useScopeKeys } from "./use-hotkeys";

/**
 * THE STOP CONFIRM (UI.md rule 9; PLAN 2T "stop → inline confirm (duration
 * editable, note, billable)"; the synthesis's "no silent save").
 *
 * Stopping stays ONE tap and exact: the server stops the timer at the
 * press, and only then does this dialog show what was saved — the task,
 * the time — with the three things a member adjusts at that moment: the
 * note, the duration, and billable. "Done" saves what changed (nothing
 * changed is nothing sent) and closes; Escape or the close button keep
 * the entry exactly as stopped. A confirm that held the timer running
 * until it was answered would bill the seconds spent typing the note.
 *
 * Every explicit stop opens it — the pill, the global `T`, the quick
 * start, a task's control — through `openStopConfirm`; a stop that is a
 * side effect (starting another timer, a break, clocking out) does not.
 * ONE host, mounted once by the shell, so it opens the same over any page
 * and over the item peek.
 */

type Request = { entry: StoppedEntry; seq: number };
/**
 * The last request, whether it is still open, and whether its save is in
 * flight. The entry stays after a close, so the dialog keeps its content
 * through Radix's exit animation; and "open" lives in the module beside
 * it, not in component state, so a host that remounts never re-opens a
 * confirm that was already answered.
 */
type State = { request: Request | null; open: boolean; saving: boolean };

let state: State = { request: null, open: false, saving: false };
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const setState = (next: State) => {
  state = next;
  for (const l of listeners) l();
};
const SERVER_STATE: State = { request: null, open: false, saving: false };

export function openStopConfirm(entry: StoppedEntry): void {
  setState({ request: { entry, seq: (state.request?.seq ?? 0) + 1 }, open: true, saving: false });
}

/** Only THIS request: a save that lands after the next stop's confirm opened must not touch that one. */
const isCurrent = (seq: number) => state.request?.seq === seq;
const closeRequest = (seq: number) => {
  if (isCurrent(seq) && state.open) setState({ ...state, open: false, saving: false });
};
const setSaving = (seq: number, saving: boolean) => {
  if (isCurrent(seq)) setState({ ...state, saving });
};

export function StopConfirm() {
  const t = useTranslations("time.stopConfirm");
  const { request: current, open, saving } = useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE,
  );
  const doneRef = useRef<HTMLButtonElement>(null);
  // Focus lands on Done, never in a text field. The dialog opens only when
  // the stop has ANSWERED, a beat after the press — a field focused with its
  // text selected (what Radix does to the first tabbable) would take the
  // member's next keystrokes: a second `T`, a held one, the next task's name
  // still being typed — and an Enter would save them into the entry (review).
  // Done keeps nothing typed and closes; Shift+Tab steps back to the fields.
  // The origin is still captured first, so focus returns where the stop was
  // pressed.
  const focusReturn = useFocusReturn({
    onOpenAutoFocus: (event) => {
      event.preventDefault();
      doneRef.current?.focus();
    },
  });

  // The dialog owns the keyboard while open: its content is not a
  // suppressing layer, so a single key pressed on Done or the close button
  // would reach the page behind (in a text field it only types). `exclusive`
  // FOLLOWS `open` (the standing trap).
  useScopeKeys("modal", [], { exclusive: open });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // While a save is in flight the dialog does not close: Escape or the
        // close button would otherwise "keep the entry as stopped" in words
        // while the save lands anyway, and a refusal would toast about fields
        // that are gone.
        if (!next && current && !saving) closeRequest(current.seq);
      }}
    >
      {current ? (
        <DialogContent className="flex max-h-svh flex-col sm:max-w-md" data-testid="stop-confirm" {...focusReturn}>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <StopSummary entry={current.entry} />
          </DialogHeader>
          {/* Keyed by the request: a second stop re-seeds the fields. */}
          <StopForm key={current.seq} seq={current.seq} entry={current.entry} saving={saving} doneRef={doneRef} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function StopSummary({ entry }: { entry: StoppedEntry }) {
  const t = useTranslations("time.stopConfirm");
  const locale = useLocale();
  return (
    <DialogDescription>
      {t("summary", { label: entry.label || t("adhoc"), duration: formatDurationClock(locale, entry.durationSeconds) })}
    </DialogDescription>
  );
}

function StopForm({
  seq,
  entry,
  saving,
  doneRef,
}: {
  seq: number;
  entry: StoppedEntry;
  saving: boolean;
  doneRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const t = useTranslations("time.stopConfirm");
  const router = useRouter();
  // The duration as INPUT text — whole minutes, the spelling the parser
  // reads back. Sent only when the member changed it, so an untouched
  // entry keeps its raw seconds; and sent anchored at the END, so the
  // instant Stop was pressed stays and the start moves (a longer duration
  // can never end in the future — the service refuses that).
  const initialDuration = durationInputText(entry.durationSeconds);
  const [note, setNote] = useState(entry.description ?? "");
  const [duration, setDuration] = useState(initialDuration);
  const [billable, setBillable] = useState(entry.billable);

  const submit = async () => {
    // Not while a save is out, and not once this confirm has closed: the
    // form stays mounted (and focused) through the exit animation, where a
    // held Enter would send the same update again, or an Enter right after
    // Escape would save what Escape was meant to discard (review).
    if (saving || !isCurrent(seq) || !state.open) return;
    const patch: { description?: string | null; durationText?: string; durationAnchor?: "end"; billable?: boolean } = {};
    if (note.trim() !== (entry.description ?? "").trim()) patch.description = note.trim() === "" ? null : note.trim();
    if (duration.trim() !== initialDuration) {
      patch.durationText = duration.trim();
      patch.durationAnchor = "end";
    }
    if (entry.hasProject && billable !== entry.billable) patch.billable = billable;
    if (Object.keys(patch).length === 0) {
      closeRequest(seq);
      return;
    }
    setSaving(seq, true);
    const r = await updateEntryAction(entry.entryId, patch).catch(() => ({ ok: false, message: t("failed") }));
    setSaving(seq, false);
    if (!r.ok) {
      // The dialog stays open with what was typed: a refusal (a duration
      // the parser cannot read, an instant task's emptied note) is fixed
      // where it was made.
      toast.error(r.message);
      return;
    }
    toast.success(r.message);
    closeRequest(seq);
    router.refresh();
  };

  return (
    <form
      className="flex min-h-0 flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {/* Read-only while the save is out, never disabled: what is on screen
          is what is being saved, and focus stays where it is. */}
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
        <Field htmlFor="stop-note" label={t("note")}>
          <Input
            id="stop-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            readOnly={saving}
            placeholder={t("notePlaceholder")}
            maxLength={1000}
            autoComplete="off"
            data-testid="stop-confirm-note"
          />
        </Field>
        <Field htmlFor="stop-duration" label={t("duration")} hint={t("durationHint")}>
          <Input
            id="stop-duration"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            readOnly={saving}
            autoComplete="off"
            className="w-[12ch]"
            data-testid="stop-confirm-duration"
          />
        </Field>
        {entry.hasProject ? (
          <label className="flex items-center gap-2 text-sm">
            <NativeCheckbox
              checked={billable}
              onChange={(e) => {
                if (!saving) setBillable(e.target.checked);
              }}
              aria-readonly={saving || undefined}
              data-testid="stop-confirm-billable"
            />
            {t("billable")}
          </label>
        ) : (
          <p className="text-sm text-muted-foreground">{t("adhocNonBillable")}</p>
        )}
      </div>
      <DialogFooter>
        <Button ref={doneRef} type="submit" aria-disabled={saving || undefined} data-testid="stop-confirm-done">
          {t("done")}
        </Button>
      </DialogFooter>
    </form>
  );
}
