"use client";

import {
  ChevronDownIcon,
  LogOutIcon,
  MailXIcon,
  ShieldOffIcon,
  UserRoundCheckIcon,
  UserRoundXIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useState, useTransition } from "react";
import { toast } from "sonner";

import { Callout, FormMessage, RowActions, type RowAction } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import { afterClosingLayers } from "@/lib/after-closing-layers";

import {
  resetMemberTwoFactorAction,
  revokeInviteAction,
  setMemberRolesAction,
  setMemberStatusAction,
  signOutMemberEverywhereAction,
  type AdminFormState,
} from "./actions";

type RoleOption = { id: string; name: string };

/** Toast the result of an admin mutation, then refresh the route. */
const useAdmin = () => {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<AdminFormState>) =>
    start(async () => {
      const r = await fn();
      if (r) {
        if (r.ok) toast.success(r.message);
        else toast.error(r.message);
      }
      router.refresh();
    });
  return { pending, run };
};

/**
 * Roles, as a cluster of outline badges rather than a grid of
 * checkboxes in every row: a members table is read a hundred times for
 * every time it is edited, and the checkbox grid made the 36px rhythm
 * impossible.
 *
 * The badges ARE the trigger (founder mandate 1, the InlineEdit
 * pattern): the value is what you click, not a pencil parked beside it.
 * Same box as the control it opens — transparent border until hover,
 * the standard outline ring on focus — and the same form, the same
 * action, the same save button inside the popover.
 */
