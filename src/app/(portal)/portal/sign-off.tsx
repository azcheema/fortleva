"use client";

import { CheckIcon, Undo2Icon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SIGNOFF_NOTE_MAX, type SignoffDecision } from "@/portal/signoff-vocabulary";

import { decideDeliverableAction, decideVersionAction } from "./actions";

/**
 * SIGN-OFF — the client's approve / request-changes control (Phase 3,
 * decision #7 v1-lite; UI.md §4 items 4 and 6), and what it says once
 * a decision stands. One component for a shipped version on the rail
 * and a delivered file on the files list, because the decision means
 * the same thing on both and UI.md §12 forbids a second implementation.
 *
 * **THREE STATES, drawn from the projection's `approval`:**
 *  - the ask is open and the reader may answer (`canDecide`): two
 *    buttons. "Approve" acts at once. "Request changes" first asks for
 *    the words — a note is REQUIRED on that path, because an ask to
 *    change something that says nothing is not something the agency can
 *    act on, and the server refuses it too (`parseSignoffInput`);
 *  - the ask is open and the reader may NOT answer (a collaborator):
 *    the state in words and no control — a portal screen with a button
 *    whose only outcome is a refusal is a bug (UI.md §4);
 *  - a decision stands: the word, the day, and the note if one was
 *    written, in a `<q>` because they are the client's own words read
 *    back to them. Nothing is said about WHO decided: the projection
 *    carries no name, and "which of you signed" is the client's own
 *    business (`PortalApprovalState`).
 *
 * **NO TOAST, IN PLACE, GUARDED ON ITS OWN `busy`, ADOPTING THE SERVER'S
 * ANSWER** — every rule `task-done.tsx` records applies unchanged: a
 * refusal renders under the control as `role="alert"`; the guard is not
 * a transition's `isPending` (AGENTS.md's standing trap); and the shown
 * decision is the row's true state from the action's reply, so a
 * double press on a slow link — `changed: false` — draws what stands.
 * A decision is final on this plane (only the agency can ask again), so
 * unlike the tick there is no optimistic flip to unwind: the buttons
 * stay until the server answers.
 *
 * IT RENDERS UNDER A MEMBER SESSION TOO — `/view-as` and the Portal
 * tab draw it inside `inert` — so it reaches for no contact context:
 * everything is a prop, and the action holds the identity. **Key it on
 * the decision at every call site** (`signOffKey`, in
 * `@/portal/signoff-vocabulary` — NOT exported from here: a function
 * exported from a `"use client"` module and CALLED by a server
 * component is a throwing client reference, AGENTS.md's standing trap
 * for constants, and it took the portal's pages down for one build):
 * the control is drawn once per subject, but its props can change
 * underneath it — a colleague's decision, or the agency asking again —
 * and the revalidated props must replace the island's local state
 * rather than leave it offering a control on an answered ask.
 *
 * **THE KEY IS ALSO WHY FOCUS HAS TO BE HANDED ACROSS A REMOUNT.** A
 * decision made here revalidates the page, and the server then keys
 * this very island on the NEW decision, so React unmounts the focused
 * status line and mounts a fresh instance a beat after the reader heard
 * the announcement — and the browser drops focus to `<body>` (the
 * fix-pass review traced it). `DECIDED_HERE` is the hand-over: the
 * instance that decided records the subject, and the instance that
 * mounts already decided for that subject takes focus once, if nothing
 * else holds it, and forgets it. A module-level Set rather than state,
 * because state does not survive an unmount.
 */

