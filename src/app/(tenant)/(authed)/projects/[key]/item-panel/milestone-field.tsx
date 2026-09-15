"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { PropertyPicker, StatusIcon, type PickerOption } from "@/components/semantic";
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import { STATUS_MAP } from "@/lib/enum-map";
import { milestonePickerTargets, panelSurfaceOf } from "@/lib/work-view";
import type { MilestoneEntry, MilestoneStatus } from "@/modules/work";

import { setItemMilestoneAction, type MilestoneCommitted } from "../backlog/actions";
import { usePanelCommit } from "./use-panel-commit";

type ShownMilestone = {
  milestoneId: string | null;
  name: string | null;
  status: MilestoneStatus | null;
};

/**
 * The item rail's Milestone (UI.md §5.2 `M`): the project's phases by
 * RANK — the timeline's own order — on the shared `usePanelCommit`
 * path, with the trigger, the key and the action in one island as
 * `S A P E D V` have them.
 *
 * The rows follow `A`'s shape, not `E`'s: the phases keep ONE order
 * however the item moves between them, so the current one is checked in
 * place (the picker seeds the highlight on it — lit at once, announced
 * on the member's first steer, the recorded residue). A checked "No
 * milestone" row leads only while nothing is set and "Remove from
 * milestone" (`clear`) trails only while something is — two values,
 * both committing null, so no refresh under an open picker can turn a
 * highlighted no-op into a clear (§5.2).
 *
 * Which phases may be chosen is `milestonePickerTargets`' rule, shared
 * with nothing yet and unit-tested there rather than here: a CANCELLED
 * phase is not a target, and the item's current one is always a row —
 * non-selectable when it is one of those, because a picker that cannot
 * show what the item IS is broken.
 *
 * The due date rides in `meta`, which is what tells "Sprint 3" from
 * "Sprint 4". It is formatted in the popover, which never server-renders
 * (Radix mounts the content on open, and there is no `forceMount`), so
 * there is no first paint for Node's ICU and the browser's to disagree
 * about.
 */
