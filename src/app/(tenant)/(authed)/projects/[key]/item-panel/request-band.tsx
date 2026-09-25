"use client";

import { useTranslations } from "next-intl";
import { useRef } from "react";

import { Callout } from "@/components/semantic";
import { Button } from "@/components/ui/button";

import { panelSurfaceOf } from "@/lib/work-view";

import { useEndRequest } from "../triage/end-request";

/**
 * THE DOOR A CLIENT'S OWN REQUEST HAD NOWHERE ELSE (C29).
 *
 * **THE DEAD END THIS EXISTS TO END.** `transitionState` refuses to move
 * a `kind = REQUEST` row into a cancelled state without a reason, and
 * every surface honours that by refusing the Cancelled target — the
 * board's two drop zones, Move-to, the backlog's state cell and the
 * panel's `S` picker hide it, and the bulk bar (since C29b) shows it
 * refused with the reason; all consult one predicate
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
 * label cannot. The board card and the backlog row, which DO have menus,
 * carry the same verb there since C29b.
 *
 * **EVERYTHING BEHIND THE BUTTON IS `useEndRequest`'s** — the lane's
 * dialog, the lane's action, the reply held across a refusal, the toast
 * that promises only what the server saw — shared with those two menus,
 * so the doors cannot drift apart. The origin it passes is this panel's
 * stop, which is what a step-up returns to.
 */
export function RequestBand({
  itemId,
  itemNumber,
  itemTitle,
  stateCategory,
  projectKey,
  surface,
}: {
  itemId: string;
  itemNumber: number;
  itemTitle: string;
  /** The row's category — TRIAGE makes the verb "Decline", anything live "Cancel and reply". */
  stateCategory: string;
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
}) {
  const t = useTranslations("projects.item");
  const button = useRef<HTMLButtonElement>(null);
  const end = useEndRequest({
    projectKey,
    origin: panelSurfaceOf(surface),
    // THE BAND IS ABOUT TO GO — an ended request is not endable — and the
    // focus it holds would go with it, to `<body>` on the item page. So
    // it goes to the rail's State, which now says what happened, and ONLY
    // if it is still on this band's button (or already lost): a member
    // who moved on during the round trip is left where they are.
    onEnded: () => {
      const active = document.activeElement;
      if (active !== null && active !== document.body && active !== button.current) return;
      document.querySelector<HTMLElement>('[data-slot="item-rail"] button')?.focus();
    },
  });
  const item = { id: itemId, number: itemNumber, title: itemTitle, stateCategory };

  return (
    <>
      <Callout tone="caution" title={t("requestBandTitle")} className="mb-4">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 flex-1">{t("requestBandBody")}</span>
          {/* `aria-disabled`, never `disabled`, while an answer is in
              flight: the dialog closes as the call starts, and
              `useFocusReturn` hands focus back to this button — which a
              native `disabled` refuses, dropping focus onto `<body>` for
              the whole round trip. `begin` ignores a press meanwhile, and
              `buttonVariants` styles `aria-disabled` exactly as
              `disabled` (the timer control's pattern). */}
          <Button
            ref={button}
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={end.pending || undefined}
            onClick={() => end.begin(item)}
          >
            {end.labelFor(item)}
          </Button>
        </span>
      </Callout>
      {end.dialog}
    </>
  );
}