/** Subjects decided by THIS browser session whose fresh, remounted island still owes the reader focus. */
const DECIDED_HERE = new Set<string>();
export function PortalSignOff({
  subject,
  id,
  status,
  decidedAt,
  note,
  canDecide,
}: {
  subject: "version" | "deliverable";
  id: string;
  status: "NOT_REQUESTED" | "PENDING" | "APPROVED" | "CHANGES_REQUESTED";
  /** ISO, or null — the canonical value from the projection. */
  decidedAt: string | null;
  note: string | null;
  canDecide: boolean;
}) {
  const t = useTranslations("portal.signoff");
  const format = useFormatter();
  const noteId = useId();
  const [shown, setShown] = useState<{ status: typeof status; decidedAt: string | null; note: string | null }>({
    status,
    decidedAt,
    note,
  });
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const changesRef = useRef<HTMLButtonElement>(null);
  const decidedRef = useRef<HTMLSpanElement>(null);
  // WHERE FOCUS GOES WHEN THE BUTTONS UNMOUNT. A decision replaces the
  // control with the decided line; without this, focus fell to `<body>`
  // and a screen-reader user heard nothing (a code review's note). The
  // line is a `status` region AND takes focus, so the confirmation is
  // both announced and where the reader is. The initial render never
  // steals focus: `decidedHere` is set only by a decision made HERE,
  // and the remounted instance (the docblock) takes it only when the
  // subject is on `DECIDED_HERE` and focus is nowhere in particular.
  const [decidedHere, setDecidedHere] = useState(false);
  const decided = shown.status === "APPROVED" || shown.status === "CHANGES_REQUESTED";
  useEffect(() => {
    if (decidedHere) {
      decidedRef.current?.focus();
      return;
    }
    // ONE SHOT, consumed whether or not focus is taken: a reader who
    // moved on during the revalidation keeps their place, and the id
    // must not lie in wait to grab focus on a later navigation back to
    // this page (the narrow review traced that path).
    if (decided && DECIDED_HERE.delete(id) && document.activeElement === document.body) {
      decidedRef.current?.focus();
    }
  }, [decidedHere, decided, id]);

  const decide = (decision: SignoffDecision, text: string | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const action = subject === "version" ? decideVersionAction : decideDeliverableAction;
    void action(id, decision, text)
      // A rejected action is caught, the shape every island on this plane
      // uses: a transport failure would otherwise leave `busy` true for
      // ever with nothing on screen saying why.
      .catch(() => ({ ok: false as const, message: t("failed") }))
      .then((r) => {
        setBusy(false);
        if (r.ok) {
          DECIDED_HERE.add(id);
          setShown({ status: r.status, decidedAt: r.decidedAt, note: r.note });
          setAsking(false);
          setDecidedHere(true);
          return;
        }
        setError(r.message);
      });
  };

  const day = (iso: string) =>
    format.dateTime(new Date(iso), { year: "numeric", month: "short", day: "numeric" });

  if (decided) {
    return (
      <span
        ref={decidedRef}
        // `status`, not `alert`: a result, announced politely (UI.md §9).
        // Focusable only programmatically, for the moment the control it
        // replaces disappears under the reader.
        role="status"
        tabIndex={-1}
        data-slot="portal-signoff"
        data-status={shown.status}
        className="flex flex-col gap-0.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span
          className={
            shown.status === "APPROVED"
              ? "inline-flex items-center gap-1.5 text-xs text-(--tone-success-fg)"
              : "inline-flex items-center gap-1.5 text-xs text-(--tone-danger-fg)"
          }
        >
          {shown.status === "APPROVED" ? (
            <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
          ) : (
            <Undo2Icon aria-hidden="true" className="size-3.5 shrink-0" />
          )}
          {shown.decidedAt
            ? shown.status === "APPROVED"
              ? t("approvedOn", { date: day(shown.decidedAt) })
              : t("changesOn", { date: day(shown.decidedAt) })
            : shown.status === "APPROVED"
              ? t("approved")
              : t("changes")}
        </span>
        {shown.note ? (
          <q className="text-xs text-muted-foreground whitespace-pre-wrap">{shown.note}</q>
        ) : null}
      </span>
    );
  }

  if (shown.status !== "PENDING") return null;

  if (!canDecide) {
    return (
      <span data-slot="portal-signoff" data-status="PENDING" className="text-xs text-muted-foreground">
        {t("awaitingReview")}
      </span>
    );
  }

  return (
    <span data-slot="portal-signoff" data-status="PENDING" data-can-decide="true" className="flex flex-col gap-2">
      <span className="text-xs text-muted-foreground">{t("awaitingYou")}</span>
      {asking ? (
        <span className="flex flex-col gap-2">
          <label htmlFor={noteId} className="text-xs font-medium text-foreground">
            {t("noteLabel")}
          </label>
          <Textarea
            id={noteId}
            ref={noteRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={SIGNOFF_NOTE_MAX}
            rows={3}
            placeholder={t("notePlaceholder")}
            aria-describedby={`${noteId}-hint`}
            disabled={busy}
          />
          <span id={`${noteId}-hint`} className="text-2xs text-muted-foreground">
            {t("noteHint")}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy || draft.trim().length === 0}
              onClick={() => decide("CHANGES_REQUESTED", draft.trim())}
              data-testid="portal-signoff-send"
            >
              {t("sendChanges")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setAsking(false);
                setError(null);
                // Back to the button that opened the note, once it is
                // drawn again — never to `<body>`.
                queueMicrotask(() => changesRef.current?.focus());
              }}
            >
              {t("cancel")}
            </Button>
          </span>
        </span>
      ) : (
        <span className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => decide("APPROVED", null)}
            data-testid="portal-signoff-approve"
          >
            <CheckIcon aria-hidden="true" />
            {t("approve")}
          </Button>
          <Button
            ref={changesRef}
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setAsking(true);
              setError(null);
              // The words first: focus lands in the note, so a keyboard
              // reader is writing before they look for the send button.
              queueMicrotask(() => noteRef.current?.focus());
            }}
            data-testid="portal-signoff-changes"
          >
            <Undo2Icon aria-hidden="true" />
            {t("requestChanges")}
          </Button>
        </span>
      )}
      {error ? (
        // `alert`, never `status`: UI.md §9, and this plane has no toast.
        <span role="alert" className="text-2xs text-(--tone-danger-fg)" data-testid="portal-signoff-error">
          {error}
        </span>
      ) : null}
    </span>
  );
}
