"use client";

import { CheckIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { CalendarGrid, PropertyPicker, type PickerOption } from "@/components/semantic";
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import { DUE_TOKENS, dueChoiceToIso, parseDueQuery, resolveDueToken, todayIn } from "@/lib/due-date";
import { dateColumn } from "@/lib/duration";
import { dateFormat, formatDay } from "@/lib/format";
import type { WeekStart } from "@/lib/week";
import { panelSurfaceOf } from "@/lib/work-view";

import { setItemDueDateAction, type DueDateCommitted } from "../backlog/actions";
import { usePanelCommit } from "./use-panel-commit";

type ShownDue = { iso: string | null; label: string | null };

/**
 * The item rail's Due date (UI.md §5.2 `D`): the current state first,
 * then `today / tomorrow / next week` as token rows showing the date
 * each resolves to, the clear row last when set, a typed ISO date as
 * the derived row — and a month grid in the picker's `footer`.
 *
 * "Today" is the MEMBER's day in the zone the SERVER resolved
 * (`Member.timezone` → tenant `ui.timezone` → Europe/Stockholm), taken
 * in the OPEN handler: never at SSR or mount, never memoised, and never
 * stale in a peek left open past midnight. The browser's own zone is
 * never consulted — that is the wrong-day trap.
 *
 * Token rows carry token IDS, never dates: on a Sunday in a Monday
 * tenant "tomorrow" and "next week" are the same day but must not be
 * the same cmdk value. They resolve only at commit (`dueChoiceToIso`),
 * against the day computed at open.
 *
 * A due date is on the portal-safe activity list: on a client-visible
 * task, what this commits is contact-readable. Nothing here commits a
 * date the member did not choose — a bare Enter on open lands on the
 * current-state row, which is a no-op, and the unset row (`none`) and
 * the clear row (`clear`) never share a value, so a refresh under an
 * open picker cannot turn the highlighted one into the other.
 */
export function DueDateField({
  itemId,
  itemNumber,
  projectKey,
  surface,
  dueDate,
  dueLabel,
  timeZone,
  weekStart,
  showIsoWeek,
  canEdit,
}: {
  itemId: string;
  itemNumber: number;
  projectKey: string;
  /** Decides the MFA step-up return address — see `panelSurfaceOf` / `itemReturnTo`. */
  surface: "board" | "backlog" | "page";
  /** ISO date of the stored `@db.Date`, or null. */
  dueDate: string | null;
  /** Formatted on the server (`formatDay`), so the trigger never flickers between ICUs. */
  dueLabel: string | null;
  /** The request's resolved zone (`getTimeZone()`), never the browser's. */
  timeZone: string;
  /** The tenant's `ui.weekStart`. */
  weekStart: WeekStart;
  /** The tenant's `ui.showIsoWeek`. */
  showIsoWeek: boolean;
  canEdit: boolean;
}) {
  const t = useTranslations("projects.item");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [today, setToday] = useState<string | null>(null);
  const day = (iso: string) => formatDay(locale, dateColumn(iso));

  const { shown, announced, commit } = usePanelCommit<ShownDue, DueDateCommitted>({
    canonical: { iso: dueDate, label: dueLabel },
    same: (a, b) => a.iso === b.iso,
    adopt: (c) => ({ iso: c.targetDate, label: c.dueLabel }),
    announce: (v) =>
      v.iso === null ? t("dueDate.cleared") : t("dueDate.changed", { date: v.label ?? "" }),
    failedMessage: t("dueDate.failed"),
  });

  // ONE open path for the click (Radix calls it) and the key, so "today"
  // is always taken at the moment the picker opens.
  const openPicker = (next: boolean) => {
    if (next) setToday(todayIn(timeZone));
    setOpen(next);
  };

  useScopeKeys("item", [
    { key: "d", label: t("keys.dueDate"), enabled: canEdit, run: () => openPicker(true) },
  ]);

  if (!canEdit) return <span className="num">{shown.label ?? "—"}</span>;

  const check = <CheckIcon className="size-3.5" aria-hidden="true" />;
  const resolved = dateFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  // Empty only while closed: `openPicker` sets `today` in the same batch
  // that opens the popover, so the list never mounts without it.
  const options: PickerOption<string>[] =
    today === null
      ? []
      : [
          shown.iso === null
            ? { value: "none", label: t("dueDate.none"), meta: check, testId: "item-due-none" }
            : {
                value: shown.iso,
                label: shown.label ?? day(shown.iso),
                meta: check,
                testId: "item-due-current",
              },
          ...DUE_TOKENS.map((token) => ({
            value: token,
            label: t(`dueDate.${token}`),
            meta: (
              <span className="num text-xs text-muted-foreground">
                {resolved.format(dateColumn(resolveDueToken(token, today, weekStart)))}
              </span>
            ),
            testId: `item-due-token-${token}`,
          })),
          ...(shown.iso === null
            ? []
            : [{ value: "clear", label: t("dueDate.clear"), testId: "item-due-clear" }]),
        ];

  const derive = (query: string): PickerOption<string> | null => {
    const iso = parseDueQuery(query);
    return iso
      ? { value: iso, label: t("dueDate.set", { date: day(iso) }), testId: "item-due-derived" }
      : null;
  };

  const onSelect = (choice: string) => {
    if (today === null) return;
    // `clear` is this island's own row; `dueChoiceToIso` reads `none`
    // (the unset current row) as null already. Both mean "no date".
    const iso = choice === "clear" ? null : dueChoiceToIso(choice, today, weekStart);
    if (iso === undefined) return;
    commit({ iso, label: iso === null ? null : day(iso) }, () =>
      setItemDueDateAction({
        itemId,
        projectKey,
        itemNumber,
        surface: panelSurfaceOf(surface),
        targetDate: iso,
      }),
    );
  };

  return (
    <>
      <PropertyPicker
        open={open}
        onOpenChange={openPicker}
        value={shown.iso ?? "none"}
        options={options}
        onSelect={onSelect}
        derive={derive}
        // After the cmdk root, inside the popover — the grid's keys are
        // its own and every single key stays inert (CalendarGrid).
        footer={
          today === null
            ? undefined
            : (pick) => (
                <CalendarGrid
                  value={shown.iso}
                  today={today}
                  weekStart={weekStart}
                  showWeekNumbers={showIsoWeek}
                  onPick={pick}
                  testId="item-due-calendar"
                />
              )
        }
        hintKey="D"
        testId="item-due"
        className="-ms-2.5"
        labels={{
          trigger:
            shown.label === null ? t("dueDate.triggerEmpty") : t("dueDate.trigger", { date: shown.label }),
          input: t("dueDate.input"),
          search: t("dueDate.search"),
          empty: t("dueDate.empty"),
          current: t("currentValue"),
        }}
      >
        <span className="num min-w-0 truncate" data-value={shown.iso ?? ""}>
          {shown.label ?? "—"}
        </span>
      </PropertyPicker>
      <span role="status" aria-live="polite" className="sr-only">
        {announced}
      </span>
    </>
  );
}
