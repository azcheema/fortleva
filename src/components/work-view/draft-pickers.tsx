"use client";

import { CalendarIcon, UserRoundIcon } from "lucide-react";
import { useLocale, useTimeZone, useTranslations } from "next-intl";
import { useState } from "react";

import {
  CalendarGrid,
  MemberAvatar,
  PriorityGlyph,
  PriorityIndicator,
  PropertyPicker,
  type PickerOption,
} from "@/components/semantic";
import { DEFAULT_TIMEZONE } from "@/i18n/config";
import { DUE_TOKENS, dueChoiceToIso, parseDueQuery, resolveDueToken, todayIn } from "@/lib/due-date";
import { dateColumn } from "@/lib/duration";
import { PRIORITIES, type Priority } from "@/lib/enum-map";
import { dateFormat, formatDay } from "@/lib/format";
import type { WeekStart } from "@/lib/week";

/**
 * THE "NEW TASK" FORM'S PICKERS (slice 129, founder decision C106 (c)): the
 * item panel's Person, Due date and Priority, holding a DRAFT value instead
 * of committing one — `<PropertyPicker>` and its rules unchanged (the current
 * state first, the clear row last under its own value, nothing committed the
 * member did not choose), the panel's words. A task that does not exist yet
 * has nothing to save to, so a pick only sets the form's value; the dialog
 * sends them all with the title.
 *
 * Each trigger draws its value with a glyph and a word, so a row of three
 * reads as what the task will be — "Unassigned", "No due date", "No
 * priority" — with no label column beside them.
 */

/** Bordered at rest: in a dialog the trigger is a field among fields, not a rail value. */
const TRIGGER = "border-input";

export function DraftAssigneePicker({
  members,
  value,
  onChange,
}: {
  members: readonly { id: string; name: string }[];
  value: string | null;
  onChange: (memberId: string | null) => void;
}) {
  const t = useTranslations("projects.item");
  const [open, setOpen] = useState(false);
  const name = value === null ? null : (members.find((m) => m.id === value)?.name ?? null);
  const rows: PickerOption<string>[] = members.map((m, i) => ({
    value: m.id,
    label: m.name,
    icon: <MemberAvatar id={m.id} name={m.name} size="sm" />,
    testId: `quick-create-assignee-${i}`,
  }));
  const options: PickerOption<string>[] =
    value === null
      ? [{ value: "none", label: t("assignee.none"), testId: "quick-create-assignee-none" }, ...rows]
      : [...rows, { value: "clear", label: t("assignee.clear"), testId: "quick-create-assignee-clear" }];
  return (
    <PropertyPicker
      open={open}
      onOpenChange={setOpen}
      value={value ?? "none"}
      options={options}
      onSelect={(next) => onChange(next === "none" || next === "clear" ? null : next)}
      testId="quick-create-assignee"
      className={TRIGGER}
      labels={{
        trigger: name === null ? t("assignee.triggerEmpty") : t("assignee.trigger", { name }),
        search: t("assignee.search"),
        empty: t("assignee.empty"),
        current: t("currentValue"),
      }}
    >
      {value !== null && name !== null ? (
        <MemberAvatar id={value} name={name} size="sm" />
      ) : (
        <UserRoundIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className={value === null ? "truncate text-muted-foreground" : "truncate"}>{name ?? t("assignee.none")}</span>
    </PropertyPicker>
  );
}

export function DraftDuePicker({
  value,
  onChange,
  weekStart,
  showIsoWeek,
}: {
  /** ISO date, or null. */
  value: string | null;
  onChange: (iso: string | null) => void;
  /** The workspace's `ui.weekStart`. */
  weekStart: WeekStart;
  /** The workspace's `ui.showIsoWeek`. */
  showIsoWeek: boolean;
}) {
  const t = useTranslations("projects.item");
  const locale = useLocale();
  // The zone the request resolved (the i18n config's `resolveTimeZone` —
  // Member.timezone → the workspace's → Europe/Stockholm), never the
  // browser's own: the wrong-day trap. The dialog is client-only, so no
  // label below is ever rendered on the server.
  const timeZone = useTimeZone() ?? DEFAULT_TIMEZONE;
  const [open, setOpen] = useState(false);
  const [today, setToday] = useState<string | null>(null);
  const day = (iso: string) => formatDay(locale, dateColumn(iso));

  // ONE open path, so "today" is taken at the moment the picker opens.
  const openPicker = (next: boolean) => {
    if (next) setToday(todayIn(timeZone));
    setOpen(next);
  };

  const resolved = dateFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const options: PickerOption<string>[] =
    today === null
      ? []
      : [
          value === null
            ? { value: "none", label: t("dueDate.none"), testId: "quick-create-due-none" }
            : { value, label: day(value), testId: "quick-create-due-current" },
          ...DUE_TOKENS.map((token) => ({
            value: token,
            label: t(`dueDate.${token}`),
            meta: (
              <span className="num text-xs text-muted-foreground">
                {resolved.format(dateColumn(resolveDueToken(token, today, weekStart)))}
              </span>
            ),
            testId: `quick-create-due-token-${token}`,
          })),
          ...(value === null ? [] : [{ value: "clear", label: t("dueDate.clear"), testId: "quick-create-due-clear" }]),
        ];

  const derive = (query: string): PickerOption<string> | null => {
    const iso = parseDueQuery(query);
    return iso ? { value: iso, label: t("dueDate.set", { date: day(iso) }), testId: "quick-create-due-derived" } : null;
  };

  return (
    <PropertyPicker
      open={open}
      onOpenChange={openPicker}
      value={value ?? "none"}
      options={options}
      onSelect={(choice) => {
        if (today === null) return;
        const iso = choice === "clear" ? null : dueChoiceToIso(choice, today, weekStart);
        if (iso === undefined) return;
        onChange(iso);
      }}
      derive={derive}
      footer={
        today === null
          ? undefined
          : (pick) => (
              <CalendarGrid
                value={value}
                today={today}
                weekStart={weekStart}
                showWeekNumbers={showIsoWeek}
                onPick={pick}
                testId="quick-create-due-calendar"
              />
            )
      }
      testId="quick-create-due"
      className={TRIGGER}
      labels={{
        trigger: value === null ? t("dueDate.triggerEmpty") : t("dueDate.trigger", { date: day(value) }),
        input: t("dueDate.input"),
        search: t("dueDate.search"),
        empty: t("dueDate.empty"),
        current: t("currentValue"),
      }}
    >
      <CalendarIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className={value === null ? "num truncate text-muted-foreground" : "num truncate"} data-value={value ?? ""}>
        {value === null ? t("dueDate.none") : day(value)}
      </span>
    </PropertyPicker>
  );
}

export function DraftPriorityPicker({ value, onChange }: { value: Priority; onChange: (priority: Priority) => void }) {
  const t = useTranslations("projects.item");
  const tPriority = useTranslations("states.priority");
  const [open, setOpen] = useState(false);
  const options: PickerOption<Priority>[] = PRIORITIES.map((v) => ({
    value: v,
    label: tPriority(v),
    icon: <PriorityGlyph value={v} />,
    testId: `quick-create-priority-${v}`,
  }));
  return (
    <PropertyPicker
      open={open}
      onOpenChange={setOpen}
      value={value}
      options={options}
      onSelect={onChange}
      testId="quick-create-priority"
      className={TRIGGER}
      labels={{
        trigger: t("priority.trigger", { priority: tPriority(value) }),
        search: t("priority.search"),
        empty: t("priority.empty"),
        current: t("currentValue"),
      }}
    >
      <PriorityIndicator value={value} showLabel />
    </PropertyPicker>
  );
}