export function MemberRolesForm({
  memberId,
  memberName,
  roles,
  heldRoleIds,
  canManage,
}: {
  memberId: string;
  memberName: string;
  roles: RoleOption[];
  heldRoleIds: string[];
  canManage: boolean;
}) {
  const t = useTranslations("members.roles");
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    setMemberRolesAction,
    null,
  );
  const held = new Set(heldRoleIds);
  const heldRoles = roles.filter((r) => held.has(r.id));

  const badges =
    heldRoles.length === 0 ? (
      <span className="text-muted-foreground">{t("none")}</span>
    ) : (
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {heldRoles.map((r) => (
          <Badge key={r.id} variant="outline">
            {r.name}
          </Badge>
        ))}
      </span>
    );

  if (!canManage) return badges;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          // The InlineEdit PATTERN, not the component (there is no single
          // field here), so it does not borrow its data-slot.
          data-slot="roles-trigger"
          aria-label={t("edit", { name: memberName })}
          className="group/roles flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md border border-transparent bg-transparent bg-clip-padding px-2.5 py-0.5 text-left text-sm text-foreground transition-[background-color,border-color] duration-(--dur-instant) ease-out hover:border-input hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {badges}
          <ChevronDownIcon
            aria-hidden="true"
            className="invisible ml-auto size-3 shrink-0 text-muted-foreground group-hover/roles:visible group-focus-visible/roles:visible"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <PopoverHeader>
          <PopoverTitle>{t("title")}</PopoverTitle>
        </PopoverHeader>
        <form action={action} className="flex flex-col gap-3">
          <input type="hidden" name="memberId" value={memberId} />
          <fieldset disabled={pending} className="flex flex-col gap-2">
            {roles.map((r) => (
              <Label key={r.id} className="flex items-center gap-2 font-normal">
                <Checkbox
                  name="roleIds"
                  value={r.id}
                  defaultChecked={held.has(r.id)}
                  disabled={pending}
                />
                {r.name}
              </Label>
            ))}
          </fieldset>
          <div className="flex flex-col gap-2">
            <Button type="submit" size="sm" disabled={pending} className="self-start">
              {pending ? t("saving") : t("save")}
            </Button>
            <FormMessage state={state} className="text-xs" />
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One member row's menu: Suspend / Reactivate (member:remove), and —
 * since slice 84 (C50) — an owner's "Sign out everywhere" and "Reset
 * two-factor…" (member:reset_two_factor ✦).
 *
 * Suspending was a solid `--destructive` fill on every row while
 * "Revoke", one card below, was a neutral outline — weight was not
 * carrying severity. Both are menu items now, and the destructive one
 * asks its question in the row before it acts (UI.md §5.9).
 *
 * Your own row carries no control at all: each verb here refuses you —
 * your own sign-in is `/account`'s — and a button that can never act is
 * noise on every render. The "(you)" marker beside the name is what says
 * why. A console principal's row offers neither security verb: that
 * sign-in is the operator's.
 *
 * THE RESET ASKS IN A DIALOG, not in the row: its question is the one
 * thing the owner must do BEFORE answering — check who is asking by phone
 * or in person — and that does not fit a row. The menu item itself is
 * plain (a `confirm` on it would be dead string — AGENTS.md's trap); the
 * dialog's destructive button is the confirmation. It opens after the
 * menu has gone (`afterClosingLayers`), and returns focus through
 * `useFocusReturn`, since it has no trigger of its own.
 */
export function MemberRowActions({
  memberId,
  memberName,
  status,
  isSelf,
  canRemove,
  canSecure,
  console: isConsole,
  enrolled,
}: {
  memberId: string;
  memberName: string;
  status: "ACTIVE" | "SUSPENDED";
  isSelf: boolean;
  canRemove: boolean;
  /** Holds member:reset_two_factor, now or after a step-up. */
  canSecure: boolean;
  /** The teammate is a console principal (has a platform role). */
  console: boolean;
  /** The teammate has a second factor to reset. */
  enrolled: boolean;
}) {
  const t = useTranslations("members.status");
  const tSecurity = useTranslations("members.security");
  const tCommon = useTranslations("common");
  const { pending, run } = useAdmin();
  const [resetOpen, setResetOpen] = useState(false);
  const focusReturn = useFocusReturn();

  if (isSelf) return null;

  const submit = (op: "suspend" | "reactivate") =>
    run(() => {
      const fd = new FormData();
      fd.set("memberId", memberId);
      fd.set("op", op);
      return setMemberStatusAction(null, fd);
    });

  const security = canSecure && !isConsole;
  const items: RowAction[] = [
    ...(security
      ? [
          {
            key: "sign-out",
            label: tSecurity("signOut"),
            icon: LogOutIcon,
            tone: "danger" as const,
            confirm: tSecurity("signOutConfirm", { name: memberName }),
            onSelect: () => run(() => signOutMemberEverywhereAction(memberId)),
          },
        ]
      : []),
    ...(security && enrolled
      ? [
          {
            key: "reset-two-factor",
            label: tSecurity("reset"),
            icon: ShieldOffIcon,
            onSelect: () => afterClosingLayers(() => setResetOpen(true)),
          },
        ]
      : []),
    ...(canRemove
      ? [
          status === "ACTIVE"
            ? {
                key: "suspend",
                label: t("suspend"),
                icon: UserRoundXIcon,
                tone: "danger" as const,
                confirm: t("suspendConfirm", { name: memberName }),
                onSelect: () => submit("suspend"),
              }
            : {
                key: "reactivate",
                label: t("reactivate"),
                icon: UserRoundCheckIcon,
                onSelect: () => submit("reactivate"),
              },
        ]
      : []),
  ];

  if (items.length === 0) return null;

  return (
    <>
      <RowActions label={tCommon("actionsFor", { name: memberName })} items={items} />
      <Dialog open={resetOpen} onOpenChange={(next) => (!next ? setResetOpen(false) : undefined)}>
        <DialogContent {...focusReturn} className="sm:max-w-md" data-testid="reset-two-factor-dialog">
          <DialogHeader>
            <DialogTitle>{tSecurity("resetTitle", { name: memberName })}</DialogTitle>
            <DialogDescription>{tSecurity("resetDescription")}</DialogDescription>
          </DialogHeader>
          <Callout tone="caution" title={tSecurity("checkTitle")}>
            {tSecurity("checkBody", { name: memberName })}
          </Callout>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{tSecurity("effectFactor")}</li>
            <li>{tSecurity("effectSessions")}</li>
            <li>{tSecurity("effectPassword")}</li>
          </ul>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setResetOpen(false)} disabled={pending}>
              {tCommon("cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => {
                setResetOpen(false);
                run(() => resetMemberTwoFactorAction(memberId));
              }}
            >
              {tSecurity("resetConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Revoke one pending invitation (member:invite) — a danger menu item with a question. */
export function RevokeInviteForm({ inviteId, email }: { inviteId: string; email: string }) {
  const t = useTranslations("members.pending");
  const tCommon = useTranslations("common");
  const { run } = useAdmin();
  return (
    <RowActions
      label={tCommon("actionsFor", { name: email })}
      items={[
        {
          key: "revoke",
          label: t("revoke"),
          icon: MailXIcon,
          tone: "danger",
          confirm: t("revokeConfirm", { email }),
          onSelect: () =>
            run(() => {
              const fd = new FormData();
              fd.set("inviteId", inviteId);
              return revokeInviteAction(null, fd);
            }),
        },
      ]}
    />
  );
}
