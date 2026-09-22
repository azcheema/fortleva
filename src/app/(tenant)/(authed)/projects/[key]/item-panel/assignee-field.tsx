"use client";

import { UserRoundIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { MemberAvatar, PropertyPicker, type PickerOption } from "@/components/semantic";
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import { panelSurfaceOf } from "@/lib/work-view";

import {
  setItemAssigneeAction,
  setItemContactAssigneeAction,
  type AssigneeCommitted,
  type ContactAssigneeCommitted,
} from "../backlog/actions";
import { usePanelCommit } from "./use-panel-commit";

/**
 * WHO IS DOING THIS — one value, one control, and since Phase 3 slice
 * 6c two kinds of answer.
 *
 * `memberId` and `contactId` are never both set — `work_item_single_assignee`
 * is `num_nonnulls(…) <= 1`, so that much is the database's word. BOTH
 * null is ordinary and is what Unassigned is; the constraint is "at most
 * one", never "exactly one".
 */
type ShownAssignee = {
  memberId: string | null;
  contactId: string | null;
  name: string | null;
  /**
   * Whether the commit that produced this value also PUBLISHED the task
   * — so the live region can say the more consequential half out loud.
   * Not part of `same`: it is a fact about the last write, never about
   * which value is shown, and two picks of the same person are the same
   * pick whatever either one did to the visibility.
   */
  shared?: boolean;
};

/** The two services' canonical rows — `adopt` tells them apart by shape. */
type Committed = AssigneeCommitted | ContactAssigneeCommitted;

const isContactRow = (c: Committed): c is ContactAssigneeCommitted =>
  "assigneeContactId" in c;

/**
 * The item rail's Assignee (UI.md §5.2 `A`): the tenant's members, in
 * the order the backlog's cell and the board's lanes list them, on the
 * shared `usePanelCommit` path.
 *
 * **SINCE SLICE 6c THE CLIENT'S OWN PEOPLE ARE HERE TOO**, in a second
 * group, and it is one picker rather than two controls for the reason
 * the column pair gives: the row stores at most one assignment, so "who
 * is doing this" has one answer. A second control beside this one would
 * be a second answer the database cannot hold — and would make taking a
 * task back from a client a two-step act (clear there, set here) with a
 * window in between where nobody holds it.
 *
 * **PICKING A CONTACT PUBLISHES THE TASK**, and the picker says so
 * BEFORE the pick rather than after: `work_item_contact_assignee_visible`
 * (a CHECK since 2W) admits no third answer, so handing an INTERNAL
 * task over makes it CLIENT_VISIBLE — which is why the service demands
 * `work_item:change_visibility` on top of `work_item:edit` for exactly
 * that case, and why the footer below is not decoration. §5.2 has asked
 * for this warning since the column existed.
 *
 * **AND THE GROUP IS HIDDEN WHERE THE PICK WOULD BE REFUSED**, never
 * disabled (§3.1) — which the surface can decide, because the rule is
 * about this row and the panel holds both halves of it: on a task the
 * client can ALREADY see, handing over publishes nothing and any editor
 * may do it; on an INTERNAL one it is the share, and a member without
 * `work_item:change_visibility` would get a toast for every contact in
 * the list. That is the shape the slice-6b reviews corrected in the
 * triage lane one day earlier. The group comes back for the same member
 * the moment somebody shares the task.
 *
 * THE GROUPS APPEAR ONLY WHEN THERE ARE TWO. A tenant whose client has
 * nobody with portal access — and a member who may not hand this task
 * over — sees the list exactly as it has always been, unheaded: a
 * heading over one group is a word that distinguishes nothing.
 *
 * The rows follow P's shape, not E's: the people keep ONE order however
 * the assignment changes, so the current one is checked in place (the
 * picker seeds it — lit at once, announced on the first steer, the
 * recorded residue). A checked "Unassigned" row leads only while nothing
 * is set, and "Unassign" (`clear`) trails only while something is — two
 * values, both committing null, so no refresh under an open picker can
 * turn a highlighted no-op into a clear (§5.2).
 *
 * A current assignee who has since been deactivated — a member, or a
 * contact whose portal access has been taken away — is not among the
 * rows: nothing is checked, nothing is lit, Enter is inert, and the
 * trigger still names them, the row's truth until someone changes it.
 */
export function AssigneeField({
  itemId,
  itemNumber,
  projectKey,
  surface,
  assigneeMemberId,
  assigneeContactId,
  assigneeName,
  visibility,
  portalEnabled,
  members,
  contacts,
  canEdit,
  canChangeVisibility,
}: {
  itemId: string;
  itemNumber: number;
  projectKey: string;
  /** Decides the MFA step-up return address — see `panelSurfaceOf` / `itemReturnTo`. */
  surface: "board" | "backlog" | "page";
  assigneeMemberId: string | null;
  /** The other half of the pair — never set together with the member's. */
  assigneeContactId: string | null;
  /** Whichever of the two holds the task; the service resolves it. */
  assigneeName: string | null;
  /**
   * REQUIRED — the item's CURRENT visibility. With the cap below it
   * decides both whether the client group is OFFERED at all and whether
   * the warning is true: on a task the client can already see, handing
   * it over publishes nothing.
   */
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  /**
   * REQUIRED — the PROJECT's portal switch as the row carries it. It
   * changes only which warning is true, never whether the hand-over is
   * offered (see the `footer` below).
   */
  portalEnabled: boolean;
  /** REQUIRED — `getItemDetail`'s members, never a list the surface happened to load. */
  members: readonly { id: string; name: string }[];
  /** REQUIRED — `getItemDetail`'s contacts of this item's client (ACTIVE or INVITED); empty is ordinary. */
  contacts: readonly { id: string; name: string }[];
  canEdit: boolean;
  /** REQUIRED — `work_item:change_visibility`, the second code a hand-over of an INTERNAL task needs. */
  canChangeVisibility: boolean;
}) {
  const t = useTranslations("projects.item");
  const [open, setOpen] = useState(false);

  const { shown, status, commit } = usePanelCommit<ShownAssignee, Committed>({
    canonical: { memberId: assigneeMemberId, contactId: assigneeContactId, name: assigneeName },
    // BOTH halves, because either can be the thing that moved: handing a
    // member's task to a contact leaves `memberId` null on both sides of
    // the comparison, and a guard that read it alone would drop the pick
    // as a no-op.
    same: (a, b) => a.memberId === b.memberId && a.contactId === b.contactId,
    adopt: (c) =>
      isContactRow(c)
        ? { memberId: null, contactId: c.assigneeContactId, name: c.assigneeName, shared: c.shared }
        : { memberId: c.assigneeMemberId, contactId: null, name: c.assigneeName },
    // **THE PUBLISH IS SPOKEN, not left to the visibility island.** That
    // island announces its own commits only, so before this the flip
    // from INTERNAL to CLIENT_VISIBLE — the more consequential half of
    // the pick, and the half a member cannot undo by picking again —
    // reached a screen reader from nobody at all. Found by a fresh code
    // review.
    announce: (v) =>
      v.memberId === null && v.contactId === null
        ? t("assignee.cleared")
        : v.shared
          ? t("assignee.changedAndShared", { name: v.name ?? "" })
          : t("assignee.changed", { name: v.name ?? "" }),
    failedMessage: t("assignee.failed"),
  });

  // The row's own rule, resolved here rather than in the service's
  // refusal: publishing is what needs the second code, and a task the
  // client can already see is not being published again.
  const canHandOver = visibility === "CLIENT_VISIBLE" || canChangeVisibility;
  const offered = canHandOver ? contacts : [];
  const hasRows = members.length > 0 || offered.length > 0;

  // Above the early return: a hook may not sit under a conditional. A
  // DISABLED binding swallows `A` rather than letting a lower scope have
  // it — and there is nothing to pick from in a tenant with no members
  // to list, which cannot happen for a member who is reading this.
  useScopeKeys("item", [
    {
      key: "a",
      label: t("keys.assignee"),
      enabled: canEdit && hasRows,
      run: () => setOpen(true),
    },
  ]);

  if (!canEdit || !hasRows) return <>{shown.name ?? t("assignee.none")}</>;

  // Headed only when there really are two groups to tell apart — BOTH
  // sides, not just the client's. Near-vacuous in practice, since
  // `activeMembers` includes the member reading this, but a heading over
  // a lone group is the thing the docblock's own rule forbids.
  const grouped = members.length > 0 && offered.length > 0;
  // Test ids are ordinals over the FULL list, so a row's id never
  // depends on who holds the task (the rule `statePickerTargets` set).
  const memberRows: PickerOption<string>[] = members.map((m, i) => ({
    value: m.id,
    label: m.name,
    group: grouped ? t("assignee.teamGroup") : undefined,
    icon: <MemberAvatar id={m.id} name={m.name} size="sm" />,
    testId: `item-assignee-${i}`,
  }));
  // A GLYPH, NEVER AN AVATAR: `MemberAvatar` colours its initials from a
  // MEMBER id, so a contact rendered through it would be handed a
  // member's colour for a hash nobody else computes. The glyph is the
  // one the activity rail already uses for `assigneeContactId`.
  const contactRows: PickerOption<string>[] = offered.map((c, i) => ({
    value: c.id,
    label: c.name,
    // Headed on the SAME condition as the member rows: heading one of
    // the two lists and not the other would be the lone-heading defect
    // by half. Unreachable in practice — `activeMembers` always includes
    // the member reading this — which is exactly why it is written down
    // rather than relied on.
    group: grouped ? t("assignee.clientGroup") : undefined,
    icon: <UserRoundIcon aria-hidden="true" className="size-4 text-muted-foreground" />,
    testId: `item-assignee-contact-${i}`,
  }));
  const assigned = shown.memberId !== null || shown.contactId !== null;
  const options: PickerOption<string>[] = assigned
    ? [...memberRows, ...contactRows, { value: "clear", label: t("assignee.clear"), testId: "item-assignee-clear" }]
    : [
        { value: "none", label: t("assignee.none"), testId: "item-assignee-none" },
        ...memberRows,
        ...contactRows,
      ];

  const onSelect = (next: string) => {
    const contact = offered.find((c) => c.id === next);
    if (contact) {
      // The optimistic slice knows this as well as the server does: the
      // CHECK leaves no third answer, so a pick on an INTERNAL row IS
      // the share. `adopt` replaces it with what actually happened.
      commit({ memberId: null, contactId: contact.id, name: contact.name, shared: visibility === "INTERNAL" }, () =>
        setItemContactAssigneeAction({
          itemId,
          projectKey,
          itemNumber,
          surface: panelSurfaceOf(surface),
          contactId: contact.id,
        }),
      );
      return;
    }
    const memberId = next === "none" || next === "clear" ? null : next;
    const name = memberId === null ? null : (members.find((m) => m.id === memberId)?.name ?? null);
    commit({ memberId, contactId: null, name }, () =>
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
        value={shown.memberId ?? shown.contactId ?? "none"}
        options={options}
        onSelect={onSelect}
        hintKey="A"
        testId="item-assignee"
        // Flush with the rail's other values: the rest box carries `px-2.5`.
        className="-ms-2.5"
        labels={{
          // ITS OWN SENTENCE FOR A CONTACT. "Assignee: Astrid Lindqvist"
          // is byte-identical to a colleague's, and the glyph that
          // carries the distinction is `aria-hidden` — so to a screen
          // reader the rail said the task was with the team. The board
          // card got its own sentence for this reason; the rail had not.
          trigger: !assigned
            ? t("assignee.triggerEmpty")
            : shown.contactId !== null
              ? t("assignee.triggerContact", { name: shown.name ?? "" })
              : t("assignee.trigger", { name: shown.name ?? "" }),
          search: t("assignee.search"),
          empty: t("assignee.empty"),
          current: t("currentValue"),
        }}
        // AFTER the cmdk root, never inside it: the root owns Enter and
        // the arrows for every descendant (`PropertyPicker`'s header).
        // Shown only where it would be TRUE — on a task the client can
        // already see, handing it over publishes nothing.
        // **AND THE SENTENCE IS TRUE ON A PORTAL-OFF PROJECT TOO**, which
        // is a different sentence. Marking a task CLIENT_VISIBLE where
        // the project's portal switch is off has always been allowed —
        // `changeItemVisibility` has never consulted `portalEnabled`,
        // because visibility is the ROW's flag and the switch is the
        // PROJECT's — so handing one over is allowed there as well, for
        // consistency with its sibling flip. But `portal_gate` ANDs the
        // two, so the client cannot see it, and "makes the task visible
        // to the client" would have been a plain falsehood: the member
        // publishes a task to nobody and the audit log records a share
        // that never reached anyone. Found by a fresh code review, which
        // also caught that UI.md's old "portal-enabled projects only"
        // qualifier had been deleted rather than implemented.
        footer={
          visibility === "INTERNAL" && offered.length > 0
            ? () => (
                <p className="px-2 pb-1 text-2xs text-muted-foreground" data-testid="item-assignee-shares">
                  {portalEnabled ? t("assignee.sharesWithClient") : t("assignee.sharesPortalOff")}
                </p>
              )
            : undefined
        }
      >
        {shown.memberId !== null ? (
          <MemberAvatar id={shown.memberId} name={shown.name ?? ""} size="sm" />
        ) : shown.contactId !== null ? (
          <UserRoundIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        ) : null}
        <span
          className={assigned ? "min-w-0 truncate" : "min-w-0 truncate text-muted-foreground"}
          data-value={shown.memberId ?? shown.contactId ?? ""}
        >
          {shown.name ?? t("assignee.none")}
        </span>
      </PropertyPicker>
      {status}
    </>
  );
}
