"use client";

import { useActionState } from "react";

import {
  revokeInviteAction,
  setMemberRolesAction,
  setMemberStatusAction,
  type AdminFormState,
} from "./actions";

type RoleOption = { id: string; name: string };

const Message = ({ state }: { state: AdminFormState }) =>
  state ? (
    <p className={`text-xs ${state.ok ? "text-green-700" : "text-red-600"}`}>{state.message}</p>
  ) : null;

/** Roles editor for one member: checkboxes of tenant roles, saved as a set. */
export function MemberRolesForm({
  memberId,
  roles,
  heldRoleIds,
  canManage,
}: {
  memberId: string;
  roles: RoleOption[];
  heldRoleIds: string[];
  canManage: boolean;
}) {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    setMemberRolesAction,
    null,
  );
  const held = new Set(heldRoleIds);
  return (
    <form action={action} className="mt-2 flex flex-col gap-2">
      <input type="hidden" name="memberId" value={memberId} />
      <fieldset disabled={!canManage || pending} className="flex flex-wrap gap-3 text-sm">
        {roles.map((r) => (
          <label key={r.id} className="flex items-center gap-1">
            <input type="checkbox" name="roleIds" value={r.id} defaultChecked={held.has(r.id)} />
            {r.name}
          </label>
        ))}
      </fieldset>
      {canManage ? (
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save roles"}
          </button>
          <Message state={state} />
        </div>
      ) : null}
    </form>
  );
}

/** Suspend / Reactivate for one member (member:remove). */
export function MemberStatusForm({
  memberId,
  status,
  isSelf,
}: {
  memberId: string;
  status: "ACTIVE" | "SUSPENDED";
  isSelf: boolean;
}) {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    setMemberStatusAction,
    null,
  );
  const suspend = status === "ACTIVE";
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="memberId" value={memberId} />
      <input type="hidden" name="op" value={suspend ? "suspend" : "reactivate"} />
      <button
        type="submit"
        disabled={pending || (suspend && isSelf)}
        title={suspend && isSelf ? "You cannot suspend yourself" : undefined}
        className={`rounded border px-3 py-1 text-xs disabled:opacity-50 ${
          suspend
            ? "border-red-300 text-red-700 hover:bg-red-50"
            : "border-green-300 text-green-700 hover:bg-green-50"
        }`}
      >
        {pending ? "…" : suspend ? "Suspend" : "Reactivate"}
      </button>
      <Message state={state} />
    </form>
  );
}

/** Revoke button for one pending invitation (member:invite). */
export function RevokeInviteForm({ inviteId }: { inviteId: string }) {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    revokeInviteAction,
    null,
  );
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="inviteId" value={inviteId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-50 disabled:opacity-50"
      >
        {pending ? "…" : "Revoke"}
      </button>
      <Message state={state} />
    </form>
  );
}
