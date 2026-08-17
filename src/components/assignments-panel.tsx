"use client";

import { UserMinusIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { EmptyState, MemberAvatar, RowActions } from "@/components/semantic";
import { NativeSelect } from "@/components/ui/native-select";

export type AssignmentRow = { memberId: string; name: string; email: string };
export type AssignableMember = { memberId: string; name: string; email: string };
export type AssignmentActionResult = { ok: boolean; message: string };

/**
 * Team panel shared by client and project pages: who is assigned, with
 * assign/unassign for holders of the manage_assignments permission.
 * Deliberately shows nothing but names (UI.md rule 14: no presence,
 * time or activity). Actions arrive as props so the same panel serves
 * both resources. Every person wears the same MemberAvatar as on
 * /members and /clients, so the same colleague is recognisable by the
 * same mark on every screen.
 *
 * The picker IS the empty state's action (§5.8: one verb, one sentence,
 * one primary action). It used to sit 60px BELOW the "No one assigned
 * yet" sign-post beside a permanently disabled "Assign" button — an
 * empty state with no action and an action with no empty state. It
 * commits on change, like every other auto-saving control here (§5.10),
 * which is what removes the disabled button rather than hiding it.
 *
 * Unassigning is a row action, not a red button per row: it lives in
 * the row's `⋯` menu behind the question (FOUNDER MANDATE 2, §5.9).
 */
export function AssignmentsPanel({
  assigned,
  members,
  canManage,
  assign,
  unassign,
  emptyTitle,
  emptyDescription,
}: {
  assigned: AssignmentRow[];
  members: AssignableMember[];
  canManage: boolean;
  assign: (memberId: string) => Promise<AssignmentActionResult>;
  unassign: (memberId: string) => Promise<AssignmentActionResult>;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const t = useTranslations("assignments");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const assignedIds = new Set(assigned.map((a) => a.memberId));
  const candidates = members.filter((m) => !assignedIds.has(m.memberId));

  const run = (fn: () => Promise<AssignmentActionResult>) =>
    startTransition(async () => {
      const r = await fn();
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      router.refresh();
    });

  // Committing on change is what lets the disabled submit button go.
  // The value is pinned to "" so the control snaps back to its prompt
  // after each assignment and never claims to be a current selection.
  const picker =
    canManage && candidates.length > 0 ? (
      <NativeSelect
        aria-label={t("pick")}
        value=""
        onChange={(e) => {
          const chosen = e.target.value;
          if (chosen) run(() => assign(chosen));
        }}
        className="w-64 max-w-full"
        disabled={pending}
      >
        <option value="">{t("pick")}</option>
        {candidates.map((m) => (
          <option key={m.memberId} value={m.memberId}>
            {m.name}
          </option>
        ))}
      </NativeSelect>
    ) : null;

  if (assigned.length === 0) {
    // No verb to offer is a `forbidden` state, not an `empty` one with a
    // dangling sentence: the two say different things and need different
    // next actions.
    return picker ? (
      <EmptyState
        variant="empty"
        icon={UserPlusIcon}
        title={emptyTitle}
        body={emptyDescription}
        action={picker}
      />
    ) : (
      <EmptyState variant="forbidden" icon={UsersIcon} title={emptyTitle} body={t("emptyForbidden")} />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="divide-y divide-border rounded-md border border-border">
        {assigned.map((a) => (
          <li
            key={a.memberId}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-sm"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <MemberAvatar id={a.memberId} name={a.name} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{a.name}</span>
                <span className="truncate text-xs text-muted-foreground">{a.email}</span>
              </span>
            </span>
            {canManage ? (
              <RowActions
                label={tCommon("actionsFor", { name: a.name })}
                items={[
                  {
                    key: "unassign",
                    label: t("unassign"),
                    icon: UserMinusIcon,
                    tone: "danger",
                    confirm: t("unassignConfirm"),
                    onSelect: () => run(() => unassign(a.memberId)),
                  },
                ]}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {picker}
    </div>
  );
}
