"use client";

import { useActionState } from "react";

import {
  createRoleAction,
  deleteRoleAction,
  setRolePermissionsAction,
  type RoleFormState,
} from "./actions";

export type PermissionGroup = {
  module: string;
  permissions: { code: string; description: string; requiresMfa: boolean }[];
};

const Message = ({ state }: { state: RoleFormState }) =>
  state ? (
    <p className={`text-xs ${state.ok ? "text-green-700" : "text-red-600"}`}>{state.message}</p>
  ) : null;

/**
 * One role's permission matrix, grouped by module. System roles render
 * read-only; custom roles are editable when the viewer holds role:edit
 * (a stale factor is resolved by the step-up redirect on save).
 */
export function RolePermissionsForm({
  role,
  groups,
  canEdit,
}: {
  role: {
    id: string;
    isSystem: boolean;
    codes: string[];
    revokedCodes: string[];
  };
  groups: PermissionGroup[];
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState<RoleFormState, FormData>(
    setRolePermissionsAction,
    null,
  );
  const held = new Set(role.codes);
  const revoked = new Set(role.revokedCodes);
  const editable = canEdit && !role.isSystem;

  return (
    <form action={action} className="mt-3 flex flex-col gap-3">
      <input type="hidden" name="roleId" value={role.id} />
      <fieldset disabled={!editable || pending} className="grid gap-3 sm:grid-cols-2">
        {groups.map((g) => (
          <div key={g.module} className="rounded border border-neutral-100 p-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {g.module.replace("_", " ")}
            </p>
            <ul className="mt-1 flex flex-col gap-0.5 text-sm">
              {g.permissions.map((p) => (
                <li key={p.code}>
                  <label className="flex items-start gap-2" title={p.description}>
                    <input
                      type="checkbox"
                      name="codes"
                      value={p.code}
                      defaultChecked={held.has(p.code)}
                      className="mt-0.5"
                    />
                    <span className={held.has(p.code) ? "" : "text-neutral-500"}>
                      {p.code}
                      {p.requiresMfa ? <span title="requires MFA"> ✦</span> : null}
                      {revoked.has(p.code) ? (
                        <span className="ml-1 text-xs text-amber-700">(removed from template)</span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </fieldset>
      {editable ? (
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save permissions"}
          </button>
          <Message state={state} />
        </div>
      ) : null}
    </form>
  );
}

export function DeleteRoleForm({ roleId, name }: { roleId: string; name: string }) {
  const [state, action, pending] = useActionState<RoleFormState, FormData>(
    deleteRoleAction,
    null,
  );
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="roleId" value={roleId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
      >
        {pending ? "…" : `Delete "${name}"`}
      </button>
      <Message state={state} />
    </form>
  );
}

export function CreateRoleForm({
  templates,
}: {
  templates: { templateKey: string; displayName: string }[];
}) {
  const [state, action, pending] = useActionState<RoleFormState, FormData>(
    createRoleAction,
    null,
  );
  return (
    <form action={action} className="mt-3 flex max-w-md flex-col gap-3">
      <input
        type="text"
        name="name"
        required
        minLength={2}
        maxLength={60}
        placeholder="Role name"
        className="rounded border border-neutral-300 px-3 py-2"
      />
      <input
        type="text"
        name="description"
        maxLength={200}
        placeholder="Description (optional)"
        className="rounded border border-neutral-300 px-3 py-2"
      />
      <label className="flex flex-col gap-1 text-sm">
        <span>Start from</span>
        <select name="templateKey" defaultValue="" className="rounded border border-neutral-300 px-3 py-2">
          <option value="">Blank (no permissions)</option>
          {templates.map((t) => (
            <option key={t.templateKey} value={t.templateKey}>
              Clone {t.displayName} (without ✦ permissions)
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create role"}
      </button>
      <Message state={state} />
    </form>
  );
}
