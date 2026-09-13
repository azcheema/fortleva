"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { MemberAvatar, PropertyPicker, type PickerOption } from "@/components/semantic";
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import { panelSurfaceOf } from "@/lib/work-view";

import { setItemAssigneeAction, type AssigneeCommitted } from "../backlog/actions";
import { usePanelCommit } from "./use-panel-commit";

type ShownAssignee = { memberId: string | null; name: string | null };

/**
 * The item rail's Assignee (UI.md §5.2 `A`): the tenant's members, in
 * the order the backlog's cell and the board's lanes list them, on the
 * shared `usePanelCommit` path. Contacts are not offered here:
 * `assigneeContactId` is Phase 3's column (the portal UI, with the
 * "make it client-visible?" warning §5.2 describes), and a contact
 * assignee is forced CLIENT_VISIBLE by a CHECK the panel would have to
 * explain first.
 *
 * The rows follow P's shape, not E's: the members keep ONE order
 * however the assignment changes, so the current member is checked in
 * place (the picker seeds it — lit at once, announced on the first
 * steer, the recorded residue). A checked "Unassigned" row leads only
 * while nothing is set, and "Unassign" (`clear`) trails only while
 * something is — two values, both committing null, so no refresh under
 * an open picker can turn a highlighted no-op into a clear (§5.2).
 *
 * A current assignee who has since been deactivated is not among the
 * rows: nothing is checked, nothing is lit, Enter is inert, and the
 * trigger still names them — the row's truth until someone changes it.
 */
export function AssigneeField({
  itemId,
  itemNumber,
  projectKey,
  surface,
  assigneeMemberId,
  assigneeName,
  members,
  canEdit,
}: {
  itemId: string;
  itemNumber: number;
  projectKey: string;
  /** Decides the MFA step-up return address — see `panelSurfaceOf` / `itemReturnTo`. */
  surface: "board" | "backlog" | "page";
  assigneeMemberId: string | null;
  assigneeName: string | null;
  /** REQUIRED — `getItemDetail`'s members, never a list the surface happened to load. */
  members: readonly { id: string; name: string }[];
  canEdit: boolean;
}) {
  const t = useTranslations("projects.item");
  const [open, setOpen] = useState(false);

  const { shown, status, commit } = usePanelCommit<ShownAssignee, AssigneeCommitted>({
    canonical: { memberId: assigneeMemberId, name: assigneeName },
    same: (a, b) => a.memberId === b.memberId,
    adopt: (c) => ({ memberId: c.assigneeMemberId, name: c.assigneeName }),
    announce: (v) =>
      v.memberId === null ? t("assignee.cleared") : t("assignee.changed", { name: v.name ?? "" }),
    failedMessage: t("assignee.failed"),
  });

  // Above the early return: a hook may not sit under a conditional. A
  // DISABLED binding swallows `A` rather than letting a lower scope have
  // it — and there is nothing to pick from in a tenant with no members
  // to list, which cannot happen for a member who is reading this.
  useScopeKeys("item", [
    {
      key: "a",
      label: t("keys.assignee"),
      enabled: canEdit && members.length > 0,
      run: () => setOpen(true),
    },
  ]);

  if (!canEdit || members.length === 0) return <>{shown.name ?? t("assignee.none")}</>;

  // Test ids are ordinals over the FULL member list, so a row's id never
  // depends on who holds the task (the rule `statePickerTargets` set).
  const memberRows: PickerOption<string>[] = members.map((m, i) => ({
    value: m.id,
    label: m.name,
    icon: <MemberAvatar id={m.id} name={m.name} size="sm" />,
    testId: `item-assignee-${i}`,
  }));
  const options: PickerOption<string>[] =
    shown.memberId === null
      ? [{ value: "none", label: t("assignee.none"), testId: "item-assignee-none" }, ...memberRows]
      : [...memberRows, { value: "clear", label: t("assignee.clear"), testId: "item-assignee-clear" }];

  const onSelect = (next: string) => {
    const memberId = next === "none" || next === "clear" ? null : next;
    const name = memberId === null ? null : (members.find((m) => m.id === memberId)?.name ?? null);
    commit({ memberId, name }, () =>
      setItemAssigneeAction({
        itemId,
        projectKey,
        itemNumber,
        surface: panelSurfaceOf(surface),
        memberId,
      }),
    );
  };

  return (
    <>
      <PropertyPicker
        open={open}
        onOpenChange={setOpen}
        value={shown.memberId ?? "none"}
        options={options}
        onSelect={onSelect}
        hintKey="A"
        testId="item-assignee"
        // Flush with the rail's other values: the rest box carries `px-2.5`.
        className="-ms-2.5"
        labels={{
          trigger:
            shown.memberId === null
              ? t("assignee.triggerEmpty")
              : t("assignee.trigger", { name: shown.name ?? "" }),
          search: t("assignee.search"),
          empty: t("assignee.empty"),
          current: t("currentValue"),
        }}
      >
        {shown.memberId !== null ? (
          <MemberAvatar id={shown.memberId} name={shown.name ?? ""} size="sm" />
        ) : null}
        <span
          className={shown.memberId === null ? "min-w-0 truncate text-muted-foreground" : "min-w-0 truncate"}
          data-value={shown.memberId ?? ""}
        >
          {shown.name ?? t("assignee.none")}
        </span>
      </PropertyPicker>
      {status}
    </>
  );
}
