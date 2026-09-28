"use client";

import { useEffect, useId, useLayoutEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { ESCAPE_LOCAL_ATTR } from "@/components/ui/escape-local";
import { cn } from "@/lib/utils";

/**
 * THE SHARING UI's QUESTION (Phase 3 slice 72) — "Make this task private,
 * together with 2 tasks under it, 3 comments and 1 file?" in the item
 * rail, and "Show 4 tasks to the client?" / "Make 3 tasks private…?" on
 * the backlog's selection bar. A count confirmation (UI.md §5.5) asked IN
 * PLACE, never in a modal (§5.9), and deliberately not `InlineConfirm`:
 * that one is a single inline sentence with fixed Yes / No, and this
 * question is a sentence, the consequences under it (a hand-over that
 * ends, a sign-off that is hidden, what published reports keep) and two
 * verbs that NAME the act — which is what makes it answerable.
 *
 * THE §5.9 CONTRACT, kept here once for both surfaces:
 *  · Focus moves to the confirm button when the question opens — from an
 *    effect, never `autoFocus` (keymap.test.ts scans for it: a Radix
 *    layer's focus-return capture never runs past one) — but ONLY when the
 *    caller says focus is still where the member left it (`takeFocus`).
 *    A question that lands after a round trip while the member has moved
 *    on to another field must not pull them back.
 *  · Escape and focus leaving the group cancel. The group is
 *    `data-escape-local`: inside the item peek, the sheet's Radix layer
 *    would otherwise take the Escape first and close the whole panel (the
 *    standing trap — escape-local.ts is the one honest way through).
 *  · The component NEVER moves focus on close; its caller does. `onConfirm`
 *    and `onCancel({ returnFocus: true })` must hand focus back to the
 *    control the question came from BEFORE they unmount it, so it never
 *    falls to `<body>`, where every single key acts. A cancel because
 *    focus LEFT for a real target (a click into another field, another
 *    picker's search box, Tab) says `returnFocus: false`, and the caller
 *    must leave focus where the member put it — pulling it back from a
 *    focusout aborts the member's own focus change (slice 72 review).
 *  · A PRESS on the buttons never moves focus (`mousedown` default
 *    prevented, the Toaster wrapper's trick): WebKit does not focus a
 *    button on click and moves focus to the nearest focusable ancestor —
 *    or nowhere — on mousedown, which blurred the group and cancelled the
 *    question before the click landed, so on Safari and on every iOS
 *    browser it could not be answered by pointer at all (review).
 *  · The confirm button is described by the question and its details, so
 *    a screen reader that lands on "Make all private, button" also hears
 *    what "all" is.
 *  · WITHDRAWN WITH FOCUS INSIDE — the caller unmounted it in render (its
 *    selection moved, the task went private underneath) while the member's
 *    focus was on its button: Chromium fires no blur for a removed focused
 *    node, so no cancel runs and focus would sit on `<body>`. `onWithdrawn`
 *    hands it back — called only for a REAL removal (the node is no longer
 *    connected a task later), never for StrictMode's simulated unmount,
 *    which would otherwise move focus out and cancel the question on open.
 *  · A CLICK ON ITS OWN TEXT keeps it open (the group is focusable, so the
 *    press focuses the group rather than nothing), and a WINDOW OR TAB
 *    SWITCH does not cancel it (the window losing focus is not the member
 *    leaving the question) — both cancelled it before the fix review.
 *  · `pending` is for a caller that keeps the question mounted while the
 *    answer is in flight: the buttons become `aria-disabled` and a press is
 *    swallowed — never `disabled`, which drops a focused button's focus to
 *    `<body>` (the timer control's rule). Both surfaces today close the
 *    question on confirm instead.
 */
export function VisibilityQuestion({
  question,
  details,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  onWithdrawn,
  pending = false,
  takeFocus,
  testId,
  className,
}: {
  question: string;
  /** Consequence sentences under the question — already translated. */
  details: readonly string[];
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  /** `returnFocus` is false only when focus LEFT for a real target — leave it there. */
  onCancel: (how: { returnFocus: boolean }) => void;
  /** Hand focus back when the question was withdrawn (unmounted by its caller) with focus still inside it. */
  onWithdrawn: () => void;
  pending?: boolean;
  /** REQUIRED: whether focus may move into the question now (see above). */
  takeFocus: boolean;
  testId?: string;
  className?: string;
}) {
  const questionId = useId();
  const detailsId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const withdrawn = useRef(onWithdrawn);
  useLayoutEffect(() => {
    withdrawn.current = onWithdrawn;
  });
  // A LAYOUT cleanup runs before the host node is removed, so focus is
  // still inside here if the caller withdrew the question with it there.
  useLayoutEffect(
    () => () => {
      const el = groupRef.current;
      if (!el || !el.contains(document.activeElement)) return;
      setTimeout(() => {
        if (!el.isConnected) withdrawn.current();
      }, 0);
    },
    [],
  );
  // Mount-time only: the question opens once; a re-render must not steal
  // focus back from wherever the member has since taken it.
  const takeFocusAtOpen = useRef(takeFocus);
  useEffect(() => {
    if (takeFocusAtOpen.current) confirmRef.current?.focus();
  }, []);

  const guard = (fn: () => void) => () => {
    if (pending) return;
    fn();
  };

  return (
    <div
      ref={groupRef}
      role="group"
      // Focusable, so a press on the question's own words focuses the
      // group instead of nothing — which blurred and cancelled it.
      tabIndex={-1}
      aria-labelledby={questionId}
      data-slot="visibility-question"
      data-testid={testId}
      {...{ [ESCAPE_LOCAL_ATTR]: "" }}
      className={cn("flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 p-2 text-sm outline-none", className)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) {
          e.preventDefault();
          onCancel({ returnFocus: true });
        }
      }}
      onBlur={(e) => {
        if (pending) return;
        const next = e.relatedTarget as Node | null;
        if (e.currentTarget.contains(next)) return;
        // The WINDOW lost focus (another app, another tab): focus comes back
        // here when the member does. Not a cancel.
        if (next === null && !document.hasFocus()) return;
        // Focus went to nowhere (`<body>`): hand it back. Focus went to a
        // real target: leave it there.
        onCancel({ returnFocus: next === null });
      }}
    >
      <p id={questionId} className="font-medium">
        {question}
      </p>
      {details.length > 0 ? (
        <div id={detailsId} className="flex flex-col gap-1 text-xs text-muted-foreground">
          {details.map((d) => (
            <p key={d}>{d}</p>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5" onMouseDown={(e) => e.preventDefault()}>
        <Button
          ref={confirmRef}
          type="button"
          size="sm"
          aria-disabled={pending || undefined}
          aria-describedby={details.length > 0 ? `${questionId} ${detailsId}` : questionId}
          data-testid={testId ? `${testId}-confirm` : undefined}
          onClick={guard(onConfirm)}
        >
          {confirmLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-disabled={pending || undefined}
          data-testid={testId ? `${testId}-cancel` : undefined}
          onClick={guard(() => onCancel({ returnFocus: true }))}
        >
          {cancelLabel}
        </Button>
      </div>
    </div>
  );
}