export function MilestoneField({
  itemId,
  itemNumber,
  projectKey,
  surface,
  milestoneId,
  milestoneName,
  milestoneStatus,
  milestones,
  canEdit,
}: {
  itemId: string;
  itemNumber: number;
  projectKey: string;
  /** Decides the MFA step-up return address — see `panelSurfaceOf` / `itemReturnTo`. */
  surface: "board" | "backlog" | "page";
  milestoneId: string | null;
  milestoneName: string | null;
  milestoneStatus: MilestoneStatus | null;
  /** REQUIRED — `getItemDetail`'s milestones, never a list the surface happened to load. */
  milestones: readonly MilestoneEntry[];
  canEdit: boolean;
}) {
  const t = useTranslations("projects.item");
  const format = useFormatter();
  const [open, setOpen] = useState(false);

  const { shown, status, commit } = usePanelCommit<ShownMilestone, MilestoneCommitted>({
    canonical: { milestoneId, name: milestoneName, status: milestoneStatus },
    same: (a, b) => a.milestoneId === b.milestoneId,
    adopt: (c) => ({
      milestoneId: c.milestoneId,
      name: c.milestoneName,
      status: c.milestoneStatus,
    }),
    announce: (v) =>
      v.milestoneId === null ? t("milestone.cleared") : t("milestone.changed", { name: v.name ?? "" }),
    failedMessage: t("milestone.failed"),
  });

  // The ROWS follow the SHOWN value, so an optimistic pick is checked in
  // place while the server answers.
  const targets = useMemo(
    () => milestonePickerTargets(milestones, shown.milestoneId),
    [milestones, shown.milestoneId],
  );

  // ONE question, asked once, for the key and for the control: is there
  // anything to choose? A selectable phase, or a phase to be removed
  // from. Both halves matter — a project whose phases are ALL cancelled
  // offers nothing but the checked "No milestone", which is a dead
  // control (§5.8); and an item filed under a cancelled phase offers
  // "Remove from milestone" though not one target is selectable, which
  // is a real verb the key must reach.
  //
  // It is asked of the CANONICAL value, never of `shown`. Whether this
  // is a control is structure, and structure may not follow a pick the
  // server has not answered: in that all-cancelled project, clearing the
  // last phase makes `shown` null, which would empty `targets` and take
  // the early return ON THE COMMITTING RENDER — unmounting the popover
  // out from under Radix's own close, and with it the live region that
  // was about to say "Milestone removed". `AssigneeField` is safe from
  // this by luck: its gate is `members.length`, a prop a pick cannot
  // move.
  const hasChoice = useMemo(() => {
    const canonical = milestonePickerTargets(milestones, milestoneId);
    return canonical.some((x) => !x.disabled) || milestoneId !== null;
  }, [milestones, milestoneId]);

  // Above the early return: a hook may not sit under a conditional. A
  // DISABLED binding swallows `M` rather than letting a lower scope have
  // it.
  useScopeKeys("item", [
    {
      key: "m",
      label: t("keys.milestone"),
      enabled: canEdit && hasChoice,
      run: () => setOpen(true),
    },
  ]);

  // A gate that closes under an OPEN popover must close the popover too.
  // Radix never calls `onOpenChange` on unmount, and `open` lives in this
  // island, which stays mounted — so a picker that vanished with `open`
  // still true would mount ALREADY OPEN the next time the gate reopened
  // (a colleague cancels the project's last live phase, then un-cancels
  // it), autofocusing its search field out of whatever the member was
  // typing. Adjusted DURING RENDER — React's own pattern for state that
  // must follow a prop, the one `PickerBody` uses for its highlight —
  // never an effect, which would paint the open popover first.
  if (open && (!canEdit || !hasChoice)) setOpen(false);

  // Honest degradation: without `work_item:edit`, or with nothing to
  // choose, the value is still the value — just not a control. `status`
  // is rendered here too: `usePanelCommit`'s live region is ALWAYS
  // mounted, and this branch can be reached one render after a commit
  // whose answer it still has to speak.
  if (!canEdit || !hasChoice) {
    return (
      <>
        {shown.name ?? t("milestone.none")}
        {status}
      </>
    );
  }

  const glyph = (value: MilestoneStatus) => (
    <StatusIcon
      name={STATUS_MAP.milestoneStatus[value].icon}
      className="size-3 shrink-0"
      aria-hidden="true"
    />
  );

  const rows: PickerOption<string>[] = targets.map(({ milestone: m, key, disabled }) => ({
    value: m.id,
    label: m.name,
    icon: glyph(m.status),
    disabled,
    meta: m.dueAt ? (
      <span className="num shrink-0 text-xs text-muted-foreground">
        {format.dateTime(m.dueAt, { dateStyle: "medium" })}
      </span>
    ) : undefined,
    // An ordinal over the FULL list, so a row's id never depends on which
    // phases are live (`milestonePickerTargets`).
    testId: `item-milestone-${key}`,
  }));
  const options: PickerOption<string>[] =
    shown.milestoneId === null
      ? [{ value: "none", label: t("milestone.none"), testId: "item-milestone-none" }, ...rows]
      : [...rows, { value: "clear", label: t("milestone.clear"), testId: "item-milestone-clear" }];

  const onSelect = (next: string) => {
    const id = next === "none" || next === "clear" ? null : next;
    const target = id === null ? null : targets.find((x) => x.milestone.id === id);
    // cmdk never selects a disabled row; this is the belt.
    if (id !== null && (!target || target.disabled)) return;
    commit(
      {
        milestoneId: id,
        name: target?.milestone.name ?? null,
        status: target?.milestone.status ?? null,
      },
      () =>
        setItemMilestoneAction({
          itemId,
          projectKey,
          itemNumber,
          surface: panelSurfaceOf(surface),
          milestoneId: id,
        }),
    );
  };

  return (
    <>
      <PropertyPicker
        open={open}
        onOpenChange={setOpen}
        value={shown.milestoneId ?? "none"}
        options={options}
        onSelect={onSelect}
        hintKey="M"
        testId="item-milestone"
        // Flush with the rail's other values: the rest box carries `px-2.5`.
        className="-ms-2.5"
        labels={{
          trigger:
            shown.milestoneId === null
              ? t("milestone.triggerEmpty")
              : t("milestone.trigger", { name: shown.name ?? "" }),
          search: t("milestone.search"),
          empty: t("milestone.empty"),
          current: t("currentValue"),
        }}
      >
        {shown.status !== null ? glyph(shown.status) : null}
        <span
          className={shown.milestoneId === null ? "min-w-0 truncate text-muted-foreground" : "min-w-0 truncate"}
          data-value={shown.milestoneId ?? ""}
        >
          {shown.name ?? t("milestone.none")}
        </span>
      </PropertyPicker>
      {status}
    </>
  );
}
