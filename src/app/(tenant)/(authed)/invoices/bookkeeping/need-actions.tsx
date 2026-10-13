"use client";

import { BookCheckIcon, SearchXIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { RowActions, type RowAction } from "@/components/semantic";
import { useRun } from "@/components/use-run";
import type { FortnoxAct } from "@/modules/invoicing";

import { markFortnoxDeliveryAction } from "./actions";
import { NEEDS_YOU_BODY_ID, NEWEST_FILE_LINK_ID, focusFirst } from "./ids";

/**
 * AN ENTRY ONLY A PERSON DECIDES (Phase 4 slice 114c; founder decision C90) —
 * the row's menu on the Bookkeeping page's "Waiting for you" card: Booked by
 * hand (or, for a voucher in Fortnox whose PDF never attached, PDF attached by
 * hand), and — for an unanswered voucher after a disconnect — Not in Fortnox.
 * Each is one-way for Fortleva (it never sends a booked-by-hand entry; a
 * not-in-Fortnox one goes to the download), so each is a danger item that asks
 * first — a `confirm` without the danger tone is dead string (AGENTS.md).
 * Toasted from the action's own result (`useRun`), never from the row, which
 * the refreshed page no longer has; focus then goes to the card, or the newest
 * file's link when the card is gone too — never `<body>`.
 */
export function NeedActions({
  deliveryId,
  acts,
  state,
  name,
}: {
  deliveryId: string;
  acts: readonly FortnoxAct[];
  state: "QUEUED" | "SENDING" | "BOOKED";
  /** The row's name for the menu's accessible label (the invoice's number). */
  name: string;
}) {
  const t = useTranslations("invoices.bookkeeping.needs");
  const tCommon = useTranslations("common");
  const { run } = useRun();
  const after = () => focusFirst([NEEDS_YOU_BODY_ID, NEWEST_FILE_LINK_ID]);

  const items: RowAction[] = acts.map((act): RowAction =>
    act === "BY_HAND"
      ? {
          key: "by-hand",
          label: state === "BOOKED" ? t("act.pdfByHand") : t("act.byHand"),
          icon: BookCheckIcon,
          tone: "danger",
          confirm: state === "BOOKED" ? t("confirm.pdfByHand") : t("confirm.byHand"),
          onSelect: () => run(() => markFortnoxDeliveryAction(deliveryId, "BY_HAND"), after),
        }
      : {
          key: "not-in-fortnox",
          label: t("act.notInFortnox"),
          icon: SearchXIcon,
          tone: "danger",
          confirm: t("confirm.notInFortnox"),
          onSelect: () => run(() => markFortnoxDeliveryAction(deliveryId, "NOT_IN_FORTNOX"), after),
        },
  );

  return <RowActions label={tCommon("actionsFor", { name })} items={items} />;
}
