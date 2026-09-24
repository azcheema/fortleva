"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Callout } from "@/components/semantic";
import { Button } from "@/components/ui/button";

import { panelSurfaceOf } from "@/lib/work-view";

import { triageAction } from "../triage/actions";
import { TriageAnswer, type AnswerMode } from "../triage/triage-answer";

/**
 * THE DOOR A CLIENT'S OWN REQUEST HAD NOWHERE ELSE (C29).
 *
 * **THE DEAD END THIS EXISTS TO END.** `transitionState` refuses to move
 * a `kind = REQUEST` row into a cancelled state without a reason, and
 * every surface honours that by hiding the Cancelled target — the board's
 * two drop zones, Move-to, the backlog's state cell, the panel's `S`
 * picker and the bulk bar all consult one predicate
 * (`canItemEnterState`). That is right, and it was complete: an ACCEPTED
 * request keeps `kind = REQUEST` for ever, while `listTriage` filters
 * `stateCategory = TRIAGE` — so the row left the lane, the Decline
 * dialog that WOULD collect a reason went with it, and the agency could
 * no longer end work it had agreed to **from anywhere in the product.**
 * `triageItem`'s DECLINE was deliberately built as a lifecycle verb that
 * works from any live state; nothing ever called it from one. The
 * founder found this by accepting a request and asking what happens if
 * they change their mind.
 *
 * **IT IS A BAND, NOT A MENU ITEM, because the panel has no menu for
 * the ITEM.** It is `SectionCard`s and a rail; the only `RowActions` on
 * it belong to individual comments. A caution `Callout` above the rail
 * also says the one thing a member needs to know before pressing it —
 * that somebody has been watching this since they asked — which a menu
 * label cannot.
 *
 * **IT SUBMITS `DECLINE`**, through the lane's own action and the lane's
 * own dialog. One verb, one dialog, one place where a member's words to
 * a client are written; `CANCEL_ACCEPTED` differs from `DECLINE` in
 * nothing but its copy (see `AnswerMode`). The origin it passes — a
 * surface and an item number — is what tells the action where a step-up
 * should return to and which item page to revalidate.
 *
 * **NO OPTIMISTIC SLICE.** The row is about to leave every live view it
 * is in, and the reason has to reach the database before the client's
 * portal can show it. A pending button and a toast is the honest shape;
 * `useOptimistic` here would flash a cancellation that the server might
 * refuse (UI.md §7.2's rule about a failure never looking like a revert).
 */
export function RequestBand({
  itemId,
  itemNumber,
  itemKey,
  itemTitle,
  projectKey,
  surface,
  mode,
  clientWillSee,
}: {
  itemId: string;
  itemNumber: number;
  itemKey: string;
  itemTitle: string;
  projectKey: string;
  /**
   * WHICH STOP THE PANEL IS RENDERED AT, so a step-up returns the member
   * to the peek or the page they were actually on. The first cut sent
   * `runAction` to the project overview instead, which is the bug
   * `src/lib/work-view/item-surface.ts` was written for after a
   * hardcoded backlog path did the same thing once before. Latent today
   * (neither triage code sets `requiresMfa`) and cheap to get right.
   */
  surface: "board" | "backlog" | "page";
  /** DECLINE while it waits in triage, CANCEL_ACCEPTED once work was agreed. */
  mode: Extract<AnswerMode, "DECLINE" | "CANCEL_ACCEPTED">;
  /** Whether the reply will actually reach the client's portal. */
  clientWillSee: boolean;
}) {
  const t = useTranslations("projects.item");
  const [open, setOpen] = useState(false);
  // OWNED HERE, not in the dialog: it closes before the server answers,
  // and up to 500 characters written FOR A CLIENT must survive a refusal
  // the member is being asked to retry. The lane's caller does the same.
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  return (
    <>
      <Callout tone="caution" title={t("requestBandTitle")} className="mb-4">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 flex-1">{t("requestBandBody")}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => setOpen(true)}
          >
            {t("requestBandAction")}
          </Button>
        </span>
      </Callout>
      {open ? (
        <TriageAnswer
          mode={mode}
          itemKey={itemKey}
          itemTitle={itemTitle}
          reason={reason}
          onReasonChange={setReason}
          // DUPLICATE's rows only; this mode never offers them.
          targets={[]}
          targetsPending={false}
          busy={pending}
          onCancel={() => {
            setOpen(false);
            // **CLEARED ON DISMISSAL, KEPT ON REFUSAL.** The two are
            // different: a member who presses Cancel has changed their
            // mind, and a half-sentence surviving into next week's
            // opening would be pre-filled text in the one field that is
            // published verbatim to a client. A member whose SUBMIT was
            // refused is being asked to retry, so their words stay. The
            // first cut cleared neither and claimed a `key` was doing it
            // (it never changed); the lane clears it deliberately, which
            // is the precedent. Found by a fresh review.
            setReason("");
          }}
          onSubmit={(input) => {
            setOpen(false);
            start(async () => {
              // A SURFACE AND A NUMBER, never a path: the action composes
              // the step-up return address itself, from values it has put
              // through zod (`itemReturnTo` is an open-redirect surface by
              // its own docblock).
              const r = await triageAction(itemId, projectKey, input, {
                surface: panelSurfaceOf(surface),
                itemNumber,
              });
              if (r.ok) {
                // **THE TOAST MAY NOT PROMISE DELIVERY IT CANNOT SEE.**
                // The reply reaches the client only through
                // `listPortalTasks`, which additionally requires the row
                // to be CLIENT_VISIBLE and the project's portal switch to
                // be on — neither of which this act controls, and a
                // member may have made the request private or the
                // engagement may have ended. Saying "your reply is on
                // their portal" unconditionally was a claim the code does
                // not check. Found by a fresh review.
                toast.success(clientWillSee ? t("requestBandDone") : t("requestBandDoneUnshared"));
                setReason("");
              } else {
                // The reply is still in state, so reopening does not
                // lose it — which is why the dialog does not own it.
                toast.error(r.message);
                setOpen(true);
              }
            });
          }}
        />
      ) : null}
    </>
  );
}
