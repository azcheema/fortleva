"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import type { RowAction } from "@/components/semantic";
import type { ItemSurface } from "@/lib/work-view";

import { triageAction, type TriageActionInput } from "./actions";
import { TriageAnswer } from "./triage-answer";

/**
 * "CANCEL AND REPLY" (C29) — ONE FLOW BEHIND EVERY DOOR.
 *
 * An ACCEPTED client request keeps `kind = REQUEST` for ever, every move
 * target refuses Cancelled for one (`canItemEnterState` — hidden from the
 * pickers and the drag, refused with a reason in the bulk bar), and the
 * triage lane only lists what is still in TRIAGE — so ending agreed work
 * needs
 * `triageItem`'s DECLINE, the lifecycle verb that carries the reply a
 * client reads. C29a gave it one door, the item panel's request band.
 * C29b gives it two more, a board card's menu and a backlog row's menu,
 * and they all open THIS: one dialog (the lane's own, `TriageAnswer`),
 * one action (the lane's own, `triageAction`), one place where a
 * member's words to a client are written.
 *
 * A HOOK AND NOT A COMPONENT, because the doors differ in exactly the
 * part a component would own: the band is a button in a callout, a card
 * and a row are an item in a `RowActions` menu. What they share is the
 * state — which request, the reply, the round trip — and three rules the
 * band's reviews paid for, which a second copy would have to re-learn:
 *
 *  · THE REPLY SURVIVES A REFUSAL AND NOT A DISMISSAL. The dialog closes
 *    before the server answers, so up to 500 characters written FOR A
 *    CLIENT are held here rather than in the dialog: a refusal reopens it
 *    with the words intact, because the member is being asked to retry.
 *    Dismissing it — "Go back" (or "Cancel" in the Decline mode), the ✕
 *    or Escape — clears them, because a half-sentence surviving into
 *    next week's opening would be pre-filled text in the one field that
 *    is published verbatim to a client. Opening it for a DIFFERENT
 *    request always starts blank — words written for one client must
 *    never be carried to another (the lane's rule).
 *  · THE TOAST MAY NOT PROMISE DELIVERY IT CANNOT SEE. It reads the
 *    server's `clientSees` — the row's share and the Portal tab's own
 *    blocker list, read at the write — never a surface's props
 *    (`TriageOutcome`). And the other sentence says WHILE: the reply is
 *    kept, and sharing the task later publishes it.
 *  · A FAILED ROUND TRIP IS A REFUSAL, NOT A CRASH. A server action also
 *    REJECTS — offline, a 500, a throw inside `revalidatePath` — and the
 *    band's first cut awaited it bare inside a transition, where an
 *    uncaught rejection escapes to the error boundary and takes the reply
 *    with it. The lane learned this first (`triage-lane.tsx`'s `send`).
 *
 * NO OPTIMISTIC SLICE. The row is about to leave every live view it is
 * in, and the reason has to reach the database before the client's
 * portal can show it; a card that visibly lands in Cancelled and is then
 * refused would be a failure that looks like a revert (UI.md §7.2). The
 * action revalidates the board and the backlog, and Next re-renders the
 * current route in the action's own response, so no caller refreshes.
 */

/** What the dialog and the toast need of the request being ended. */
export type EndableRequest = {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly stateCategory: string;
};

/**
 * THE MODE FOLLOWS THE CATEGORY, because the founder named the two acts
 * differently (C29, 2026-09-23). A request still in TRIAGE has had no
 * work agreed, so the word is "Decline" — what the lane says. One that
 * was ACCEPTED is work being stopped: "Cancel and reply". Both submit
 * the same DECLINE verb; only the words differ (`AnswerMode`).
 */
const endModeOf = (stateCategory: string): "DECLINE" | "CANCEL_ACCEPTED" =>
  stateCategory === "TRIAGE" ? "DECLINE" : "CANCEL_ACCEPTED";

