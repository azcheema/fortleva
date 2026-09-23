"use client";

import { CheckIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { setTaskDoneAction } from "./actions";

/**
 * "I'VE DONE MY PART" — the one control a contact has on a task, and the
 * only interactive thing on `/portal`'s list (Phase 3 slice 6c).
 *
 * **IT IS A TOGGLE, and the retraction is not a nicety.** Nothing on the
 * member plane can clear a claim except answering it, so without an
 * untick a mis-tick would stand as a falsehood only the agency could
 * remove — by finishing work that is not finished.
 *
 * **IT CLAIMS NOTHING ABOUT THE STATE**, which is the founder's decision
 * of 2026-09-22 rendered rather than merely stored: the task stays in
 * the category the AGENCY has it in, and this line says what the CLIENT
 * told them about it. So the tick sits under the title with its own
 * words and no chip, no strikethrough and no move: a control that made
 * the row look finished would be the literal reading the decision
 * rejected, drawn instead of written.
 *
 * **NO TOAST, BECAUSE THERE IS NO TOASTER ON THIS PLANE.** Sonner is the
 * member shell's. A refusal is rendered in place, under the control that
 * produced it, and an unexplained failure is the one thing this plane
 * must never do quietly — `portal.errors.generic` is deliberately the
 * same sentence for every authorization refusal (`src/portal/action.ts`).
 *
 * **GUARDED ON ITS OWN `busy`, NEVER ON A TRANSITION'S `isPending`** —
 * AGENTS.md's standing trap. The action revalidates `/portal`, and a
 * transition around a revalidating action stays pending until the whole
 * page has re-rendered (measured at over two seconds on a task page), so
 * a control disabled by `isPending` would be dead for that entire
 * window. `busy` clears when the ACTION answers.
 *
 * **AND THE SHOWN VALUE IS ADOPTED FROM THE SERVER, not kept from the
 * guess.** `changed: false` is a real answer here — a double press on a
 * slow link is ordinary — and the service replies with the row's true
 * stamp, so the optimistic value is replaced rather than merged. On a
 * refusal it unwinds to the canonical prop: an action failure must never
 * look like a success (the standing rule), and on this plane the only
 * way to say so is in place.
 *
 * IT RENDERS UNDER A MEMBER SESSION TOO — `/view-as` and the project's
 * Portal tab draw this very component, which is what makes the byte
 * comparison meaningful. It must therefore reach for no contact context
 * (`task-list.tsx`'s rule) and it does not: everything it needs is a
 * prop, and the action is what holds the identity. Since this slice both
 * member surfaces wrap the portal body in `inert`, so the button is not
 * reachable there at all.
 */
export function PortalTaskDone({
  itemId,
  markedDoneAt,
}: {
  itemId: string;
  /** ISO, or null — the canonical value from the projection. */
  markedDoneAt: string | null;
}) {
  const t = useTranslations("portal.tasks");
  const format = useFormatter();
  // The optimistic slice, unwound to `markedDoneAt` on any refusal. Not
  // `useOptimistic`: that hook is tied to a transition, and this control
  // deliberately does not run inside one (see the docblock).
  const [shown, setShown] = useState<string | null>(markedDoneAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // **THE LAST VALUE THE SERVER CONFIRMED**, which is what a refusal must
  // unwind to — and NOT `markedDoneAt`, which is the prop as of the
  // render the click happened in. The two diverge for a real window: the
  // action revalidates `/portal`, and AGENTS.md's standing trap measures
  // that re-render at over two seconds, so a second press inside it would
  // have unwound a REFUSED toggle to the value from before the first,
  // successful one — showing "not done" over a claim the server holds,
  // or restoring a stamp from before an untick that had succeeded. The
  // docblock above asserts this property; before a fresh code review
  // found it, the code did not have it.
  const confirmed = useRef<string | null>(markedDoneAt);
  const done = shown !== null;

  const toggle = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const next = !done;
    // Shown before the server answers; the answer replaces it.
    setShown(next ? new Date().toISOString() : null);
    void setTaskDoneAction(itemId, next)
      // A REJECTED ACTION IS CAUGHT, and the shape is the one
      // `backlog-table.tsx` and the triage lane already use: a server
      // action rejects on transport failure as well as on a thrown
      // error, and an uncaught rejection here would leave `busy` true
      // for ever — the control dead, the optimistic tick standing, and
      // nothing on screen saying why.
      .catch(() => ({ ok: false as const, message: t("doneFailed") }))
      .then((r) => {
        setBusy(false);
        if (r.ok) {
          confirmed.current = r.markedDoneAt;
          setShown(r.markedDoneAt);
          return;
        }
        setShown(confirmed.current);
        setError(r.message);
      });
  };

  return (
    <span className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={toggle}
        aria-pressed={done}
        data-testid="portal-task-done"
        data-done={done ? "true" : "false"}
        className={cn(
          "inline-flex w-fit items-center gap-2 rounded-md px-2 py-1 text-xs",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          done ? "text-(--tone-success-fg)" : "text-muted-foreground hover:bg-accent",
        )}
      >
        {/* The box is drawn, not a native checkbox: a checkbox says
            "this field has a value", and this says "I am telling you
            something". `aria-pressed` carries the state. */}
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex size-4 shrink-0 items-center justify-center rounded-sm border",
            done ? "border-(--tone-success-fg) bg-(--tone-success-bg)" : "border-border",
          )}
        >
          {done ? <CheckIcon className="size-3" /> : null}
        </span>
        <span>{t("markDone")}</span>
      </button>
      {/* THE CLAIM COMING BACK TO THEM, in their own words and with the
          day they said it — so a client who ticked something last month
          can tell that from one they ticked this morning. */}
      {done && shown ? (
        <span className="text-2xs text-muted-foreground">
          {t("markedDoneOn", {
            date: format.dateTime(new Date(shown), { year: "numeric", month: "short", day: "numeric" }),
          })}
        </span>
      ) : null}
      {error ? (
        // `alert`, NEVER `status` (UI.md §342: status on results, alert on
        // errors). A polite region can be dropped or deferred if the
        // reader has moved on, which would leave the danger COLOUR as the
        // only carrier — also forbidden — and this plane has no toast to
        // fall back on.
        <span role="alert" className="text-2xs text-(--tone-danger-fg)" data-testid="portal-task-done-error">
          {error}
        </span>
      ) : null}
    </span>
  );
}