export function useEndRequest({
  projectKey,
  origin,
  onClosed,
  onEnded,
}: {
  projectKey: string;
  /**
   * WHERE THE MEMBER IS, as the action takes it: the address an MFA
   * step-up returns to, and the item page it revalidates. An enum and
   * the item's number, never a path — the action composes the address
   * from values it has put through zod (`itemReturnTo` is an
   * open-redirect surface by its own docblock).
   */
  origin: ItemSurface;
  /**
   * The dialog closed and nothing is reopening it — dismissed, or sent
   * (the answer may still be on its way). A door opened from a MENU owns
   * where focus goes next: `useFocusReturn` records the element that had
   * focus when the dialog opened, which for a menu is the menu item, and
   * that is gone by the time the dialog closes — so without this, focus
   * falls to `<body>`, where every single key acts.
   */
  onClosed?: (item: EndableRequest) => void;
  /** The server agreed. A board card moves column here, so its door re-homes focus. */
  onEnded?: (item: EndableRequest) => void;
}): {
  /** Open the dialog for this request. Ignored while an answer is in flight. */
  begin: (item: EndableRequest) => void;
  /** An answer is in flight: one at a time, because the reply is held here. */
  pending: boolean;
  /** Whether the dialog is open — a surface that hands focus back itself waits for it to close. */
  open: boolean;
  /** "Decline…" or "Cancel and reply…", by the request's category. */
  labelFor: (item: EndableRequest) => string;
  /** The `RowActions` item for this request — refused, with the reason, while an answer is in flight. */
  rowActionFor: (item: EndableRequest) => RowAction;
  /** The dialog, or null. Render it ONCE, outside any region that owns single keys. */
  dialog: React.ReactNode;
} {
  const t = useTranslations("projects.triage");
  const tErrors = useTranslations("errors");
  const [target, setTarget] = useState<EndableRequest | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  // IN FLIGHT FOR EXACTLY AS LONG AS THE ACTION IS — set before the call,
  // cleared the moment it settles. Never a transition's `isPending`, which
  // (AGENTS.md's standing trap) stays true until the whole revalidated
  // page has re-rendered: the first cut used one, so the menus went on
  // saying "still being sent" beside a toast that said it had arrived,
  // and a dialog reopened after a refusal mounted BUSY — every control
  // disabled, so Radix's autofocus landed on its ✕, one keypress from
  // throwing the reply away (both found by review).
  const [sending, setSending] = useState(false);

  const labelFor = (item: EndableRequest) =>
    endModeOf(item.stateCategory) === "DECLINE" ? t("end.decline") : t("end.cancel");

  const begin = (item: EndableRequest) => {
    // ONE AT A TIME. The reply lives here, so a second request opened
    // while the first answer is in flight would have its words cleared
    // by that answer's success, or its dialog re-targeted by its refusal.
    if (sending) return;
    if (target?.id !== item.id) setReason("");
    setTarget(item);
    setOpen(true);
  };

  const rowActionFor = (item: EndableRequest): RowAction =>
    sending
      ? { key: "end-request", label: labelFor(item), disabled: true, disabledReason: t("end.sending") }
      : { key: "end-request", label: labelFor(item), onSelect: () => begin(item) };

  const send = async (item: EndableRequest, input: TriageActionInput) => {
    setSending(true);
    const r = await triageAction(item.id, projectKey, input, {
      surface: origin,
      itemNumber: item.number,
    }).catch((): { ok: false; message: string } => ({ ok: false, message: tErrors("generic") }));
    // Cleared BEFORE a reopen, so the dialog mounts ready: the reply field
    // takes focus, holding the words, instead of the ✕.
    setSending(false);
    if (!r.ok) {
      // The reply is still held here, so reopening loses nothing.
      toast.error(r.message);
      setOpen(true);
      return;
    }
    const key = `${projectKey}-${item.number}`;
    toast.success(
      endModeOf(item.stateCategory) === "DECLINE"
        ? t(r.value.clientSees ? "declined" : "declinedUnshared", { key })
        : t(r.value.clientSees ? "end.cancelled" : "end.cancelledUnshared", { key }),
    );
    setReason("");
    setTarget(null);
    onEnded?.(item);
  };

  const dialog =
    open && target ? (
      <TriageAnswer
        mode={endModeOf(target.stateCategory)}
        itemKey={`${projectKey}-${target.number}`}
        itemTitle={target.title}
        reason={reason}
        onReasonChange={setReason}
        // DUPLICATE's rows only; neither mode here offers them.
        targets={[]}
        targetsPending={false}
        // False whenever the dialog is open, in practice — it closes before
        // the call and reopens only after `sending` has cleared — and kept
        // honest rather than hard-coded, should that ever change.
        busy={sending}
        onCancel={() => {
          setOpen(false);
          setReason("");
          setTarget(null);
          onClosed?.(target);
        }}
        onSubmit={(input) => {
          setOpen(false);
          onClosed?.(target);
          void send(target, input);
        }}
      />
    ) : null;

  return { begin, pending: sending, open, labelFor, rowActionFor, dialog };
}
